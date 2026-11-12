"""3D-Drucker-Ansicht (Reiter "3D-Drucker" auf der Webseite).

Der Druckmonitor (Desktop-App am PC beim Drucker, Ordner druckmonitor/) schickt Kamerabild,
Druckerdaten und Modell hierher. Der Server muss den Drucker also nicht erreichen können.

Unter /druck/ liefert der Server dieselbe Vollbildansicht wie die Desktop-App aus (monitor.html und
Co. aus druckmonitor/web) und beantwortet deren /api/*-Abfragen mit den zuletzt empfangenen Daten.
"""
import asyncio
import json
import mimetypes
import os
import time
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse

# Ohne neue Daten so lange gilt die Desktop-App als offline
OFFLINE_AFTER_S = 15
# So lange nach der letzten Bildabfrage "schaut jemand zu" (dann schickt die App flüssig Bilder)
WATCHING_S = 15
MAX_FRAME = 5 * 1024 * 1024
MAX_MODEL = 95 * 1024 * 1024
MODEL_EXT = {".stl", ".3mf", ".obj", ".glb", ".gltf", ".gcode", ".gco", ".g", ".gx"}


def _web_dir() -> Path:
    env = os.environ.get("DRUCK_WEB_DIR")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for base in (here.parents[1], here.parents[2]):  # Docker: /srv, Entwicklung: Repo-Wurzel
        if (base / "druckmonitor" / "web" / "monitor.html").exists():
            return base / "druckmonitor" / "web"
    return here.parents[2] / "druckmonitor" / "web"


class DruckState:
    def __init__(self, data_dir: Path):
        self.dir = data_dir / "druck"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.state: dict = {}
        self.state_at = 0.0
        self.frame: Optional[bytes] = None
        self.frame_seq = 0
        self.frame_at = 0.0
        self.frame_event = asyncio.Event()
        self.last_view = 0.0
        self.model = self._load_model_info()

    def _load_model_info(self) -> dict:
        try:
            return json.loads((self.dir / "model.json").read_text())
        except Exception:
            return {"rev": 0, "name": "", "file": ""}

    @property
    def online(self) -> bool:
        return time.time() - self.state_at < OFFLINE_AFTER_S


