"""3D-Drucker-Ansicht (Reiter "3D-Drucker" auf der Webseite).

Der Druckmonitor (Desktop-App am PC beim Drucker, Ordner druckmonitor/) schickt Kamerabild,
Druckerdaten und Modell hierher. Der Server muss den Drucker also nicht erreichen können.

Unter /druck/ liefert der Server dieselbe Vollbildansicht wie die Desktop-App aus (monitor.html und
Co. aus druckmonitor/web) und beantwortet deren /api/*-Abfragen mit den zuletzt empfangenen Daten.
"""
import asyncio
import collections
import hashlib
import json
import re
import shutil
import mimetypes
import os
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse

from .timelapse import FRAME_EVERY_S, PrintTracker, make_timelapse_router

# Ohne neue Daten so lange gilt die Desktop-App als offline
OFFLINE_AFTER_S = 15
# So lange nach der letzten Bildabfrage "schaut jemand zu" (dann schickt die App flüssig Bilder)
WATCHING_S = 15
MAX_FRAME = 5 * 1024 * 1024
MAX_MODEL = 95 * 1024 * 1024
# Verlauf für die Diagramme: alle 5 s ein Punkt, eine Stunde lang (nur im Speicher)
HISTORY_STEP_S = 5
HISTORY_LEN = 720
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
        self.frame_session = ""
        self.frame_in_seq = 0  # Nummer des zuletzt übernommenen Bildes (vom Druckmonitor)
        self.last_view = 0.0
        self.model = self._load_model_info()
        self.pc_info: Optional[dict] = None
        self.history: collections.deque = collections.deque(maxlen=HISTORY_LEN)

    def _load_model_info(self) -> dict:
        try:
            return json.loads((self.dir / "model.json").read_text())
        except Exception:
            return {"rev": 0, "name": "", "file": ""}

    @property
    def online(self) -> bool:
        return time.time() - self.state_at < OFFLINE_AFTER_S


# ---------------------------------------------------------------- Programm-Updates (Installer)

def _version_tuple(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v or "")[:4]) or (0,)


def read_installer_version(path: Path) -> Optional[str]:
    """Version aus dem Windows-Versions-Eintrag des Installers (ProductName muss "Druckmonitor" sein)."""
    data = path.read_bytes()

    def value(key: str) -> Optional[str]:
        k = (key + "\0").encode("utf-16-le")
        i = data.find(k)
        if i < 0:
            return None
        i += len(k)
        i += (-i) % 4  # Werte beginnen 32-Bit-ausgerichtet
        end = data.find(b"\0\0", i)
        while end > 0 and (end - i) % 2:  # UTF-16: Ende auf gerader Position suchen
            end = data.find(b"\0\0", end + 1)
        return data[i:end].decode("utf-16-le", "ignore").strip() if end > 0 else None

    if value("ProductName") != "Druckmonitor":
        return None
    v = value("ProductVersion")
    return v if v and re.fullmatch(r"\d+(\.\d+){1,3}", v) else None


