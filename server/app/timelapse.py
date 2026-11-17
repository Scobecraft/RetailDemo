"""Druck-Ereignisse (Start, fertig, Fehler) und Zeitraffer-Videos vom 3D-Drucker.

Während eines Drucks wird bei jedem Schichtwechsel das aktuelle Kamerabild gespeichert. Am Ende baut
ffmpeg daraus ein kurzes Video: es landet (einstellbar) in den Medien und Playlists der Demo-Handys und
läuft im Druckmonitor, solange nicht gedruckt wird.
"""
import json
import re
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

ACTIVE = ("printing", "paused", "heating")
MIN_FRAMES = 12          # weniger Bilder: kein Video
MAX_FRAMES = 3000
FRAME_EVERY_S = 3        # so oft schickt der Druckmonitor während eines Drucks Bilder (für den Zeitraffer)
FALLBACK_EVERY_S = 20    # ohne Schicht-Angabe: alle … Sekunden ein Bild
KEEP = 20                # so viele Zeitraffer bleiben gespeichert


class TimelapseConfig(BaseModel):
    enabled: bool = True
    to_media: bool = True
    playlist_ids: list[int] = []
    show_on_monitor: bool = True
    monitor_count: int = 3       # die letzten … Zeitraffer im Druckmonitor abspielen
    target_s: int = 15           # Länge des Videos


def _clean_name(name: str) -> str:
    name = re.sub(r"\.(gcode|gx|3mf|stl|obj|glb|gco|g)$", "", name or "", flags=re.I)
    return re.sub(r"\.gcode$", "", name, flags=re.I).strip() or "3D-Druck"


