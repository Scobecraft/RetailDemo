"""Druckaufträge für den 3D-Drucker (Reiter "3D-Drucker" → "Drucken").

Ablauf:
  1. Auf der Webseite wird ein Modell (STL, 3MF, OBJ) oder fertiger G-Code hochgeladen.
  2. Modelle slict der Server mit PrusaSlicer (Kommandozeile) und dem Profil slicer/adventurer5m.ini.
  3. "Drucken" stellt den Auftrag bereit. Die Druckmonitor-App am PC beim Drucker erfährt das in der
     Antwort auf ihre Übertragung, lädt den G-Code und schickt ihn über das Heimnetz an den Drucker.
     Den Fortschritt meldet sie zurück.
Der Server muss den Drucker dafür nicht erreichen können.
"""
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

SLICER = os.environ.get("PRUSA_SLICER", "prusa-slicer")
PROFILE = Path(__file__).parent / "slicer" / "adventurer5m.ini"
MATERIALS = json.loads((Path(__file__).parent / "slicer" / "materials.json").read_text())
QUALITIES = {"fein": 0.12, "standard": 0.2, "schnell": 0.28}
MODEL_EXT = {".stl", ".3mf", ".obj"}
GCODE_EXT = {".gcode", ".gco", ".g", ".gx"}
# So lange darf ein bereitgestellter Auftrag auf die Druckmonitor-App warten
PICKUP_TIMEOUT_S = 180
# Druck nur starten, wenn der Drucker gerade nichts tut
IDLE_STATES = {"idle", "done"}


class SliceOptions(BaseModel):
    material: str = "PLA"
    quality: str = "standard"
    infill: int = 15
    supports: bool = False
    brim: bool = True


class PrintRequest(BaseModel):
    leveling: bool = True


class JobStatus(BaseModel):
    state: str  # sending, printing, error
    message: str = ""


def _clean_options(o: SliceOptions) -> dict:
    return {
        "material": o.material if o.material in MATERIALS else "PLA",
        "quality": o.quality if o.quality in QUALITIES else "standard",
        "infill": max(0, min(100, int(o.infill))),
        "supports": bool(o.supports),
        "brim": bool(o.brim),
    }


def _parse_gcode_stats(path: Path) -> dict:
    """Druckzeit, Filament und Schichten aus den Kommentaren (PrusaSlicer, OrcaSlicer, Flash Studio, Cura)."""
    stats = {}
    size = path.stat().st_size
    with open(path, "rb") as f:
        head = f.read(200_000).decode("utf-8", "ignore")
        if size > 400_000:
            f.seek(size - 200_000)
        tail = f.read().decode("utf-8", "ignore")
    text = head + "\n" + tail

    def dur(s: str) -> Optional[int]:
        parts = dict((u, int(v)) for v, u in re.findall(r"(\d+)\s*([dhms])", s))
        total = parts.get("d", 0) * 86400 + parts.get("h", 0) * 3600 + parts.get("m", 0) * 60 + parts.get("s", 0)
        return total or None

    if m := re.search(r"estimated printing time(?: \(normal mode\))?\s*=\s*([^\n]+)", text):
        stats["time_s"] = dur(m.group(1))
    elif m := re.search(r";\s*model printing time:\s*([^;\n]+)", text):  # Orca/Bambu
        stats["time_s"] = dur(m.group(1))
    elif m := re.search(r";TIME:(\d+)", text):  # Cura
        stats["time_s"] = int(m.group(1))
    elif m := re.search(r";\s*estimated_time\s*\(s\)\s*[:=]\s*(\d+)", text, re.I):
        stats["time_s"] = int(m.group(1))
    if m := re.search(r"total filament used \[g\]\s*=\s*([\d.]+)", text) or re.search(r"filament used \[g\]\s*=\s*([\d.]+)", text):
        stats["filament_g"] = round(float(m.group(1)), 1) or None
    if m := re.search(r"filament used \[mm\]\s*=\s*([\d.]+)", text):
        stats["filament_m"] = round(float(m.group(1)) / 1000, 2)
    elif m := re.search(r";Filament used:\s*([\d.]+)m", text):
        stats["filament_m"] = round(float(m.group(1)), 2)
    if m := re.search(r";\s*total layer number:\s*(\d+)", text) or re.search(r";LAYER_COUNT:(\d+)", text):
        stats["layers"] = int(m.group(1))
    else:  # PrusaSlicer-Profil schreibt ";Z:<Höhe>" vor jede Schicht
        with open(path, "rb") as f:
            n = sum(1 for line in f if line.startswith(b";Z:"))
        if n:
            stats["layers"] = n
    return {k: v for k, v in stats.items() if v}