def make_router(data_dir: Path, require_device: Callable, require_viewer: Callable, hooks: Optional[dict] = None):
    """hooks["pending_job"]: liefert den Druckauftrag, den die App abholen soll (siehe druckjobs.py)."""
    hooks = hooks if hooks is not None else {}
    st = DruckState(data_dir)
    web = _web_dir()
    r = APIRouter()
    tracker = PrintTracker(st.dir, hooks)
    hooks["tracker"] = tracker
    hooks["druck_status"] = lambda: {"online": st.online, "shutdown": st.state.get("shutdown"), "app_version": st.state.get("appVersion")}
    remote_lock = {"seq": 0, "on": True}
    r.include_router(make_timelapse_router(tracker, require_device, require_viewer))  # vor /druck/api/{rest}
    release_file = st.dir / "Druckmonitor-Setup.exe"
    release_json = st.dir / "release.json"

    def release() -> Optional[dict]:
        try:
            rel = json.loads(release_json.read_text())
            return rel if release_file.exists() else None
        except Exception:
            return None

    def update_for(app_version: str) -> Optional[dict]:
        rel = release()
        if not rel or _version_tuple(rel["version"]) <= _version_tuple(app_version or "0"):
            return None
        return {**rel, "url": "/api/druck/update/file"}

    def register_release(tmp: Path) -> dict:
        """Hochgeladenen Installer übernehmen (vom Upload in Stücken aufgerufen)."""
        version = read_installer_version(tmp)
        if not version:
            tmp.unlink(missing_ok=True)
            raise HTTPException(400, "Das ist kein Druckmonitor-Installer (Druckmonitor-Setup-….exe).")
        sha = hashlib.sha256()
        with open(tmp, "rb") as f:
            while chunk := f.read(1024 * 1024):
                sha.update(chunk)
        rel = {"version": version, "size": tmp.stat().st_size, "sha256": sha.hexdigest(),
               "uploaded_at": time.time(), "install_request": None}
        shutil.move(str(tmp), release_file)
        release_json.write_text(json.dumps(rel))
        return rel

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
        if isinstance(data.get("pcInfo"), dict):
            st.pc_info = data["pcInfo"]
        st.state, st.state_at = data, time.time()
        _record_history(st)
        tracker.on_state(True, (data.get("printer") or {}).get("live") or {}, st.frame, st.frame_at, st.model.get("name", ""))
        if (advance := hooks.get("advance_queue")):
            advance()
        pending = hooks.get("pending_job")
        return {"ok": True, "watching": time.time() - st.last_view < WATCHING_S, "needInfo": st.pc_info is None,
                "update": update_for(str(data.get("appVersion") or "")),
                # Feierabend: Zeitplan zum Herunterfahren des PCs
                "shutdown_plan": (hooks["shutdown_plan"]() if hooks.get("shutdown_plan") else None),
                # Zeitraffer: während des Drucks regelmäßig Bilder schicken (auch wenn niemand zuschaut)
                "timelapse": tracker.wants_frames(), "frame_every_s": FRAME_EVERY_S,
                "print_job": pending() if pending else None,
                # „Druckbett ist frei“ auf der Webseite → auch am Drucker bestätigen (neuere Firmware verlangt das)
                "clear_platform": hooks.get("clear_platform_seq", 0),
                # Kundenschutz von der Webseite sperren/entsperren
                "input_lock": remote_lock if remote_lock["seq"] else None,
                "model_override": ({"id": o["id"], "name": o["name"], "url": "/api/druck/override/file"}
                                   if (o := model_override()) else None)}

    # ------------------------------------------------ Programm-Updates

    @r.get("/api/druck/update", dependencies=[Depends(require_device)])
    def device_update(version: str = ""):
        rel = release()
        return {"release": {**rel, "url": "/api/druck/update/file"} if rel else None,
                "newer": bool(update_for(version))}

    @r.get("/api/druck/update/file", dependencies=[Depends(require_device)])
    def device_update_file():
        if not release():
            raise HTTPException(404, "Kein Update vorhanden")
        return FileResponse(release_file, media_type="application/vnd.microsoft.portable-executable",
                            filename="Druckmonitor-Setup.exe")

    @r.get("/api/admin/druck/release", dependencies=[Depends(require_viewer)])
    def admin_release():
        return {"release": release(), "pc_version": st.state.get("appVersion") or None,
                "pc_online": st.online, "pc_host": (st.pc_info or {}).get("host")}

    @r.post("/api/admin/druck/release/install-now", dependencies=[Depends(require_viewer)])
    def admin_install_now():
        rel = release()
        if not rel:
            raise HTTPException(404, "Erst einen Installer hochladen")
        rel["install_request"] = int(time.time() * 1000)
        release_json.write_text(json.dumps(rel))
        return rel

    @r.delete("/api/admin/druck/release", dependencies=[Depends(require_viewer)])
    def admin_delete_release():
        release_file.unlink(missing_ok=True)
        release_json.unlink(missing_ok=True)
        return {"ok": True}

    @r.post("/api/druck/frame", dependencies=[Depends(require_device)])
    async def push_frame(request: Request):
        body = await request.body()
        if not body or len(body) > MAX_FRAME:
            raise HTTPException(413, "Bild zu groß")
        # Der Druckmonitor schickt mehrere Bilder gleichzeitig: ein zu spät angekommenes älteres verwerfen
        session = request.headers.get("x-frame-session", "")
        try:
            n = int(request.headers.get("x-frame-seq", "0"))
        except ValueError:
            n = 0
        if session and n:
            if session == st.frame_session and n <= st.frame_in_seq:
                return {"ok": True, "watching": time.time() - st.last_view < WATCHING_S, "skipped": True}
            st.frame_session, st.frame_in_seq = session, n
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

    # ------------------------------------------------ Modell von der Webseite (falls der Druckmonitor es nicht findet)
    override_json = st.dir / "override.json"

    def model_override() -> Optional[dict]:
        """Auf der Webseite gewähltes Modell, das die Druckmonitor-App übernehmen soll (24 h gültig)."""
        try:
            o = json.loads(override_json.read_text())
        except (OSError, ValueError):
            return None
        if not (st.dir / o.get("file", "")).exists() or time.time() - o.get("at", 0) > 86400:
            return None
        return o

    def set_model(src: Path, name: str) -> dict:
        """Modell sofort auf der Webseite anzeigen und für die Druckmonitor-App bereitstellen."""
        low = name.lower()
        ext = ".3mf" if low.endswith(".gcode.3mf") else Path(low).suffix
        if ext not in MODEL_EXT:
            raise HTTPException(400, "Bitte eine STL-, 3MF-, OBJ-, GLB- oder G-Code-Datei wählen")
        for old in st.dir.glob("override.*"):
            if old.suffix != ".json":
                old.unlink(missing_ok=True)
        ofile = "override" + ext
        shutil.copyfile(src, st.dir / ofile)
        for old in st.dir.glob("modell.*"):
            old.unlink(missing_ok=True)
        shutil.copyfile(st.dir / ofile, st.dir / ("modell" + ext))
        st.model = {"rev": int(st.model.get("rev", 0)) + 1, "name": Path(name).name[:200], "file": "modell" + ext}
        (st.dir / "model.json").write_text(json.dumps(st.model))
        o = {"id": uuid.uuid4().hex, "name": Path(name).name[:200], "file": ofile, "at": time.time()}
        override_json.write_text(json.dumps(o))
        return {"ok": True, "name": o["name"], "rev": st.model["rev"]}

    hooks["set_model"] = set_model

    @r.get("/api/druck/override/file", dependencies=[Depends(require_device)])
    def override_file():
        o = model_override()
        if not o:
            raise HTTPException(404, "Kein Modell bereitgestellt")
        return FileResponse(st.dir / o["file"], media_type="application/octet-stream")

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

    @r.get("/api/admin/druck/live", dependencies=[Depends(require_viewer)])
    def admin_druck_live(since: float = 0):
        """Alles für den Reiter "3D-Drucker": aktuelle Werte und Verlauf (nur Punkte nach ?since)."""
        printer = st.state.get("printer") or {}
        live = dict(printer.get("live") or {}) if st.online else None
        file = dict(printer.get("file") or {})
        # Druck von der Webseite: fehlende Slicer-Angaben aus dem Druckauftrag ergänzen
        if live and not file.get("timeSec") and (lookup := hooks.get("stats_for_printing")):
            file.update(lookup(live.get("fileName") or "") or {})
        # Restzeit fehlt (ältere Druckmonitor-Version): aus Druckzeit laut Slicer hochrechnen
        prog = live.get("progress", -1) if live else -1
        if live and live.get("state") in ("printing", "paused") and (live.get("remainingSec") or 0) <= 0 and 0 <= prog < 0.999:
            if file.get("timeSec"):
                live.update(remainingSec=file["timeSec"] * (1 - prog), remainingEst=True)
            elif (live.get("elapsedSec") or 0) > 60 and prog > 0.02:
                live.update(remainingSec=live["elapsedSec"] * (1 - prog) / prog, remainingEst=True)
        return {
            "online": st.online,
            "server_time": time.time(),
            "last_update": st.state_at or None,
            "frame_at": st.frame_at or None,
            "config": {k: v for k, v in (st.state.get("config") or {}).items() if k in ("title", "subtitle", "modelColor")},
            "live": live,
            "file": file,
            "model": {"rev": st.model.get("rev", 0), "name": st.model.get("name", ""), "has_file": bool(st.model.get("file"))},
            "camera": {k: (st.state.get("status") or {}).get(k) for k in ("state", "fps", "error")} if st.online else None,
            "pc": st.state.get("pc") if st.online else None,
            "pc_info": st.pc_info,
            "input_lock": st.state.get("inputLock") if st.online else None,
            "history": [p for p in st.history if p["t"] > since],
        }

    @r.post("/api/admin/druck/inputlock", dependencies=[Depends(require_viewer)])
    async def set_input_lock(request: Request):
        """Tastatur & Maus am Druckmonitor-PC sperren/entsperren (wird mit der nächsten Meldung übernommen)."""
        try:
            on = bool((await request.json()).get("on"))
        except ValueError:
            raise HTTPException(400, "Kein JSON")
        remote_lock.update(seq=int(time.time() * 1000), on=on)
        return {"ok": True, "on": on}

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
        return await next_frame(after)

    # Durchgehender Bild-Stream für die Webseite: eine Verbindung statt einer Anfrage pro Bild.
    # Aufbau je Bild: 4 Byte Länge + 4 Byte Nummer (Big Endian), dann das JPEG. Länge 0 = Lebenszeichen.
    @r.get("/druck/api/stream", dependencies=[Depends(require_viewer)])
    async def druck_stream(request: Request, after: int = 0):
        async def gen():
            seq, start = after, time.time()
            while time.time() - start < 120:  # danach baut die Webseite neu auf
                if await request.is_disconnected():
                    break
                st.last_view = time.time()
                if st.frame is None or st.frame_seq <= seq:
                    ev = st.frame_event
                    try:
                        await asyncio.wait_for(ev.wait(), timeout=4)
                    except asyncio.TimeoutError:
                        yield b"\0" * 8
                        continue
                if st.frame is None or st.frame_seq <= seq:
                    continue
                frame, seq = st.frame, st.frame_seq
                yield len(frame).to_bytes(4, "big") + (seq & 0xFFFFFFFF).to_bytes(4, "big") + frame
        return StreamingResponse(gen(), media_type="application/octet-stream",
                                 headers={"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"})

    async def next_frame(after: int):
        st.last_view = time.time()  # jemand schaut zu -> die App schickt flüssig Bilder
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

    # ------------------------------------------------ Handys: Einblendung "3D-Druck live" in der Demo

    @r.get("/api/device/druck/status", dependencies=[Depends(require_device)])
    def device_druck_status(watch: bool = False):
        """Läuft gerade ein Druck mit Kamerabild? Plus die Werte für die Einblendung.
        watch=1: Einblendung beginnt gleich -> App schon jetzt um flüssige Bilder bitten."""
        if watch:
            st.last_view = time.time()
        live = (st.state.get("printer") or {}).get("live") or {}
        file = (st.state.get("printer") or {}).get("file") or {}
        now = time.time()
        active = bool(st.online and live.get("online") and live.get("state") == "printing"
                      and st.frame is not None and now - st.frame_at < 90)
        if not active:
            return {"active": False}
        name = st.model.get("name") or live.get("fileName") or ""
        name = re.sub(r"\.(gcode|gx|3mf|stl|obj|glb|gco|g)$", "", name, flags=re.I)
        name = re.sub(r"\.gcode$", "", name, flags=re.I)
        return {
            "active": True,
            "model": name,
            "progress": _num(live.get("progress")),
            "remaining_s": _num(live.get("remainingSec")),
            "remaining_estimated": bool(live.get("remainingEst")),
            "elapsed_s": _num(live.get("elapsedSec")),
            "layer": live.get("layer") or 0,
            "layers": live.get("layers") or file.get("layers") or 0,
            "nozzle": _num(live.get("nozzle"), 0), "nozzle_target": _num(live.get("nozzleTarget"), 0),
            "bed": _num(live.get("bed"), 0), "bed_target": _num(live.get("bedTarget"), 0),
            "speed_mms": _num(live.get("speedMms"), 0),
            "fan": _num(live.get("fanPct")),
            "filament": " · ".join(x for x in [file.get("filamentType") or live.get("filamentType"), file.get("filamentName")] if x),
            "filament_color": file.get("filamentColor") or "",
            "layer_height": _num(file.get("layerHeight"), 0),
            "machine": live.get("machine") or "",
        }

    @r.get("/api/device/druck/frame", dependencies=[Depends(require_device)])
    async def device_druck_frame(after: int = 0):
        return await next_frame(after)

    @r.get("/api/device/druck/logo", dependencies=[Depends(require_device)])
    def device_druck_logo():
        logo = web / "logo.png"
        if not logo.exists():
            raise HTTPException(404, "Kein Logo")
        return FileResponse(logo, media_type="image/png", headers={"Cache-Control": "max-age=86400"})

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

    def printer_state() -> dict:
        """Kurzer Druckerzustand für die Druckaufträge."""
        live = (st.state.get("printer") or {}).get("live") or {}
        return {"online": st.online and bool(live.get("online")), "app_online": st.online,
                "state": live.get("state") if st.online else None, "status": live.get("status") if st.online else None,
                "can_upload": bool((st.state.get("capabilities") or {}).get("upload")),
                "app_version": st.state.get("appVersion"), "remaining_s": _remaining(live) if st.online else None}

    def _remaining(live: dict):
        """Restzeit des laufenden Drucks (vom Drucker, sonst aus Fortschritt hochgerechnet)."""
        if live.get("state") not in ("printing", "paused", "heating"):
            return None
        rem = _num(live.get("remainingSec"))
        if rem:
            return rem
        prog, el = _num(live.get("progress")), _num(live.get("elapsedSec"))
        if prog and el and prog > 0.02:
            return el * (1 - prog) / prog
        return None

    hooks["printer_state"] = printer_state
    return r, register_release