def make_router(data_dir: Path, require_device: Callable, require_viewer: Callable) -> APIRouter:
    st = DruckState(data_dir)
    web = _web_dir()
    r = APIRouter()

    # ------------------------------------------------ Desktop-App -> Server (Geräte-Token)

    @r.post("/api/druck/state", dependencies=[Depends(require_device)])
    async def push_state(request: Request):
        body = await request.body()
        if len(body) > 512 * 1024:
            raise HTTPException(413, "Zu groß")
        try:
            data = json.loads(body)
        except ValueError:
            raise HTTPException(400, "Kein JSON")
        if not isinstance(data, dict):
            raise HTTPException(400, "Kein JSON-Objekt")
        st.state, st.state_at = data, time.time()
        return {"ok": True, "watching": time.time() - st.last_view < WATCHING_S}

    @r.post("/api/druck/frame", dependencies=[Depends(require_device)])
    async def push_frame(request: Request):
        body = await request.body()
        if not body or len(body) > MAX_FRAME:
            raise HTTPException(413, "Bild zu groß")
        st.frame, st.frame_at = body, time.time()
        st.frame_seq += 1
        ev, st.frame_event = st.frame_event, asyncio.Event()
        ev.set()  # wartende Abfragen wecken
        return {"ok": True, "watching": time.time() - st.last_view < WATCHING_S}

    @r.post("/api/druck/model", dependencies=[Depends(require_device)])
    async def push_model(request: Request, name: str = "", file: str = ""):
        ext = Path(file).suffix.lower()
        if file.lower().endswith(".gcode.3mf"):
            ext = ".3mf"
        for old in st.dir.glob("modell.*"):
            old.unlink(missing_ok=True)
        stored = ""
        if file:
            if ext not in MODEL_EXT:
                raise HTTPException(400, "Dateityp wird nicht unterstützt")
            stored = "modell" + ext
            tmp = st.dir / (stored + ".tmp")
            size = 0
            with tmp.open("wb") as f:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_MODEL:
                        f.close()
                        tmp.unlink(missing_ok=True)
                        raise HTTPException(413, "Modell zu groß")
                    f.write(chunk)
            tmp.replace(st.dir / stored)
        # eigener Zähler: bleibt auch eindeutig, wenn die Desktop-App neu gestartet wurde
        st.model = {"rev": int(st.model.get("rev", 0)) + 1, "name": name[:200], "file": stored}
        (st.dir / "model.json").write_text(json.dumps(st.model))
        return {"ok": True}

    # ------------------------------------------------ Webseite (angemeldet)

    @r.get("/api/admin/druck", dependencies=[Depends(require_viewer)])
    def admin_druck():
        live = (st.state.get("printer") or {}).get("live") or {}
        return {
            "online": st.online,
            "last_update": st.state_at or None,
            "frame_at": st.frame_at or None,
            "server_time": time.time(),
            "title": (st.state.get("config") or {}).get("title", ""),
            "model_name": st.model.get("name", ""),
            "status": live.get("status") or live.get("state") or "",
            "progress": live.get("progress"),
        }

    @r.get("/druck", include_in_schema=False)
    def druck_root():
        return RedirectResponse("/druck/monitor")

    @r.get("/druck/api/config", dependencies=[Depends(require_viewer)])
    def druck_config():
        cfg = dict(st.state.get("config") or {})
        cfg.setdefault("title", "3D-Druck Live")
        # Die Ansicht läuft hier nur zum Anschauen: Kamerabild kommt immer als Einzelbilder vom Server
        cfg.update({"remote": True, "mode": "auto", "ip": "", "fullscreen": False})
        return cfg

    @r.get("/druck/api/status", dependencies=[Depends(require_viewer)])
    def druck_status():
        if not st.online:
            ago = int(time.time() - st.state_at) if st.state_at else None
            return {"state": "error", "kind": "stream", "fps": 0, "url": "", "reconnects": 0,
                    "error": "Druckmonitor-App sendet keine Daten" + (f" (zuletzt vor {_fmt_ago(ago)})" if ago else "")}
        s = dict(st.state.get("status") or {})
        s["url"] = ""
        s["kind"] = "stream" if s.get("kind") == "page" else s.get("kind", "stream")
        return s

    @r.get("/druck/api/printer", dependencies=[Depends(require_viewer)])
    def druck_printer():
        p = dict(st.state.get("printer") or {})
        p["modelRev"] = st.model.get("rev", -1)  # erst neu laden, wenn das Modell wirklich hier ist
        p.setdefault("live", {})
        p.setdefault("file", {})
        if not st.online:
            p["live"] = {}
        return p

    @r.get("/druck/api/frame", dependencies=[Depends(require_viewer)])
    async def druck_frame(after: int = 0):
        st.last_view = time.time()
        if st.frame is None or st.frame_seq <= after:
            ev = st.frame_event
            try:
                await asyncio.wait_for(ev.wait(), timeout=3)
            except asyncio.TimeoutError:
                pass
        if st.frame is None or st.frame_seq <= after:
            return Response(status_code=204, headers={"Cache-Control": "no-store"})
        return Response(st.frame, media_type="image/jpeg",
                        headers={"X-Seq": str(st.frame_seq), "Cache-Control": "no-store"})

    @r.get("/druck/api/model", dependencies=[Depends(require_viewer)])
    def druck_model():
        f = st.model.get("file")
        if not f or not (st.dir / f).exists():
            raise HTTPException(404, "kein Modell")
        from urllib.parse import quote
        return FileResponse(st.dir / f, headers={"X-Model-Name": quote(st.model.get("name", "")),
                                                 "Cache-Control": "no-store"})

    @r.api_route("/druck/api/{rest:path}", methods=["GET", "POST", "DELETE"], dependencies=[Depends(require_viewer)])
    def druck_api_other(rest: str):
        # Fenster-/Einstellungsbefehle der Desktop-Ansicht gibt es hier nicht
        return {"ok": True, "native": False}

    @r.get("/druck/{path:path}", include_in_schema=False, dependencies=[Depends(require_viewer)])
    def druck_static(path: str):
        if path in ("", "monitor"):
            path = "monitor.html"
        target = (web / path).resolve()
        if web.resolve() not in target.parents or not target.is_file() or path == "setup.html":
            raise HTTPException(404, "Nicht gefunden")
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix == ".js":
            mime = "text/javascript"
        return FileResponse(target, media_type=mime, headers={"Cache-Control": "no-cache"})

    return r


def _fmt_ago(s: int) -> str:
    if s < 120:
        return f"{s} s"
    if s < 7200:
        return f"{s // 60} min"
    if s < 172800:
        return f"{s // 3600} h"
    return f"{s // 86400} Tagen"