def make_jobs_router(data_dir: Path, require_device: Callable, require_viewer: Callable, printer_state: Callable[[], dict]):
    jobs_dir = data_dir / "druck" / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    lock = threading.RLock()
    slice_sem = threading.Semaphore(1)  # immer nur ein Slicer gleichzeitig
    r = APIRouter()

    def load(job_id: str) -> dict:
        if not re.fullmatch(r"[0-9a-f]{32}", job_id or ""):
            raise HTTPException(404, "Auftrag unbekannt")
        try:
            return json.loads((jobs_dir / job_id / "job.json").read_text())
        except (OSError, ValueError):
            raise HTTPException(404, "Auftrag unbekannt")

    def save(job: dict):
        p = jobs_dir / job["id"] / "job.json"
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(job))
        tmp.replace(p)

    def all_jobs() -> list[dict]:
        out = []
        for d in jobs_dir.iterdir():
            try:
                out.append(json.loads((d / "job.json").read_text()))
            except (OSError, ValueError):
                continue
        return sorted(out, key=lambda j: j["created"], reverse=True)

    def expire_queued():
        """Holt die Druckmonitor-App einen Auftrag nicht ab, ihn wieder freigeben (nie still hängen lassen)."""
        with lock:
            for j in all_jobs():
                if j["state"] == "queued" and time.time() - j.get("queued_at", 0) > PICKUP_TIMEOUT_S:
                    j.update(state="ready", message="Die Druckmonitor-App hat den Auftrag nicht abgeholt (läuft sie?).")
                    save(j)

    def run_slicer(job_id: str):
        with slice_sem:
            with lock:
                job = load(job_id)
                job.update(state="slicing", message="")
                save(job)
            d = jobs_dir / job_id
            o = job["options"]
            mat = MATERIALS[o["material"]]
            out = d / "druck.gcode"
            cmd = [SLICER, "--export-gcode", "--load", str(PROFILE),
                   "--layer-height", str(QUALITIES[o["quality"]]),
                   "--fill-density", f"{o['infill']}%",
                   "--temperature", str(mat["temperature"]), "--first-layer-temperature", str(mat["first_layer_temperature"]),
                   "--bed-temperature", str(mat["bed_temperature"]), "--first-layer-bed-temperature", str(mat["first_layer_bed_temperature"]),
                   "--filament-density", str(mat["filament_density"]), "--filament-type", mat["name"],
                   "--max-fan-speed", str(mat["fan"]), "--min-fan-speed", str(mat["fan"]),
                   "--filament-max-volumetric-speed", str(mat["max_volumetric_speed"]),
                   "--brim-width", "5" if o["brim"] else "0",
                   "--center", "0,0", "--ensure-on-bed",
                   "--output", str(out), str(d / job["source"])]
            if o["supports"]:
                cmd[3:3] = ["--support-material", "--support-material-auto"]
            try:
                res = subprocess.run(cmd, capture_output=True, text=True, timeout=900,
                                     env={**os.environ, "HOME": str(d), "XDG_CONFIG_HOME": str(d / ".config")})
                ok = res.returncode == 0 and out.exists() and out.stat().st_size > 0
                err = "" if ok else _slicer_error(res.stdout + "\n" + res.stderr)
            except FileNotFoundError:
                ok, err = False, "Slicer (PrusaSlicer) ist auf dem Server nicht installiert – Server neu bauen."
            except subprocess.TimeoutExpired:
                ok, err = False, "Slicen hat zu lange gedauert (über 15 Minuten)."
            with lock:
                job = load(job_id)
                if ok:
                    job.update(state="ready", gcode="druck.gcode", size=out.stat().st_size,
                               stats=_parse_gcode_stats(out), message="", sliced_at=time.time())
                else:
                    job.update(state="failed", message=err)
                save(job)

    def register_upload(tmp: Path, filename: str, options: dict) -> dict:
        """Vom Upload in Stücken aufgerufen: Auftrag anlegen und (bei Modellen) slicen."""
        name = Path(filename).name
        low = name.lower()
        ext = ".3mf" if low.endswith(".gcode.3mf") else Path(low).suffix
        if ext not in MODEL_EXT | GCODE_EXT:
            tmp.unlink(missing_ok=True)
            raise HTTPException(400, "Bitte eine STL-, 3MF-, OBJ- oder G-Code-Datei hochladen")
        job_id = uuid.uuid4().hex
        d = jobs_dir / job_id
        d.mkdir()
        source = "modell" + ext
        shutil.move(str(tmp), d / source)
        title = re.sub(r"\.(gcode\.3mf|stl|3mf|obj|gcode|gco|g|gx)$", "", name, flags=re.I) or "Druck"
        job = {"id": job_id, "name": title[:120], "file_name": name, "source": source, "created": time.time(),
               "options": _clean_options(SliceOptions(**(options or {}))), "stats": {}, "message": ""}
        if ext in GCODE_EXT or low.endswith(".gcode.3mf"):
            if low.endswith(".gcode.3mf"):
                shutil.rmtree(d)
                raise HTTPException(400, "Geslicte 3MF-Dateien bitte als .gcode exportieren")
            job.update(state="ready", gcode=source, size=(d / source).stat().st_size, sliced_by_user=True,
                       stats=_parse_gcode_stats(d / source))
            save(job)
        else:
            job["state"] = "slicing"
            save(job)
            threading.Thread(target=run_slicer, args=(job_id,), daemon=True).start()
        return job

    # ------------------------------------------------ Webseite

    @r.get("/api/admin/druck/jobs", dependencies=[Depends(require_viewer)])
    def list_jobs():
        expire_queued()
        p = printer_state()
        return {"jobs": all_jobs()[:50], "materials": {k: {"name": v["name"], "enclosure": v.get("enclosure", False)} for k, v in MATERIALS.items()},
                "qualities": QUALITIES, "printer": p}

    @r.post("/api/admin/druck/jobs/{job_id}/slice", dependencies=[Depends(require_viewer)])
    def reslice(job_id: str, body: SliceOptions):
        with lock:
            job = load(job_id)
            if job.get("sliced_by_user"):
                raise HTTPException(400, "Fertiger G-Code wird nicht neu geslict")
            if job["state"] in ("slicing", "queued", "sending"):
                raise HTTPException(409, "Gerade beschäftigt")
            job.update(options=_clean_options(body), state="slicing", message="", stats={})
            save(job)
        threading.Thread(target=run_slicer, args=(job_id,), daemon=True).start()
        return job

    @r.post("/api/admin/druck/jobs/{job_id}/print", dependencies=[Depends(require_viewer)])
    def print_job(job_id: str, body: PrintRequest):
        expire_queued()
        p = printer_state()
        if not p.get("online"):
            raise HTTPException(409, "Die Druckmonitor-App ist nicht verbunden")
        if p.get("state") not in IDLE_STATES:
            raise HTTPException(409, f"Der Drucker ist gerade nicht bereit ({p.get('status') or p.get('state') or 'unbekannt'})")
        with lock:
            busy = [j for j in all_jobs() if j["state"] in ("queued", "sending")]
            if busy:
                raise HTTPException(409, f"„{busy[0]['name']}“ wird gerade schon an den Drucker geschickt")
            job = load(job_id)
            if job["state"] not in ("ready", "error", "printing", "done"):
                raise HTTPException(409, "Der Auftrag ist noch nicht fertig geslict")
            job.update(state="queued", queued_at=time.time(), leveling=body.leveling, message="Wartet auf die Druckmonitor-App …")
            save(job)
        return job

    @r.post("/api/admin/druck/jobs/{job_id}/cancel", dependencies=[Depends(require_viewer)])
    def cancel_job(job_id: str):
        with lock:
            job = load(job_id)
            if job["state"] != "queued":
                raise HTTPException(409, "Nur wartende Aufträge lassen sich zurückholen")
            job.update(state="ready", message="Zurückgeholt")
            save(job)
        return job

    @r.delete("/api/admin/druck/jobs/{job_id}", dependencies=[Depends(require_viewer)])
    def delete_job(job_id: str):
        with lock:
            job = load(job_id)
            if job["state"] in ("slicing", "queued", "sending"):
                raise HTTPException(409, "Gerade beschäftigt – bitte kurz warten")
            shutil.rmtree(jobs_dir / job["id"], ignore_errors=True)
        return {"ok": True}

    @r.get("/api/admin/druck/jobs/{job_id}/preview/{kind}", dependencies=[Depends(require_viewer)])
    def job_file(job_id: str, kind: str):
        """Für die 3D-Vorschau: das Modell (source) oder den G-Code (gcode)."""
        job = load(job_id)
        f = job.get("gcode") if kind == "gcode" else job.get("source") if kind == "source" else None
        if not f or not (jobs_dir / job_id / f).exists():
            raise HTTPException(404, "Nicht vorhanden")
        name = job["name"] + (".gcode" if kind == "gcode" else Path(job["source"]).suffix)
        from urllib.parse import quote
        return FileResponse(jobs_dir / job_id / f, headers={"X-Model-Name": quote(name), "Cache-Control": "no-store"})

    # ------------------------------------------------ Druckmonitor-App

    def pending_for_app() -> Optional[dict]:
        """Auftrag, den die App jetzt abholen soll (in der Antwort auf POST /api/druck/state)."""
        expire_queued()
        for j in all_jobs():
            if j["state"] == "queued":
                return {"id": j["id"], "name": j["name"], "size": j.get("size", 0),
                        "url": f"/api/druck/jobs/{j['id']}/file", "leveling": j.get("leveling", True)}
        return None

    @r.get("/api/druck/jobs/{job_id}/file", dependencies=[Depends(require_device)])
    def device_job_file(job_id: str):
        job = load(job_id)
        if not job.get("gcode"):
            raise HTTPException(404, "Kein G-Code")
        return FileResponse(jobs_dir / job_id / job["gcode"], media_type="text/x-gcode")

    @r.post("/api/druck/jobs/{job_id}/status", dependencies=[Depends(require_device)])
    def device_job_status(job_id: str, body: JobStatus):
        with lock:
            job = load(job_id)
            if body.state not in ("sending", "printing", "error"):
                raise HTTPException(400, "Unbekannter Zustand")
            job.update(state=body.state, message=body.message[:300], updated=time.time())
            if body.state == "printing":
                job["printed_at"] = time.time()
            save(job)
        return {"ok": True}

    return r, register_upload, pending_for_app


def _slicer_error(out: str) -> str:
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    for pat in ("outside", "außerhalb", "exceed", "empty", "Error", "error", "failed", "Failed"):
        for l in lines:
            if pat in l:
                if "outside" in l or "exceed" in l:
                    return "Das Modell passt nicht auf das Druckbett (max. 220 × 220 × 220 mm)."
                return l[:300]
    return (lines[-1] if lines else "Slicen fehlgeschlagen")[:300]