class PrintTracker:
    """Erkennt aus den Zustandsmeldungen Start, Ende und Fehler eines Drucks und sammelt Zeitraffer-Bilder."""

    def __init__(self, druck_dir: Path, hooks: dict):
        self.dir = druck_dir / "timelapses"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.cur = druck_dir / "timelapse-current"
        self.cfg_file = druck_dir / "timelapse.json"
        self.hooks = hooks
        self.state = ""
        self.job: Optional[dict] = None  # laufender Druck
        self.building = False
        try:
            self.job = json.loads((self.cur / "job.json").read_text())  # nach Neustart weitermachen
        except (OSError, ValueError):
            self.job = None
        if self.job:
            self.state = "printing"

    # ------------------------------------------------ Einstellungen
    def config(self) -> dict:
        c = TimelapseConfig().model_dump()
        try:
            c.update(json.loads(self.cfg_file.read_text()))
        except (OSError, ValueError):
            pass
        return c

    def save_config(self, body: TimelapseConfig) -> dict:
        c = body.model_dump()
        c["monitor_count"] = max(1, min(10, c["monitor_count"]))
        c["target_s"] = max(5, min(60, c["target_s"]))
        self.cfg_file.write_text(json.dumps(c))
        return c

    def wants_frames(self) -> bool:
        """Soll der Druckmonitor gerade regelmäßig Bilder schicken (Zeitraffer läuft)?"""
        return bool(self.job) and self.config()["enabled"]

    # ------------------------------------------------ Ereignisse
    def emit(self, kind: str, info: dict):
        for fn in self.hooks.get("print_listeners", []):
            try:
                fn(kind, info)
            except Exception:  # noqa: BLE001 – ein Empfänger darf die anderen nicht stören
                pass

    def on_state(self, online: bool, live: dict, frame: Optional[bytes], frame_at: float, model_name: str):
        if not online or not live or not live.get("online"):
            return  # offline: nichts schließen (der Druck läuft vermutlich weiter)
        s = live.get("state") or ""
        if s in ("offline", "busy", ""):
            return
        was_active = self.state in ACTIVE
        now_active = s in ACTIVE
        self.state = s
        name = _clean_name(live.get("fileName") or model_name or "")
        if now_active and not was_active and not self.job:
            self.job = {"id": uuid.uuid4().hex, "name": name, "file": live.get("fileName") or "", "started": time.time(),
                        "frames": 0, "last_layer": -1, "last_t": 0}
            shutil.rmtree(self.cur, ignore_errors=True)
            self.cur.mkdir(parents=True)
            self._save_job()
            self.emit("started", {"name": name, "file": self.job["file"]})
        if now_active and self.job:
            self._capture(live, frame, frame_at)
        if not now_active and self.job:
            job, self.job = self.job, None
            prog = live.get("progress")
            ok = s == "done" or (isinstance(prog, (int, float)) and prog >= 0.97)
            failed = s == "error"
            info = {"name": job["name"], "file": job["file"], "duration_s": time.time() - job["started"],
                    "ok": ok and not failed, "error": live.get("error") or live.get("status") or "", "state": s}
            self.emit("finished" if ok and not failed else ("failed" if failed else "cancelled"), info)
            if self.config()["enabled"] and ok and not failed:
                threading.Thread(target=self._build, args=(job,), daemon=True).start()
            else:
                shutil.rmtree(self.cur, ignore_errors=True)

    def _save_job(self):
        if self.job:
            (self.cur / "job.json").write_text(json.dumps(self.job))

    def _capture(self, live: dict, frame: Optional[bytes], frame_at: float):
        j = self.job
        if not self.config()["enabled"] or frame is None or time.time() - frame_at > 10 or j["frames"] >= MAX_FRAMES:
            return
        layer = live.get("layer") or 0
        now = time.time()
        if layer > 0:
            if layer == j["last_layer"]:
                return
        elif now - j["last_t"] < FALLBACK_EVERY_S:
            return
        j["frames"] += 1
        j["last_layer"], j["last_t"] = layer, now
        (self.cur / f"{j['frames']:05d}.jpg").write_bytes(frame)
        self._save_job()

    # ------------------------------------------------ Video bauen
    def _build(self, job: dict):
        self.building = True
        try:
            n = job["frames"]
            if n < MIN_FRAMES:
                return
            cfg = self.config()
            fps = max(8, min(30, round(n / cfg["target_s"])))
            vid = datetime.now().strftime("%Y%m%d-%H%M%S")
            out = self.dir / f"{vid}.mp4"
            tmp = self.dir / f"{vid}.part.mp4"
            cmd = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-i", str(self.cur / "%05d.jpg"),
                   "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,tpad=stop_mode=clone:stop_duration=2,format=yuv420p",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-movflags", "+faststart", str(tmp)]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
            if res.returncode != 0 or not tmp.exists():
                return
            tmp.replace(out)
            # Vorschaubild: das fertige Teil (letztes Bild)
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(self.cur / f"{n:05d}.jpg"), "-vf", "scale=640:-2",
                            str(self.dir / f"{vid}.jpg")], capture_output=True, timeout=60)
            meta = {"id": vid, "name": job["name"], "created": time.time(), "frames": n,
                    "duration_s": round(n / fps + 2, 1), "print_s": round(time.time() - job["started"]), "media_id": None}
            if cfg["to_media"] and (reg := self.hooks.get("register_media")):
                tmp_copy = self.dir / f"{vid}.media.mp4"
                shutil.copy2(out, tmp_copy)
                title = f"Zeitraffer: {job['name']} ({datetime.now().strftime('%d.%m.%Y')})"
                m = reg(tmp_copy, f"{title}.mp4", "video/mp4", title)
                meta["media_id"] = m["id"]
                if cfg["playlist_ids"] and (add := self.hooks.get("add_to_playlists")):
                    add(m["id"], cfg["playlist_ids"])
            (self.dir / f"{vid}.json").write_text(json.dumps(meta))
            for old in self.videos()[KEEP:]:
                self.delete(old["id"])
            self.emit("timelapse", meta)
        except Exception:  # noqa: BLE001
            pass
        finally:
            shutil.rmtree(self.cur, ignore_errors=True)
            self.building = False

    def videos(self) -> list[dict]:
        out = []
        for f in self.dir.glob("*.json"):
            try:
                m = json.loads(f.read_text())
                if (self.dir / f"{m['id']}.mp4").exists():
                    out.append(m)
            except (OSError, ValueError, KeyError):
                continue
        return sorted(out, key=lambda m: m["created"], reverse=True)

    def file(self, vid: str) -> Path:
        if not re.fullmatch(r"\d{8}-\d{6}", vid or "") or not (self.dir / f"{vid}.mp4").exists():
            raise HTTPException(404, "Zeitraffer nicht gefunden")
        return self.dir / f"{vid}.mp4"

    def poster(self, vid: str) -> Path:
        p = self.dir / f"{vid}.jpg"
        if not re.fullmatch(r"\d{8}-\d{6}", vid or "") or not p.exists():
            raise HTTPException(404, "Kein Vorschaubild")
        return p

    def delete(self, vid: str):
        (self.dir / f"{vid}.jpg").unlink(missing_ok=True)
        (self.dir / f"{vid}.mp4").unlink(missing_ok=True)
        (self.dir / f"{vid}.json").unlink(missing_ok=True)

    def for_monitor(self) -> dict:
        c = self.config()
        items = self.videos()[: c["monitor_count"]] if c["show_on_monitor"] else []
        return {"show": c["show_on_monitor"], "items": [{"id": m["id"], "name": m["name"], "created": m["created"],
                                                         "duration_s": m["duration_s"]} for m in items]}