def _num(v, lo: float = -0.5):
    """Zahl oder None (unbekannte Werte meldet die App als -1)."""
    return round(float(v), 2) if isinstance(v, (int, float)) and v > lo else None


def _record_history(st: DruckState):
    now = time.time()
    if st.history and now - st.history[-1]["t"] < HISTORY_STEP_S:
        return
    live = (st.state.get("printer") or {}).get("live") or {}
    pc = st.state.get("pc") or {}
    p = {"t": round(now, 1)}
    if live.get("online"):
        prog = _num(live.get("progress"), -0.5)
        p.update({"nozzle": _num(live.get("nozzle"), 0), "nozzle_t": _num(live.get("nozzleTarget"), -0.5),
                  "bed": _num(live.get("bed"), 0), "bed_t": _num(live.get("bedTarget"), -0.5),
                  "progress": round(prog * 100, 2) if prog is not None else None,
                  "speed": _num(live.get("speedMms")), "fan": _num(live.get("fanPct"))})
    if pc:
        ram_total = pc.get("ramTotalB") or 0
        gpus = pc.get("gpus") or []
        g = gpus[0] if gpus else {}
        p.update({"cpu": _num(pc.get("cpuPct")),
                  "ram": round(100 * pc.get("ramUsedB", 0) / ram_total, 2) if ram_total else None,
                  "gpu": _num(g.get("pct")) if g else None,
                  "gpu_temp": _num(g.get("tempC"), 0) if g else None,
                  "rx": _num(pc.get("netRxBps")), "tx": _num(pc.get("netTxBps")),
                  "disk_r": _num(pc.get("diskReadBps")), "disk_w": _num(pc.get("diskWriteBps"))})
    st.history.append(p)


def _fmt_ago(s: int) -> str:
    if s < 120:
        return f"{s} s"
    if s < 7200:
        return f"{s // 60} min"
    if s < 172800:
        return f"{s // 3600} h"
    return f"{s // 86400} Tagen"
