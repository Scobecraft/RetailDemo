"""Druckaufträge für den 3D-Drucker (Reiter "3D-Drucker" → "Drucken").

Ablauf:
  1. Auf der Webseite wird ein Modell (STL, 3MF, OBJ) oder fertiger G-Code hochgeladen.
  2. Modelle slict der Server mit PrusaSlicer (Kommandozeile) und dem Profil slicer/adventurer5m.ini.
  3. "Drucken" stellt den Auftrag bereit. Die Druckmonitor-App am PC beim Drucker erfährt das in der
     Antwort auf ihre Übertragung, lädt den G-Code und schickt ihn über das Heimnetz an den Drucker.
     Den Fortschritt meldet sie zurück.
Der Server muss den Drucker dafür nicht erreichen können.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import tempfile
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .slicer import schema

SLICER = os.environ.get("PRUSA_SLICER", "prusa-slicer")
PROFILE = Path(__file__).parent / "slicer" / "adventurer5m.ini"
MATERIALS = json.loads((Path(__file__).parent / "slicer" / "materials.json").read_text())
QUALITIES = {"fein": 0.12, "standard": 0.2, "schnell": 0.28}
MODEL_EXT = {".stl", ".3mf", ".obj"}
GCODE_EXT = {".gcode", ".gco", ".g", ".gx"}
# So lange darf ein bereitgestellter Auftrag auf die Druckmonitor-App warten
PICKUP_TIMEOUT_S = 180
TV_API = os.environ.get("THINGIVERSE_API", "https://api.thingiverse.com")  # änderbar für Tests
TV_BLOCKED = ("Thingiverse lässt die Abfrage vom Server gerade nicht zu (Schutzseite). Lade die Dateien auf "
              "Thingiverse mit „Download All Files“ herunter und ziehe die ZIP-Datei hier hinein.")
# Druck nur starten, wenn der Drucker gerade nichts tut
IDLE_STATES = {"idle", "done"}


class SliceOptions(BaseModel):
    values: dict = {}


BED_HALF, MAX_Z = 110.0, 220.0
_full_profile: Optional[dict] = None
_full_lock = threading.Lock()


def full_profile() -> dict:
    """Vollständige Konfiguration (unser Profil + PrusaSlicer-Standardwerte), einmal ermittelt."""
    global _full_profile
    with _full_lock:
        if _full_profile is None:
            prof = schema.read_ini(PROFILE)
            try:
                tmp = Path(os.environ.get("TMPDIR", "/tmp")) / f"retaildemo-slicer-{os.getpid()}.ini"
                subprocess.run([SLICER, "--load", str(PROFILE), "--save", str(tmp)], capture_output=True, timeout=60)
                if tmp.exists():
                    prof = schema.read_ini(tmp)
                    tmp.unlink(missing_ok=True)
            except (OSError, subprocess.SubprocessError):
                pass
            _full_profile = prof
        return _full_profile


def material_key(name: str) -> str:
    return name if name in MATERIALS else "PLA"


def material_defaults(name: str) -> dict:
    return schema.defaults(full_profile(), MATERIALS[material_key(name)])


def _legacy(o: dict) -> dict:
    """Aufträge aus der ersten Version (material/quality/infill/supports/brim) umrechnen."""
    if "material" not in o and "quality" not in o:
        return o
    v = {"filament_type": o.get("material", "PLA"), "layer_height": QUALITIES.get(o.get("quality"), 0.2),
         "fill_density": o.get("infill", 15), "support_material": bool(o.get("supports")),
         "brim_width": 5 if o.get("brim", True) else 0}
    return v


class PrintRequest(BaseModel):
    leveling: bool = True


class JobStatus(BaseModel):
    state: str  # sending, printing, error
    message: str = ""


def _clean_options(values: dict, base: Optional[dict] = None) -> dict:
    """Alle Werte prüfen: Materialvorlage als Grundlage, darüber gespeicherte Standards, darüber die Eingaben."""
    values = _legacy(values or {})
    mat = material_key(str(values.get("filament_type") or (base or {}).get("filament_type") or "PLA"))
    out = material_defaults(mat)
    for src in (base or {}, values):
        for k, v in src.items():
            if k in schema.BY_KEY and k in out:
                try:
                    out[k] = schema.coerce(schema.BY_KEY[k], v)
                except (ValueError, TypeError):
                    raise HTTPException(400, f"Ungültiger Wert für „{schema.BY_KEY[k]['label']}“")
    if out.get("support_material") is False:
        out["support_material_auto"] = out.get("support_material_auto", True)
    return out


def _check_bounds(path: Path) -> Optional[str]:
    """Liegt jede Bewegung auf dem Druckbett? Sonst nicht drucken (Schutz für den Drucker)."""
    max_x = max_y = max_z = 0.0
    with open(path, "r", errors="ignore") as f:
        for line in f:
            if not line.startswith(("G0", "G1")):
                continue
            for tok in line.split(";", 1)[0].split()[1:]:
                c = tok[:1]
                if c in "XYZ":
                    try:
                        v = float(tok[1:])
                    except ValueError:
                        continue
                    if c == "X":
                        max_x = max(max_x, abs(v))
                    elif c == "Y":
                        max_y = max(max_y, abs(v))
                    elif v > max_z:
                        max_z = v
    if max_x > BED_HALF + 0.01 or max_y > BED_HALF + 0.01:
        return "Das Modell passt nicht auf das Druckbett (220 × 220 mm) – kleiner skalieren oder weniger Kopien."
    if max_z > MAX_Z + 10.01:  # Endfahrt hebt den Kopf um 10 mm
        return "Das Modell ist zu hoch (max. 220 mm)."
    return None


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
        with open(path, "rb") as f:  # verschiedene Höhen zählen (Stützen/Kopien wiederholen ";Z:")
            n = len({line.strip() for line in f if line.startswith(b";Z:")})
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

    def slice_to(job: dict, values: dict, out: Path) -> tuple[bool, str]:
        """Modell des Auftrags mit [values] slicen und nach [out] schreiben; prüft das Ergebnis."""
        d = jobs_dir / job["id"]
        out.unlink(missing_ok=True)
        cmd = [SLICER, "--export-gcode", "--load", str(PROFILE), *schema.cli_args(values, set(full_profile())),
               "--center", "0,0", "--ensure-on-bed", "--output", str(out), str(d / job["source"])]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=900,
                                 env={**os.environ, "HOME": str(d), "XDG_CONFIG_HOME": str(d / ".config")})
            ok = res.returncode == 0 and out.exists() and out.stat().st_size > 0
            err = "" if ok else (_slicer_error(res.stdout + "\n" + res.stderr) if res.returncode > 0 else
                                 "Der Slicer ist bei dieser Einstellungskombination abgestürzt – z. B. Abstand zwischen Kopien erhöhen.")
            if ok and (bad := _check_bounds(out)):
                ok, err = False, bad
        except FileNotFoundError:
            ok, err = False, "Slicer (PrusaSlicer) ist auf dem Server nicht installiert – Server neu bauen."
        except subprocess.TimeoutExpired:
            ok, err = False, "Slicen hat zu lange gedauert (über 15 Minuten)."
        return ok, err

    def options_hash(values: dict) -> str:
        return hashlib.sha1(json.dumps(values, sort_keys=True).encode()).hexdigest()[:16]

    def run_slicer(job_id: str):
        with slice_sem:
            with lock:
                job = load(job_id)
                job.update(state="slicing", message="")
                save(job)
            out = jobs_dir / job_id / "druck.gcode"
            # schon als Live-Vorschau mit genau diesen Einstellungen geslict? Dann nur übernehmen
            cached = jobs_dir / job_id / "live" / f"{options_hash(job['options'])}.gcode"
            if cached.exists():
                shutil.copyfile(cached, out)
                ok, err = True, ""
            else:
                ok, err = slice_to(job, job["options"], out)
            with lock:
                job = load(job_id)
                if ok:
                    job.update(state="ready", gcode="druck.gcode", size=out.stat().st_size,
                               stats=_parse_gcode_stats(out), message="", sliced_at=time.time(),
                               options_hash=options_hash(job["options"]))
                else:
                    job.update(state="failed", message=err)
                save(job)

    def register_zip(tmp: Path, filename: str, options: dict, extra: Optional[dict] = None) -> dict:
        """ZIP (z. B. von Thingiverse heruntergeladen): jedes enthaltene Modell wird ein eigener Auftrag."""
        base = re.sub(r"\.zip$", "", Path(filename).name, flags=re.I)
        jobs = []
        try:
            with zipfile.ZipFile(tmp) as z:
                members = [m for m in z.infolist() if not m.is_dir() and Path(m.filename).suffix.lower() in MODEL_EXT
                           and not Path(m.filename).name.startswith(".") and "__MACOSX" not in m.filename]
                if not members:
                    raise HTTPException(400, "In der ZIP-Datei ist kein Modell (STL, 3MF, OBJ)")
                if len(members) > 30:
                    raise HTTPException(400, "Zu viele Modelle in der ZIP-Datei (max. 30)")
                if sum(m.file_size for m in members) > 1024 ** 3:
                    raise HTTPException(400, "Die Modelle in der ZIP-Datei sind zusammen größer als 1 GB")
                for m in members:
                    with tempfile.NamedTemporaryFile(delete=False, dir=jobs_dir, suffix=".part") as out, z.open(m) as src:
                        shutil.copyfileobj(src, out)
                    part_name = Path(m.filename).name
                    jobs.append(register_upload(Path(out.name), part_name, options, extra=extra,
                                                title_prefix=base if len(members) > 1 else ""))
        except zipfile.BadZipFile:
            raise HTTPException(400, "Die ZIP-Datei ist beschädigt")
        finally:
            tmp.unlink(missing_ok=True)
        return {**jobs[0], "jobs": jobs}

    def register_upload(tmp: Path, filename: str, options: dict, extra: Optional[dict] = None, title_prefix: str = "") -> dict:
        """Vom Upload in Stücken aufgerufen: Auftrag anlegen und (bei Modellen) slicen."""
        name = Path(filename).name
        low = name.lower()
        if low.endswith(".zip"):
            return register_zip(tmp, name, options, extra)
        ext = ".3mf" if low.endswith(".gcode.3mf") else Path(low).suffix
        if ext not in MODEL_EXT | GCODE_EXT:
            tmp.unlink(missing_ok=True)
            raise HTTPException(400, "Bitte eine STL-, 3MF-, OBJ-, ZIP- oder G-Code-Datei hochladen")
        job_id = uuid.uuid4().hex
        d = jobs_dir / job_id
        d.mkdir()
        source = "modell" + ext
        shutil.move(str(tmp), d / source)
        title = re.sub(r"\.(gcode\.3mf|stl|3mf|obj|gcode|gco|g|gx)$", "", name, flags=re.I) or "Druck"
        if title_prefix:
            title = f"{title_prefix} – {title}"
        job = {"id": job_id, "name": title[:120], "file_name": name, "source": source, "created": time.time(),
               "options": _clean_options(options or {}, user_defaults()), "stats": {}, "message": "", **(extra or {})}
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

    defaults_file = data_dir / "druck" / "slicer-defaults.json"

    def user_defaults() -> dict:
        try:
            return json.loads(defaults_file.read_text())
        except (OSError, ValueError):
            return {}

    # ------------------------------------------------ Thingiverse (offizielle API mit App-Token)
    tv_file = data_dir / "druck" / "thingiverse.json"

    def tv_token() -> str:
        try:
            return json.loads(tv_file.read_text()).get("token", "")
        except (OSError, ValueError):
            return os.environ.get("THINGIVERSE_TOKEN", "")

    def tv_get(url: str, raw: bool = False):
        token = tv_token()
        if not token:
            raise HTTPException(409, "Thingiverse ist noch nicht eingerichtet (Zugangsschlüssel fehlt)")
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "User-Agent": "RetailDemo-Slicer/1.0",
                                                   "Accept": "*/*" if raw else "application/json"})
        try:
            resp = urllib.request.urlopen(req, timeout=60)
            if raw:
                return resp  # Aufrufer liest und schließt
            with resp:
                if "json" not in resp.headers.get("Content-Type", ""):
                    raise HTTPException(502, TV_BLOCKED)
                return json.loads(resp.read(5 * 1024 * 1024))
        except urllib.error.HTTPError as e:
            body = e.read(4000).decode("utf-8", "ignore")
            if "Just a moment" in body or "challenge" in body:
                raise HTTPException(502, TV_BLOCKED)
            if e.code == 401:
                raise HTTPException(400, "Der Thingiverse-Zugangsschlüssel ist ungültig")
            if e.code == 404:
                raise HTTPException(404, "Dieses Modell gibt es auf Thingiverse nicht (mehr)")
            raise HTTPException(502, f"Thingiverse antwortet mit Fehler {e.code}")
        except (urllib.error.URLError, TimeoutError) as e:
            raise HTTPException(502, f"Thingiverse nicht erreichbar ({getattr(e, 'reason', e)})")

    class TvToken(BaseModel):
        token: str = ""

    class TvLookup(BaseModel):
        url: str

    class TvImport(BaseModel):
        thing_id: int
        file_ids: list[int]
        values: dict = {}

    @r.get("/api/admin/druck/thingiverse", dependencies=[Depends(require_viewer)])
    def tv_status():
        return {"configured": bool(tv_token())}

    @r.put("/api/admin/druck/thingiverse", dependencies=[Depends(require_viewer)])
    def tv_set_token(body: TvToken):
        token = body.token.strip()
        if token and not re.fullmatch(r"[A-Za-z0-9_\-.]{10,200}", token):
            raise HTTPException(400, "Das sieht nicht wie ein Thingiverse-Schlüssel aus")
        if token:
            tv_file.write_text(json.dumps({"token": token}))
        else:
            tv_file.unlink(missing_ok=True)
        return {"configured": bool(token)}

    @r.post("/api/admin/druck/thingiverse/lookup", dependencies=[Depends(require_viewer)])
    def tv_lookup(body: TvLookup):
        m = re.search(r"thing[:/](\d+)", body.url) or re.fullmatch(r"\s*(\d+)\s*", body.url)
        if not m:
            raise HTTPException(400, "Bitte einen Thingiverse-Link einfügen (z. B. https://www.thingiverse.com/thing:12345)")
        tid = int(m.group(1))
        thing = tv_get(f"{TV_API}/things/{tid}")
        files = tv_get(f"{TV_API}/things/{tid}/files")
        out = []
        for f in files if isinstance(files, list) else []:
            ext = Path(f.get("name", "")).suffix.lower()
            out.append({"id": f.get("id"), "name": f.get("name"), "size": f.get("size"), "ext": ext,
                        "supported": ext in MODEL_EXT | GCODE_EXT, "thumbnail": f.get("thumbnail")})
        return {"id": tid, "name": thing.get("name") or f"Thing {tid}", "url": thing.get("public_url") or f"https://www.thingiverse.com/thing:{tid}",
                "creator": (thing.get("creator") or {}).get("name"), "license": thing.get("license"),
                "thumbnail": thing.get("thumbnail"), "files": out}

    @r.post("/api/admin/druck/thingiverse/import", dependencies=[Depends(require_viewer)])
    def tv_import(body: TvImport):
        if not body.file_ids:
            raise HTTPException(400, "Bitte mindestens eine Datei auswählen")
        if len(body.file_ids) > 30:
            raise HTTPException(400, "Höchstens 30 Dateien auf einmal")
        thing = tv_get(f"{TV_API}/things/{body.thing_id}")
        files = {f.get("id"): f for f in tv_get(f"{TV_API}/things/{body.thing_id}/files")}
        extra = {"origin": {"site": "Thingiverse", "url": thing.get("public_url") or f"https://www.thingiverse.com/thing:{body.thing_id}",
                            "creator": (thing.get("creator") or {}).get("name"), "license": thing.get("license"),
                            "thing": thing.get("name")}}
        jobs = []
        for fid in body.file_ids:
            f = files.get(fid)
            if not f or Path(f.get("name", "")).suffix.lower() not in MODEL_EXT | GCODE_EXT:
                continue
            url = f.get("download_url") or f"{TV_API}/files/{fid}/download"
            resp = tv_get(url, raw=True)
            with tempfile.NamedTemporaryFile(delete=False, dir=jobs_dir, suffix=".part") as out:
                size = 0
                while chunk := resp.read(1024 * 1024):
                    size += len(chunk)
                    if size > 300 * 1024 * 1024:
                        out.close(); Path(out.name).unlink(missing_ok=True)
                        raise HTTPException(400, f"„{f.get('name')}“ ist zu groß (über 300 MB)")
                    out.write(chunk)
            resp.close()
            if size < 84 or Path(out.name).read_bytes()[:15].lower().startswith(b"<!doctype html"):
                Path(out.name).unlink(missing_ok=True)
                raise HTTPException(502, TV_BLOCKED)
            jobs.append(register_upload(Path(out.name), f["name"], body.values, extra=extra,
                                        title_prefix=(thing.get("name") or "")[:60] if len(body.file_ids) > 1 else ""))
        if not jobs:
            raise HTTPException(400, "Keine der gewählten Dateien lässt sich slicen")
        return {"jobs": jobs}

    # ------------------------------------------------ Webseite

    @r.get("/api/admin/druck/slicer", dependencies=[Depends(require_viewer)])
    def slicer_schema():
        """Alles für das Einstellungsformular: Felder, Bereiche, Vorlagen je Material, gespeicherte Standards."""
        known = full_profile()
        fields = [fld for fld in schema.FIELDS if fld.get("transform") or fld["key"] in known]
        return {"sections": schema.SECTIONS, "fields": fields,
                "materials": {k: material_defaults(k) for k in MATERIALS},
                "material_info": {k: {"enclosure": v.get("enclosure", False)} for k, v in MATERIALS.items()},
                "qualities": QUALITIES, "user_defaults": _clean_options(user_defaults()) if user_defaults() else None}

    @r.put("/api/admin/druck/slicer/defaults", dependencies=[Depends(require_viewer)])
    def save_defaults(body: SliceOptions):
        values = _clean_options(body.values)
        for k in schema.TRANSFORM_DEFAULTS:  # Modell-Drehung/Kopien nicht als Standard merken
            values.pop(k, None)
        defaults_file.write_text(json.dumps(values))
        return {"ok": True}

    @r.delete("/api/admin/druck/slicer/defaults", dependencies=[Depends(require_viewer)])
    def reset_defaults():
        defaults_file.unlink(missing_ok=True)
        return {"ok": True}

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
            job.update(options=_clean_options(body.values), state="slicing", message="", stats={})
            save(job)
        threading.Thread(target=run_slicer, args=(job_id,), daemon=True).start()
        return job

    # ------------------------------------------------ Live-Vorschau beim Einstellen (3D-Slicer)
    preview_sem = threading.Semaphore(1)

    @r.post("/api/admin/druck/jobs/{job_id}/live")
    def live_preview(job_id: str, body: SliceOptions, _=Depends(require_viewer)):
        """Mit den Einstellungen im Formular slicen (ohne den Auftrag zu ändern) und das Ergebnis liefern."""
        job = load(job_id)
        if job.get("sliced_by_user"):
            raise HTTPException(400, "Fertiger G-Code wird nicht neu geslict")
        values = _clean_options(body.values)
        h = options_hash(values)
        if job.get("state") == "ready" and job.get("options_hash") == h:
            return {"hash": h, "ok": True, "error": "", "stats": job.get("stats", {}), "url": f"/api/admin/druck/jobs/{job_id}/preview/gcode"}
        live = jobs_dir / job_id / "live"
        live.mkdir(exist_ok=True)
        meta = live / f"{h}.json"
        with preview_sem:
            if not meta.exists():
                out = live / f"{h}.gcode"
                ok, err = slice_to(job, values, out)
                meta.write_text(json.dumps({"hash": h, "ok": ok, "error": err, "stats": _parse_gcode_stats(out) if ok else {}}))
                # nur die letzten Vorschauen aufheben
                for old in sorted(live.glob("*.json"), key=lambda p: p.stat().st_mtime)[:-8]:
                    old.unlink(missing_ok=True)
                    old.with_suffix(".gcode").unlink(missing_ok=True)
        res = json.loads(meta.read_text())
        res["url"] = f"/api/admin/druck/jobs/{job_id}/live/{h}" if res["ok"] else None
        return res

    @r.get("/api/admin/druck/jobs/{job_id}/live/{h}", dependencies=[Depends(require_viewer)])
    def live_file(job_id: str, h: str):
        load(job_id)
        f = jobs_dir / job_id / "live" / f"{h}.gcode"
        if not re.fullmatch(r"[0-9a-f]{16}", h) or not f.exists():
            raise HTTPException(404, "Vorschau abgelaufen")
        return FileResponse(f, media_type="text/plain", headers={"Cache-Control": "private, max-age=3600"})

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