def make_timelapse_router(tr: PrintTracker, require_device: Callable, require_viewer: Callable):
    r = APIRouter()

    @r.get("/api/admin/timelapse", dependencies=[Depends(require_viewer)])
    def admin_list():
        return {"items": tr.videos(), "config": tr.config(), "recording": bool(tr.job),
                "frames": tr.job["frames"] if tr.job else 0, "building": tr.building}

    @r.put("/api/admin/timelapse/config", dependencies=[Depends(require_viewer)])
    def admin_config(body: TimelapseConfig):
        return tr.save_config(body)

    @r.get("/api/admin/timelapse/{vid}/file", dependencies=[Depends(require_viewer)])
    def admin_file(vid: str):
        return FileResponse(tr.file(vid), media_type="video/mp4")

    @r.get("/api/admin/timelapse/{vid}/poster", dependencies=[Depends(require_viewer)])
    def admin_poster(vid: str):
        return FileResponse(tr.poster(vid), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})

    @r.delete("/api/admin/timelapse/{vid}", dependencies=[Depends(require_viewer)])
    def admin_delete(vid: str):
        tr.file(vid)
        tr.delete(vid)
        return {"ok": True}

    # Druckmonitor-App (Geräte-Token): Liste + Videos zum Abspielen, wenn nicht gedruckt wird
    @r.get("/api/druck/timelapses", dependencies=[Depends(require_device)])
    def device_list():
        return tr.for_monitor()

    @r.get("/api/druck/timelapses/{vid}.mp4", dependencies=[Depends(require_device)])
    def device_file(vid: str):
        return FileResponse(tr.file(vid), media_type="video/mp4", headers={"Cache-Control": "max-age=31536000, immutable"})

    # Vollbildansicht /druck/ auf dem Server (gleiche Oberfläche wie im Druckmonitor)
    @r.get("/druck/api/timelapses", dependencies=[Depends(require_viewer)])
    def viewer_list():
        return tr.for_monitor()

    @r.get("/druck/api/timelapse/{vid}.mp4", dependencies=[Depends(require_viewer)])
    def viewer_file(vid: str):
        return FileResponse(tr.file(vid), media_type="video/mp4", headers={"Cache-Control": "max-age=31536000, immutable"})

    return r
