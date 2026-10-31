"""Retail Demo Server.

Speichert Medien (Videos/Bilder), Playlists und registrierte Demo-Geräte.
- Admin-App:   Authorization: Bearer <ADMIN_TOKEN>
- Demo-App:    Authorization: Bearer <DEVICE_TOKEN>
- Laptop-Demo: Authorization: Bearer <DEVICE_TOKEN> (meldet sich mit platform="windows"/"macos"/"linux")
"""
import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

from collections import deque

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .apkinfo import read_apk_info

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
MEDIA_DIR = DATA_DIR / "media"
THUMB_DIR = DATA_DIR / "thumbs"
DB_PATH = DATA_DIR / "demo.db"
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
DEVICE_TOKEN = os.environ.get("DEVICE_TOKEN", "")
# Anmeldung für die Webseite (leeres Passwort = Webseite gesperrt)
WEB_USER = os.environ.get("WEB_USER", "admin")
WEB_PASSWORD = os.environ.get("WEB_PASSWORD", "")
SESSION_COOKIE = "rd_session"
SESSION_DAYS = 14
UPLOAD_DIR = DATA_DIR / "uploads"
LOGO_DIR = DATA_DIR / "logo"
LOGO_MAX_BYTES = 10 * 1024 * 1024
WEB_DIR = Path(__file__).parent / "web"
APP_DIR = DATA_DIR / "app"
APP_APK = APP_DIR / "demo-latest.apk"
DEMO_PACKAGE = "de.retaildemo.demo"
# Werte des Proxmox-Containers (per docker-compose eingebunden); sonst die von Docker selbst
HOST_PROC = Path("/host/proc") if Path("/host/proc/meminfo").exists() else Path("/proc")

# Geräte melden sich jede Minute (damit "Jetzt auf allen Handys aktualisieren" sofort ankommt).
HEARTBEAT_INTERVAL_S = 60
# Als "online" gilt ein Gerät, das sich in den letzten 11 Minuten gemeldet hat (Standby verzögert Meldungen).
ONLINE_WINDOW_S = 660
DEFAULT_SETTINGS = {
    "sync_interval_min": 60,
    "idle_timeout_s": 30,
    "specs_every_n": 3,
    "specs_duration_s": 10,
    "image_duration_s": 8,
    "cleanup_interval_h": 2,
    # Laptops: Kunden lesen/tippen länger, daher eigene Wartezeit bis zur Rückkehr der Demo
    "laptop_idle_timeout_s": 60,
}
# Text-Einstellungen
TEXT_SETTINGS = {
    "store_name": "",
    # Kindersicherung der Laptops: off / family (Cloudflare for Families) / strict (CleanBrowsing Family)
    "web_filter": "off",
    # zusätzlich gesperrte Webseiten, eine Domain pro Zeile
    "blocked_domains": "",
}
WEB_FILTER_MODES = {"off", "family", "strict"}
DOMAIN_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")


MAX_BLOCKED_DOMAINS = 500  # mehr verkraftet das /etc/hosts-Skript auf den Macs nicht sinnvoll


def clean_domains(text: str) -> list[str]:
    """Sperrliste säubern: 'https://www.Beispiel.de/pfad' -> 'beispiel.de'.

    Versteht auch Zeilen aus fertigen Sperrlisten ('0.0.0.0 beispiel.de', '||beispiel.de^', Kommentare)
    und hört nach MAX_BLOCKED_DOMAINS Einträgen auf, damit auch riesige Listen sofort verarbeitet sind."""
    out, seen = [], set()
    for line in (text or "").splitlines():
        d = line.split("#", 1)[0].strip().lower()
        if not d or d.startswith("!"):
            continue
        d = d.split()[-1].removeprefix("||").split("^")[0]  # hosts-Format / Adblock-Format
        d = re.sub(r"^[a-z]+://", "", d).split("/")[0].split(":")[0]
        d = d.removeprefix("www.").strip(".")
        if d and d not in seen and DOMAIN_RE.match(d):
            seen.add(d)
            out.append(d)
            if len(out) >= MAX_BLOCKED_DOMAINS:
                break
    return out
# Einstellungen, bei denen 0 "aus" bedeutet
ZERO_ALLOWED = {"cleanup_interval_h"}
WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
DEFAULT_SCHEDULE = {
    "enabled": False,
    "days": [{"active": i < 6, "on": "09:00", "off": "20:00"} for i in range(7)],
}

MEDIA_DIR.mkdir(parents=True, exist_ok=True)
THUMB_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
APP_DIR.mkdir(parents=True, exist_ok=True)
LOGO_DIR.mkdir(parents=True, exist_ok=True)
# RLock: Hilfsfunktionen dürfen db() auch innerhalb eines laufenden db()-Blocks aufrufen
_db_lock = threading.RLock()


@contextmanager
def db():
    with _db_lock:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def init_db():
    with db() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS media (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                filename TEXT NOT NULL,
                type TEXT NOT NULL,
                mime TEXT NOT NULL,
                size INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                duration_s INTEGER,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                is_default INTEGER NOT NULL DEFAULT 0,
                show_specs INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS playlist_items (
                playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                PRIMARY KEY (playlist_id, position)
            );
            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,
                display_name TEXT,
                manufacturer TEXT,
                model TEXT,
                marketing_name TEXT,
                android_version TEXT,
                app_version TEXT,
                auto_specs TEXT NOT NULL DEFAULT '[]',
                custom_specs TEXT NOT NULL DEFAULT '',
                show_specs INTEGER NOT NULL DEFAULT 1,
                playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
                synced_hash TEXT,
                status TEXT,
                last_error TEXT,
                battery INTEGER,
                ip TEXT,
                sync_requested INTEGER NOT NULL DEFAULT 0,
                last_seen REAL,
                last_sync REAL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS web_sessions (
                token_hash TEXT PRIMARY KEY,
                expires REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        cols = {r["name"] for r in c.execute("PRAGMA table_info(devices)")}
        if "app_version_code" not in cols:
            # Versionsnummer der installierten Demo-App und bereits heruntergeladenes Update
            c.execute("ALTER TABLE devices ADD COLUMN app_version_code INTEGER")
            c.execute("ALTER TABLE devices ADD COLUMN update_ready INTEGER")
        if "removed" not in cols:
            # 1 = App wurde (mit PIN) deinstalliert -> in der Admin-App ausblenden
            c.execute("ALTER TABLE devices ADD COLUMN removed INTEGER NOT NULL DEFAULT 0")
        if "platform" not in cols:
            # android = Demo-App auf dem Handy, windows/macos/linux = Laptop-Demo
            c.execute("ALTER TABLE devices ADD COLUMN platform TEXT NOT NULL DEFAULT 'android'")
        version = c.execute("SELECT value FROM settings WHERE key='schema_version'").fetchone()
        if version is None:
            # v2: Standard-Wartezeit bis zum Neustart der Demo von 60 auf 30 Sekunden
            c.execute("UPDATE settings SET value='30' WHERE key='idle_timeout_s' AND value='60'")
            c.execute("INSERT INTO settings (key, value) VALUES ('schema_version', '2')")


init_db()
app = FastAPI(title="Retail Demo Server", docs_url=None, redoc_url=None, openapi_url=None)


# --------------------------------------------------------------------------- auth

def _bearer_ok(authorization: Optional[str], *tokens: str) -> bool:
    if not authorization or not authorization.startswith("Bearer "):
        return False
    given = authorization[7:]
    return any(t and secrets.compare_digest(given, t) for t in tokens)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _web_session_ok(request: Request) -> bool:
    """Angemeldet über die Webseite? Ändernde Anfragen brauchen zusätzlich den Header
    X-Requested-With (Schutz gegen fremde Webseiten, die Formulare an diesen Server schicken)."""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return False
    with db() as c:
        row = c.execute("SELECT expires FROM web_sessions WHERE token_hash=?", (_hash_token(token),)).fetchone()
    if not row or row["expires"] < time.time():
        return False
    if request.method not in ("GET", "HEAD") and request.headers.get("x-requested-with") != "RetailDemo":
        raise HTTPException(403, "Ungültige Anfrage")
    return True


def require_admin(request: Request, authorization: Optional[str] = Header(None)):
    if _bearer_ok(authorization, ADMIN_TOKEN) or _web_session_ok(request):
        return
    raise HTTPException(401, "Nicht angemeldet")


def require_device(authorization: Optional[str] = Header(None)):
    if not _bearer_ok(authorization, DEVICE_TOKEN):
        raise HTTPException(401, "Ungültiges Token")


def require_any(request: Request, authorization: Optional[str] = Header(None)):
    if _bearer_ok(authorization, ADMIN_TOKEN, DEVICE_TOKEN) or _web_session_ok(request):
        return
    raise HTTPException(401, "Ungültiges Token")


# ----------------------------------------------------------------------- helpers

def get_settings(c) -> dict:
    s = dict(DEFAULT_SETTINGS)
    s.update(TEXT_SETTINGS)
    s["schedule"] = json.loads(json.dumps(DEFAULT_SCHEDULE))
    s["logo"] = None
    for row in c.execute("SELECT key, value FROM settings"):
        if row["key"] in DEFAULT_SETTINGS:
            s[row["key"]] = int(row["value"])
        elif row["key"] in TEXT_SETTINGS:
            s[row["key"]] = row["value"]
        elif row["key"] == "schedule":
            s["schedule"] = json.loads(row["value"])
        elif row["key"] == "logo":
            info = json.loads(row["value"])
            s["logo"] = {"sha256": info["sha256"], "mime": info["mime"], "size": info["size"]}
    return s


def is_laptop(device_row) -> bool:
    return device_row is not None and (device_row["platform"] or "android") != "android"


def _valid_time(t) -> str:
    try:
        h, m = str(t).split(":")
        h, m = int(h), int(m)
        if 0 <= h <= 23 and 0 <= m <= 59:
            return f"{h:02d}:{m:02d}"
    except ValueError:
        pass
    raise HTTPException(400, f"Ungültige Uhrzeit: {t}")


def clean_schedule(raw: dict) -> dict:
    days = raw.get("days") or []
    if len(days) != 7:
        raise HTTPException(400, "Zeitplan braucht genau 7 Wochentage")
    return {
        "enabled": bool(raw.get("enabled")),
        "days": [{"active": bool(d.get("active")), "on": _valid_time(d.get("on")), "off": _valid_time(d.get("off"))}
                 for d in days],
    }


def media_dict(row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "type": row["type"],
        "mime": row["mime"],
        "size": row["size"],
        "sha256": row["sha256"],
        "duration_s": row["duration_s"],
        "created_at": row["created_at"],
    }


def playlist_dict(c, row) -> dict:
    ids = [r["media_id"] for r in c.execute(
        "SELECT media_id FROM playlist_items WHERE playlist_id=? ORDER BY position", (row["id"],))]
    return {
        "id": row["id"],
        "name": row["name"],
        "is_default": bool(row["is_default"]),
        "show_specs": bool(row["show_specs"]),
        "media_ids": ids,
    }


def resolve_playlist(c, device_row):
    """Playlist eines Geräts: zugewiesen -> Standard-Playlist -> alle Medien."""
    pl = None
    if device_row is not None and device_row["playlist_id"] is not None:
        pl = c.execute("SELECT * FROM playlists WHERE id=?", (device_row["playlist_id"],)).fetchone()
    if pl is None:
        pl = c.execute("SELECT * FROM playlists WHERE is_default=1 ORDER BY id LIMIT 1").fetchone()
    if pl is None:
        rows = c.execute("SELECT * FROM media ORDER BY created_at").fetchall()
        return None, rows, True
    rows = c.execute(
        """SELECT m.* FROM playlist_items pi JOIN media m ON m.id = pi.media_id
           WHERE pi.playlist_id=? ORDER BY pi.position""", (pl["id"],)).fetchall()
    return pl, rows, bool(pl["show_specs"])


def parse_custom_specs(text: str) -> list:
    specs = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if ":" in line:
            label, value = line.split(":", 1)
            specs.append({"label": label.strip(), "value": value.strip()})
        else:
            specs.append({"label": "", "value": line})
    return specs


def build_manifest(c, device_row) -> dict:
    s = get_settings(c)
    pl, rows, pl_show_specs = resolve_playlist(c, device_row)
    items = []
    for r in rows:
        items.append({
            "id": r["id"],
            "type": r["type"],
            "mime": r["mime"],
            "size": r["size"],
            "sha256": r["sha256"],
            "duration_s": r["duration_s"] or s["image_duration_s"],
            "url": f"/api/media/{r['id']}/file",
        })
    custom = parse_custom_specs(device_row["custom_specs"]) if device_row else []
    auto = json.loads(device_row["auto_specs"]) if device_row else []
    display_name = (device_row["display_name"] if device_row else None) or \
                   (device_row["marketing_name"] if device_row else None) or \
                   (device_row["model"] if device_row else "")
    manifest = {
        "playlist_name": pl["name"] if pl else "Alle Medien",
        "items": items,
        "display_name": display_name,
        "manufacturer": device_row["manufacturer"] if device_row else "",
        "specs": custom or auto,
        "show_specs": bool(device_row["show_specs"]) and pl_show_specs if device_row else pl_show_specs,
        "specs_every_n": s["specs_every_n"],
        "specs_duration_s": s["specs_duration_s"],
        "sync_interval_min": s["sync_interval_min"],
        "idle_timeout_s": s["idle_timeout_s"],
        "schedule": s["schedule"],
        "cleanup_interval_h": s["cleanup_interval_h"],
        "heartbeat_interval_s": HEARTBEAT_INTERVAL_S,
    }
    if is_laptop(device_row):
        # Nur für Laptops: Handy-Manifeste (und damit deren Hash) bleiben unverändert
        logo = s["logo"]
        manifest.update({
            "platform": device_row["platform"],
            "idle_timeout_s": s["laptop_idle_timeout_s"],
            "store_name": s["store_name"],
            "logo_url": "/api/logo" if logo else "",
            "logo_sha256": logo["sha256"] if logo else "",
            "logo_mime": logo["mime"] if logo else "",
            "web_filter": s["web_filter"],
            "blocked_domains": clean_domains(s["blocked_domains"]),
        })
    manifest["hash"] = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()[:16]
    return manifest


def make_thumbnail(media_id: str, path: Path, mtype: str):
    out = THUMB_DIR / f"{media_id}.jpg"
    if not shutil.which("ffmpeg"):
        return
    args = ["ffmpeg", "-y", "-loglevel", "error"]
    if mtype == "video":
        args += ["-ss", "1", "-i", str(path), "-frames:v", "1"]
    else:
        args += ["-i", str(path)]
    args += ["-vf", "scale=360:-2", str(out)]
    try:
        subprocess.run(args, timeout=60, check=True)
    except Exception:
        if mtype == "video":  # sehr kurze Videos: ersten Frame nehmen
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-frames:v", "1",
                            "-vf", "scale=360:-2", str(out)], timeout=60)


# ------------------------------------------------------------------------ public

@app.get("/api/health")
def health():
    return {"ok": True, "time": time.time()}


@app.get("/api/media/{media_id}/file", dependencies=[Depends(require_any)])
def media_file(media_id: str):
    with db() as c:
        row = c.execute("SELECT * FROM media WHERE id=?", (media_id,)).fetchone()
    if not row:
        raise HTTPException(404)
    return FileResponse(MEDIA_DIR / row["filename"], media_type=row["mime"])


@app.get("/api/media/{media_id}/thumb", dependencies=[Depends(require_any)])
def media_thumb(media_id: str):
    with db() as c:
        row = c.execute("SELECT * FROM media WHERE id=?", (media_id,)).fetchone()
    if not row:
        raise HTTPException(404)
    thumb = THUMB_DIR / f"{media_id}.jpg"
    if thumb.exists():
        return FileResponse(thumb, media_type="image/jpeg")
    if row["type"] == "image":
        return FileResponse(MEDIA_DIR / row["filename"], media_type=row["mime"])
    raise HTTPException(404)


@app.get("/api/logo", dependencies=[Depends(require_any)])
def store_logo():
    """Laden-Logo (für die Laptop-Demo, Webseite und Admin-App)."""
    with db() as c:
        row = c.execute("SELECT value FROM settings WHERE key='logo'").fetchone()
    if not row:
        raise HTTPException(404, "Kein Logo hochgeladen")
    info = json.loads(row["value"])
    # SVG darf keine Skripte ausführen, falls jemand die Adresse direkt im Browser öffnet
    return FileResponse(LOGO_DIR / info["filename"], media_type=info["mime"],
                        headers={"Cache-Control": "no-cache", "Content-Security-Policy": "script-src 'none'"})


# ------------------------------------------------------------------------- admin

@app.get("/api/admin/media", dependencies=[Depends(require_admin)])
def list_media():
    with db() as c:
        return [media_dict(r) for r in c.execute("SELECT * FROM media ORDER BY created_at DESC")]


def _media_type(mime: str, filename: str) -> tuple[str, str]:
    if not mime.startswith(("video/", "image/")):
        mime = mimetypes.guess_type(filename or "")[0] or mime
    if mime.startswith("video/"):
        return "video", mime
    if mime.startswith("image/"):
        return "image", mime
    raise HTTPException(400, f"Nur Videos und Bilder erlaubt (bekommen: {mime or 'unbekannt'})")


def _register_media(tmp: Path, orig_name: str, mime: str, title: str) -> dict:
    """Fertig hochgeladene Datei in die Mediathek übernehmen."""
    mtype, mime = _media_type(mime, orig_name)
    media_id = uuid.uuid4().hex
    ext = Path(orig_name or "").suffix.lower() or mimetypes.guess_extension(mime) or ""
    filename = media_id + ext
    dest = MEDIA_DIR / filename
    sha = hashlib.sha256()
    size = 0
    with open(tmp, "rb") as f:
        while chunk := f.read(1024 * 1024):
            sha.update(chunk)
            size += len(chunk)
    shutil.move(str(tmp), dest)
    make_thumbnail(media_id, dest, mtype)
    title = title.strip() or Path(orig_name or filename).stem
    with db() as c:
        c.execute(
            "INSERT INTO media (id, title, filename, type, mime, size, sha256, duration_s, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (media_id, title, filename, mtype, mime, size, sha.hexdigest(), None, time.time()))
        return media_dict(c.execute("SELECT * FROM media WHERE id=?", (media_id,)).fetchone())


def _add_to_playlists(media_id: str, playlist_ids: list[int]):
    with db() as c:
        for pid in playlist_ids:
            if not c.execute("SELECT 1 FROM playlists WHERE id=?", (pid,)).fetchone():
                continue
            pos = c.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_items WHERE playlist_id=?",
                            (pid,)).fetchone()[0]
            c.execute("INSERT INTO playlist_items (playlist_id, position, media_id) VALUES (?,?,?)",
                      (pid, pos, media_id))


@app.post("/api/admin/media", dependencies=[Depends(require_admin)])
def upload_media(file: UploadFile = File(...), title: str = Form("")):
    _media_type(file.content_type or "", file.filename or "")  # früh ablehnen
    tmp = UPLOAD_DIR / (uuid.uuid4().hex + ".part")
    with open(tmp, "wb") as out:
        while chunk := file.file.read(1024 * 1024):
            out.write(chunk)
    return _register_media(tmp, file.filename or "", file.content_type or "", title)


# Upload in Stücken (für die Webseite): umgeht die 100-MB-Grenze von Cloudflare pro Anfrage
class UploadInit(BaseModel):
    filename: str
    size: int
    mime: str = ""
    kind: str = "media"  # "media" oder "apk" (App-Update der Demo-App)


class UploadComplete(BaseModel):
    title: str = ""
    playlist_ids: list[int] = []


def _upload_paths(upload_id: str) -> tuple[Path, Path]:
    if not upload_id.isalnum():
        raise HTTPException(400, "Ungültige Upload-ID")
    return UPLOAD_DIR / f"{upload_id}.part", UPLOAD_DIR / f"{upload_id}.json"


@app.post("/api/admin/uploads", dependencies=[Depends(require_admin)])
def upload_init(body: UploadInit):
    if body.kind == "apk":
        if not body.filename.lower().endswith(".apk"):
            raise HTTPException(400, "Bitte eine .apk-Datei auswählen")
    else:
        _media_type(body.mime, body.filename)
    upload_id = uuid.uuid4().hex
    part, meta = _upload_paths(upload_id)
    part.touch()
    meta.write_text(json.dumps(body.model_dump()))
    return {"id": upload_id}


@app.put("/api/admin/uploads/{upload_id}", dependencies=[Depends(require_admin)])
async def upload_chunk(upload_id: str, offset: int, request: Request):
    part, meta = _upload_paths(upload_id)
    if not meta.exists():
        raise HTTPException(404, "Upload unbekannt")
    current = part.stat().st_size
    if offset != current:
        # z. B. nach Verbindungsabbruch: Client erfährt, wo es weitergeht
        raise HTTPException(409, f"Erwartet Offset {current}")
    with open(part, "ab") as f:
        async for chunk in request.stream():
            f.write(chunk)
    return {"received": part.stat().st_size}


@app.post("/api/admin/uploads/{upload_id}/complete", dependencies=[Depends(require_admin)])
def upload_complete(upload_id: str, body: UploadComplete):
    part, meta = _upload_paths(upload_id)
    if not meta.exists():
        raise HTTPException(404, "Upload unbekannt")
    info = json.loads(meta.read_text())
    if part.stat().st_size != info["size"]:
        raise HTTPException(400, "Datei unvollständig")
    if info.get("kind") == "apk":
        release = _register_app_release(part)
        meta.unlink(missing_ok=True)
        return release
    item = _register_media(part, info["filename"], info["mime"], body.title)
    meta.unlink(missing_ok=True)
    _add_to_playlists(item["id"], body.playlist_ids)
    return item


@app.delete("/api/admin/uploads/{upload_id}", dependencies=[Depends(require_admin)])
def upload_abort(upload_id: str):
    for p in _upload_paths(upload_id):
        p.unlink(missing_ok=True)
    return {"ok": True}


def _cleanup_stale_uploads():
    for p in UPLOAD_DIR.iterdir():
        if time.time() - p.stat().st_mtime > 24 * 3600:
            p.unlink(missing_ok=True)


_cleanup_stale_uploads()


class MediaPatch(BaseModel):
    title: Optional[str] = None
    duration_s: Optional[int] = None


@app.patch("/api/admin/media/{media_id}", dependencies=[Depends(require_admin)])
def patch_media(media_id: str, body: MediaPatch):
    with db() as c:
        row = c.execute("SELECT * FROM media WHERE id=?", (media_id,)).fetchone()
        if not row:
            raise HTTPException(404)
        if body.title is not None:
            c.execute("UPDATE media SET title=? WHERE id=?", (body.title.strip(), media_id))
        if body.duration_s is not None:
            c.execute("UPDATE media SET duration_s=? WHERE id=?", (max(1, body.duration_s), media_id))
        return media_dict(c.execute("SELECT * FROM media WHERE id=?", (media_id,)).fetchone())


@app.delete("/api/admin/media/{media_id}", dependencies=[Depends(require_admin)])
def delete_media(media_id: str):
    with db() as c:
        row = c.execute("SELECT * FROM media WHERE id=?", (media_id,)).fetchone()
        if not row:
            raise HTTPException(404)
        c.execute("DELETE FROM media WHERE id=?", (media_id,))
        # Lücken in den Positionen sind egal, Reihenfolge bleibt erhalten
    (MEDIA_DIR / row["filename"]).unlink(missing_ok=True)
    (THUMB_DIR / f"{media_id}.jpg").unlink(missing_ok=True)
    return {"ok": True}


class PlaylistBody(BaseModel):
    name: Optional[str] = None
    media_ids: Optional[list[str]] = None
    is_default: Optional[bool] = None
    show_specs: Optional[bool] = None


@app.get("/api/admin/playlists", dependencies=[Depends(require_admin)])
def list_playlists():
    with db() as c:
        return [playlist_dict(c, r) for r in c.execute("SELECT * FROM playlists ORDER BY id")]


def _save_playlist(c, pid: int, body: PlaylistBody):
    if body.name is not None:
        c.execute("UPDATE playlists SET name=? WHERE id=?", (body.name.strip() or "Playlist", pid))
    if body.show_specs is not None:
        c.execute("UPDATE playlists SET show_specs=? WHERE id=?", (int(body.show_specs), pid))
    if body.is_default is not None:
        if body.is_default:
            c.execute("UPDATE playlists SET is_default=0")
        c.execute("UPDATE playlists SET is_default=? WHERE id=?", (int(body.is_default), pid))
    if body.media_ids is not None:
        c.execute("DELETE FROM playlist_items WHERE playlist_id=?", (pid,))
        existing = {r["id"] for r in c.execute("SELECT id FROM media")}
        pos = 0
        for mid in body.media_ids:
            if mid in existing:
                c.execute("INSERT INTO playlist_items (playlist_id, position, media_id) VALUES (?,?,?)",
                          (pid, pos, mid))
                pos += 1


@app.post("/api/admin/playlists", dependencies=[Depends(require_admin)])
def create_playlist(body: PlaylistBody):
    with db() as c:
        first = c.execute("SELECT COUNT(*) FROM playlists").fetchone()[0] == 0
        cur = c.execute("INSERT INTO playlists (name) VALUES (?)", ((body.name or "Neue Playlist").strip(),))
        pid = cur.lastrowid
        if first and body.is_default is None:
            body.is_default = True
        _save_playlist(c, pid, body)
        return playlist_dict(c, c.execute("SELECT * FROM playlists WHERE id=?", (pid,)).fetchone())


@app.put("/api/admin/playlists/{pid}", dependencies=[Depends(require_admin)])
def update_playlist(pid: int, body: PlaylistBody):
    with db() as c:
        if not c.execute("SELECT 1 FROM playlists WHERE id=?", (pid,)).fetchone():
            raise HTTPException(404)
        _save_playlist(c, pid, body)
        return playlist_dict(c, c.execute("SELECT * FROM playlists WHERE id=?", (pid,)).fetchone())


@app.delete("/api/admin/playlists/{pid}", dependencies=[Depends(require_admin)])
def delete_playlist(pid: int):
    with db() as c:
        c.execute("DELETE FROM playlists WHERE id=?", (pid,))
    return {"ok": True}


def device_dict(c, row, settings) -> dict:
    manifest = build_manifest(c, row)
    now = time.time()
    online = row["last_seen"] is not None and now - row["last_seen"] < ONLINE_WINDOW_S
    return {
        "id": row["id"],
        "display_name": row["display_name"] or "",
        "effective_name": manifest["display_name"],
        "manufacturer": row["manufacturer"],
        "model": row["model"],
        "marketing_name": row["marketing_name"],
        "android_version": row["android_version"],
        "platform": row["platform"],
        "app_version": row["app_version"],
        "app_version_code": row["app_version_code"],
        "update_ready": row["update_ready"],
        "auto_specs": json.loads(row["auto_specs"]),
        "custom_specs": row["custom_specs"],
        "show_specs": bool(row["show_specs"]),
        "playlist_id": row["playlist_id"],
        "playlist_name": manifest["playlist_name"],
        "status": row["status"],
        "last_error": row["last_error"],
        "battery": row["battery"],
        "ip": row["ip"],
        "online": online,
        "up_to_date": row["synced_hash"] == manifest["hash"],
        "sync_requested": bool(row["sync_requested"]),
        "last_seen": row["last_seen"],
        "last_sync": row["last_sync"],
    }


@app.get("/api/admin/devices", dependencies=[Depends(require_admin)])
def list_devices():
    with db() as c:
        s = get_settings(c)
        return [device_dict(c, r, s)
                for r in c.execute("SELECT * FROM devices WHERE removed=0 ORDER BY created_at")]


class DevicePatch(BaseModel):
    display_name: Optional[str] = None
    custom_specs: Optional[str] = None
    show_specs: Optional[bool] = None
    playlist_id: Optional[int] = None
    clear_playlist: bool = False


@app.patch("/api/admin/devices/{device_id}", dependencies=[Depends(require_admin)])
def patch_device(device_id: str, body: DevicePatch):
    with db() as c:
        if not c.execute("SELECT 1 FROM devices WHERE id=?", (device_id,)).fetchone():
            raise HTTPException(404)
        if body.display_name is not None:
            c.execute("UPDATE devices SET display_name=? WHERE id=?", (body.display_name.strip(), device_id))
        if body.custom_specs is not None:
            c.execute("UPDATE devices SET custom_specs=? WHERE id=?", (body.custom_specs, device_id))
        if body.show_specs is not None:
            c.execute("UPDATE devices SET show_specs=? WHERE id=?", (int(body.show_specs), device_id))
        if body.clear_playlist:
            c.execute("UPDATE devices SET playlist_id=NULL WHERE id=?", (device_id,))
        elif body.playlist_id is not None:
            c.execute("UPDATE devices SET playlist_id=? WHERE id=?", (body.playlist_id, device_id))
        row = c.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
        return device_dict(c, row, get_settings(c))


@app.post("/api/admin/devices/{device_id}/sync-now", dependencies=[Depends(require_admin)])
def request_sync(device_id: str):
    with db() as c:
        c.execute("UPDATE devices SET sync_requested=1 WHERE id=?", (device_id,))
    return {"ok": True}


@app.post("/api/admin/devices/sync-all", dependencies=[Depends(require_admin)])
def request_sync_all():
    with db() as c:
        c.execute("UPDATE devices SET sync_requested=1")
    return {"ok": True}


@app.delete("/api/admin/devices/{device_id}", dependencies=[Depends(require_admin)])
def delete_device(device_id: str):
    with db() as c:
        c.execute("DELETE FROM devices WHERE id=?", (device_id,))
    return {"ok": True}


@app.get("/api/admin/settings", dependencies=[Depends(require_admin)])
def read_settings():
    with db() as c:
        return get_settings(c)


@app.put("/api/admin/settings", dependencies=[Depends(require_admin)])
def write_settings(body: dict):
    # Sperrliste vor dem Datenbankzugriff säubern: eine lange Liste darf nie die Datenbank blockieren
    if isinstance(body.get("blocked_domains"), str):
        body["blocked_domains"] = "\n".join(clean_domains(body["blocked_domains"][:20_000_000]))
    with db() as c:
        for k, v in body.items():
            if k in DEFAULT_SETTINGS:
                c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)",
                          (k, str(max(0 if k in ZERO_ALLOWED else 1, int(v)))))
            elif k == "web_filter" and isinstance(v, str):
                if v not in WEB_FILTER_MODES:
                    raise HTTPException(400, "Unbekannte Filterstufe")
                c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", (k, v))
            elif k == "blocked_domains" and isinstance(v, str):
                c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", (k, v))
            elif k in TEXT_SETTINGS and isinstance(v, str):
                c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", (k, v.strip()[:80]))
            elif k == "schedule" and isinstance(v, dict):
                c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('schedule', ?)",
                          (json.dumps(clean_schedule(v)),))
        return get_settings(c)


LOGO_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
              ".svg": "image/svg+xml", ".gif": "image/gif"}


@app.post("/api/admin/logo", dependencies=[Depends(require_admin)])
def upload_logo(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in LOGO_TYPES:
        mime_ext = {v: k for k, v in LOGO_TYPES.items()}.get(file.content_type or "")
        if not mime_ext:
            raise HTTPException(400, "Bitte ein Bild als PNG, JPG, WebP, GIF oder SVG hochladen")
        ext = mime_ext
    data = file.file.read(LOGO_MAX_BYTES + 1)
    if len(data) > LOGO_MAX_BYTES:
        raise HTTPException(400, "Das Logo darf höchstens 10 MB groß sein")
    if not data:
        raise HTTPException(400, "Leere Datei")
    sha = hashlib.sha256(data).hexdigest()
    filename = f"logo-{sha[:12]}{ext}"
    (LOGO_DIR / filename).write_bytes(data)
    info = {"filename": filename, "mime": LOGO_TYPES[ext], "sha256": sha, "size": len(data)}
    with db() as c:
        c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('logo', ?)", (json.dumps(info),))
    for old in LOGO_DIR.iterdir():
        if old.name != filename:
            old.unlink(missing_ok=True)
    return {"sha256": sha, "mime": info["mime"], "size": len(data)}


@app.delete("/api/admin/logo", dependencies=[Depends(require_admin)])
def delete_logo():
    with db() as c:
        c.execute("DELETE FROM settings WHERE key='logo'")
    for old in LOGO_DIR.iterdir():
        old.unlink(missing_ok=True)
    return {"ok": True}


# ------------------------------------------------------------------------ device

class DeviceReport(BaseModel):
    device_id: str
    manufacturer: str = ""
    model: str = ""
    marketing_name: str = ""
    android_version: str = ""
    app_version: str = ""
    specs: list[dict] = []
    synced_hash: Optional[str] = None
    status: Optional[str] = None
    error: Optional[str] = None
    battery: Optional[int] = None
    # Laptop-Demo: "windows" / "macos" / "linux" und Betriebssystem-Version (Handys: "android")
    platform: str = "android"
    os_version: str = ""
    # Frühere ID desselben Geräts (ältere App-Versionen nutzten eine Zufalls-ID)
    previous_id: Optional[str] = None
    # Demo-App: installierte Versionsnummer und ggf. schon heruntergeladenes Update (Versionsnummer)
    app_version_code: Optional[int] = None
    update_ready: Optional[int] = None


def _upsert_device(c, r: DeviceReport, ip: Optional[str], full_sync: bool):
    now = time.time()
    platform = (r.platform or "android").strip().lower()[:20]
    os_version = r.android_version or r.os_version
    row = c.execute("SELECT * FROM devices WHERE id=?", (r.device_id,)).fetchone()
    if row is None and r.previous_id and r.previous_id != r.device_id:
        # Gerät hat auf die dauerhafte ID umgestellt: Eintrag (Name, Playlist, Specs) übernehmen
        c.execute("UPDATE devices SET id=? WHERE id=?", (r.device_id, r.previous_id))
        row = c.execute("SELECT * FROM devices WHERE id=?", (r.device_id,)).fetchone()
    if row is None:
        c.execute(
            "INSERT INTO devices (id, manufacturer, model, marketing_name, android_version, app_version,"
            " auto_specs, platform, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (r.device_id, r.manufacturer, r.model, r.marketing_name, os_version, r.app_version,
             json.dumps(r.specs), platform, now))
    else:
        c.execute(
            "UPDATE devices SET manufacturer=?, model=?, marketing_name=?, android_version=?, app_version=?,"
            " platform=?" + (", auto_specs=?" if r.specs else "") + " WHERE id=?",
            (r.manufacturer, r.model, r.marketing_name, os_version, r.app_version, platform)
            + ((json.dumps(r.specs),) if r.specs else ()) + (r.device_id,))
    c.execute(
        "UPDATE devices SET last_seen=?, status=?, last_error=?, battery=?, ip=?,"
        " synced_hash=COALESCE(?, synced_hash), removed=0,"
        " app_version_code=COALESCE(?, app_version_code), update_ready=? WHERE id=?",
        (now, r.status, r.error, r.battery, ip, r.synced_hash, r.app_version_code, r.update_ready, r.device_id))
    if full_sync:
        c.execute("UPDATE devices SET last_sync=?, sync_requested=0 WHERE id=?", (now, r.device_id))
    return c.execute("SELECT * FROM devices WHERE id=?", (r.device_id,)).fetchone()


@app.post("/api/device/sync", dependencies=[Depends(require_device)])
def device_sync(report: DeviceReport, x_forwarded_for: Optional[str] = Header(None)):
    """Stündlicher Abgleich: liefert die vollständige Playlist (Manifest)."""
    with db() as c:
        row = _upsert_device(c, report, x_forwarded_for, full_sync=True)
        return {**build_manifest(c, row), "app_update": _pushed_update_for(row)}


@app.post("/api/device/heartbeat", dependencies=[Depends(require_device)])
def device_heartbeat(report: DeviceReport, x_forwarded_for: Optional[str] = Header(None)):
    """Alle paar Minuten: nur Online-Status. sync_now=True wenn der Admin 'Jetzt aktualisieren' gedrückt hat."""
    with db() as c:
        row = _upsert_device(c, report, x_forwarded_for, full_sync=False)
        return {"sync_now": bool(row["sync_requested"]), "heartbeat_interval_s": HEARTBEAT_INTERVAL_S,
                "app_update": _pushed_update_for(row)}


class Unregister(BaseModel):
    device_id: str


@app.post("/api/device/unregister", dependencies=[Depends(require_device)])
def device_unregister(body: Unregister):
    """Wird vor dem Deinstallieren der Demo-App aufgerufen. Einstellungen bleiben für eine Neuinstallation erhalten."""
    with db() as c:
        c.execute("UPDATE devices SET removed=1 WHERE id=?", (body.device_id,))
    return {"ok": True}


# --------------------------------------------------------------------------- web

_login_failures: dict[str, list[float]] = {}
MAX_FAILURES = 5
LOCK_MINUTES = 15


def _client_ip(request: Request) -> str:
    return (request.headers.get("cf-connecting-ip")
            or (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
            or (request.client.host if request.client else "?"))


class Login(BaseModel):
    username: str
    password: str


class WebSetup(BaseModel):
    admin_token: str
    username: str
    password: str


class PasswordChange(BaseModel):
    old_password: str
    new_password: str


def _hash_password(password: str, salt: Optional[bytes] = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 300_000)
    return f"pbkdf2${salt.hex()}${digest.hex()}"


def _check_password(password: str, stored: str) -> bool:
    try:
        _, salt, _ = stored.split("$")
    except ValueError:
        return False
    return secrets.compare_digest(_hash_password(password, bytes.fromhex(salt)), stored)


def _web_credentials() -> tuple[str, Optional[str], bool]:
    """(Benutzer, Passwort-Hash oder Klartext, kommt aus .env?)"""
    if WEB_PASSWORD:
        return WEB_USER, WEB_PASSWORD, True
    with db() as c:
        rows = {r["key"]: r["value"] for r in c.execute(
            "SELECT key, value FROM settings WHERE key IN ('web_user', 'web_password_hash')")}
    return rows.get("web_user", ""), rows.get("web_password_hash"), False


def _check_rate_limit(request: Request) -> tuple[str, list[float]]:
    ip = _client_ip(request)
    now = time.time()
    fails = [t for t in _login_failures.get(ip, []) if now - t < LOCK_MINUTES * 60]
    if len(fails) >= MAX_FAILURES:
        raise HTTPException(429, f"Zu viele Fehlversuche. Bitte {LOCK_MINUTES} Minuten warten.")
    return ip, fails


def _fail(ip: str, fails: list[float], message: str):
    fails.append(time.time())
    _login_failures[ip] = fails
    time.sleep(0.7)
    raise HTTPException(401, message)


def _start_session(request: Request, response: Response):
    now = time.time()
    token = secrets.token_urlsafe(32)
    with db() as c:
        c.execute("DELETE FROM web_sessions WHERE expires < ?", (now,))
        c.execute("INSERT INTO web_sessions (token_hash, expires) VALUES (?,?)",
                  (_hash_token(token), now + SESSION_DAYS * 86400))
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True,
                        samesite="strict", secure=secure, path="/")


@app.get("/api/web/status")
def web_status():
    user, secret, from_env = _web_credentials()
    return {"setup_required": not secret, "managed_by_env": from_env}


@app.post("/api/web/login")
def web_login(body: Login, request: Request, response: Response):
    user, secret, from_env = _web_credentials()
    if not secret:
        raise HTTPException(409, "Noch kein Passwort eingerichtet")
    ip, fails = _check_rate_limit(request)
    ok_user = secrets.compare_digest(body.username.strip().lower(), user.lower())
    ok_pass = secrets.compare_digest(body.password, secret) if from_env else _check_password(body.password, secret)
    if not (ok_user and ok_pass):
        _fail(ip, fails, "Benutzername oder Passwort falsch")
    _login_failures.pop(ip, None)
    _start_session(request, response)
    return {"ok": True, "user": user}


@app.post("/api/web/setup")
def web_setup(body: WebSetup, request: Request, response: Response):
    """Ersteinrichtung bzw. Passwort zurücksetzen – nur mit dem Admin-Token möglich."""
    if WEB_PASSWORD:
        raise HTTPException(409, "Das Passwort ist in der .env-Datei festgelegt (WEB_PASSWORD) und kann hier nicht geändert werden.")
    ip, fails = _check_rate_limit(request)
    if not ADMIN_TOKEN or not secrets.compare_digest(body.admin_token.strip(), ADMIN_TOKEN):
        _fail(ip, fails, "Admin-Token falsch")
    username = body.username.strip()
    if not username:
        raise HTTPException(400, "Bitte einen Benutzernamen angeben")
    if len(body.password) < 8:
        raise HTTPException(400, "Das Passwort muss mindestens 8 Zeichen lang sein")
    _login_failures.pop(ip, None)
    with db() as c:
        c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('web_user', ?)", (username,))
        c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('web_password_hash', ?)",
                  (_hash_password(body.password),))
        c.execute("DELETE FROM web_sessions")  # alte Anmeldungen ungültig machen
    _start_session(request, response)
    return {"ok": True, "user": username}


@app.post("/api/web/password")
def web_change_password(body: PasswordChange, request: Request):
    if not _web_session_ok(request):
        raise HTTPException(401, "Nicht angemeldet")
    user, secret, from_env = _web_credentials()
    if from_env:
        raise HTTPException(409, "Das Passwort ist in der .env-Datei festgelegt (WEB_PASSWORD).")
    if not _check_password(body.old_password, secret or ""):
        raise HTTPException(400, "Bisheriges Passwort ist falsch")
    if len(body.new_password) < 8:
        raise HTTPException(400, "Das neue Passwort muss mindestens 8 Zeichen lang sein")
    with db() as c:
        c.execute("UPDATE settings SET value=? WHERE key='web_password_hash'", (_hash_password(body.new_password),))
    return {"ok": True}


@app.post("/api/web/logout")
def web_logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        with db() as c:
            c.execute("DELETE FROM web_sessions WHERE token_hash=?", (_hash_token(token),))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@app.get("/api/web/me")
def web_me(request: Request):
    if not _web_session_ok(request):
        raise HTTPException(401, "Nicht angemeldet")
    user, _, from_env = _web_credentials()
    return {"user": user, "managed_by_env": from_env}


@app.get("/", include_in_schema=False)
def web_index():
    return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/logo.svg", include_in_schema=False)
def web_logo():
    return FileResponse(WEB_DIR / "logo.svg", media_type="image/svg+xml")


# ------------------------------------------------------------------ app-update

def _app_release() -> Optional[dict]:
    with db() as c:
        row = c.execute("SELECT value FROM settings WHERE key='app_release'").fetchone()
    if not row or not APP_APK.exists():
        return None
    return json.loads(row["value"])


def _register_app_release(tmp: Path) -> dict:
    try:
        info = read_apk_info(tmp)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, "Die Datei ist keine gültige APK")
    if info.get("package") != DEMO_PACKAGE:
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, f"Das ist nicht die Demo-App (Paket: {info.get('package')}). "
                                 "Bitte RetailDemo-Demo-….apk hochladen.")
    sha = hashlib.sha256()
    with open(tmp, "rb") as f:
        while chunk := f.read(1024 * 1024):
            sha.update(chunk)
    release = {
        "version_code": int(info["version_code"]),
        "version_name": str(info.get("version_name") or info["version_code"]),
        "size": tmp.stat().st_size,
        "sha256": sha.hexdigest(),
        "uploaded_at": time.time(),
    }
    shutil.move(str(tmp), APP_APK)
    with db() as c:
        c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('app_release', ?)", (json.dumps(release),))
    return release


def _rollout() -> Optional[int]:
    """Versionsnummer, die per "An alle Geräte verteilen" freigegeben wurde (oder None)."""
    with db() as c:
        row = c.execute("SELECT value FROM settings WHERE key='app_rollout'").fetchone()
    return int(row["value"]) if row else None


def _install_request() -> Optional[dict]:
    """"Jetzt auf allen Handys aktualisieren": {version_code, id} oder None."""
    with db() as c:
        row = c.execute("SELECT value FROM settings WHERE key='app_install_request'").fetchone()
    return json.loads(row["value"]) if row else None


def _pushed_update_for(device_row) -> Optional[dict]:
    """Update-Hinweis für ein Gerät: nur Handys, nur wenn verteilt und neuer als installiert."""
    if device_row is None or is_laptop(device_row):
        return None
    release = _app_release()
    if not release or _rollout() != release["version_code"]:
        return None
    installed = device_row["app_version_code"]
    if installed is not None and installed >= release["version_code"]:
        return None
    request = _install_request()
    install_request = request["id"] if request and request["version_code"] == release["version_code"] else None
    return {**release, "url": "/api/device/app-update/apk", "install_request": install_request}


@app.get("/api/admin/app-release", dependencies=[Depends(require_admin)])
def admin_app_release():
    release = _app_release()
    if not release:
        return {}
    with db() as c:
        phones = [r for r in c.execute("SELECT * FROM devices WHERE removed=0") if not is_laptop(r)]
    code = release["version_code"]
    return {
        **release,
        "rolled_out": _rollout() == code,
        "install_requested_at": (_install_request() or {}).get("id") if (_install_request() or {}).get("version_code") == code else None,
        "phones": len(phones),
        "up_to_date": sum(1 for r in phones if (r["app_version_code"] or 0) >= code),
        "ready": sum(1 for r in phones if (r["app_version_code"] or 0) < code and (r["update_ready"] or 0) >= code),
    }


@app.post("/api/admin/app-release/rollout", dependencies=[Depends(require_admin)])
def admin_rollout():
    """Alle Handys laden die aktuelle Version im Hintergrund herunter."""
    release = _app_release()
    if not release:
        raise HTTPException(400, "Zuerst eine APK hochladen")
    with db() as c:
        c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('app_rollout', ?)", (str(release["version_code"]),))
    return {"ok": True}


@app.post("/api/admin/app-release/install-now", dependencies=[Depends(require_admin)])
def admin_install_now():
    """Alle Handys zeigen (nach dem Herunterladen) sofort den Android-Dialog zum Aktualisieren."""
    release = _app_release()
    if not release:
        raise HTTPException(400, "Zuerst eine APK hochladen")
    with db() as c:
        c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('app_rollout', ?)", (str(release["version_code"]),))
        c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('app_install_request', ?)",
                  (json.dumps({"version_code": release["version_code"], "id": int(time.time())}),))
    return {"ok": True}


@app.delete("/api/admin/app-release/rollout", dependencies=[Depends(require_admin)])
def admin_stop_rollout():
    with db() as c:
        c.execute("DELETE FROM settings WHERE key IN ('app_rollout', 'app_install_request')")
    return {"ok": True}


@app.delete("/api/admin/app-release", dependencies=[Depends(require_admin)])
def admin_delete_app_release():
    APP_APK.unlink(missing_ok=True)
    with db() as c:
        c.execute("DELETE FROM settings WHERE key='app_release'")
    return {"ok": True}


@app.get("/api/device/app-update", dependencies=[Depends(require_device)])
def device_app_update():
    """Neueste Demo-App-Version auf dem Server (leer, wenn keine hochgeladen)."""
    release = _app_release()
    if not release:
        return {}
    return {**release, "url": "/api/device/app-update/apk"}


@app.get("/api/device/app-update/apk", dependencies=[Depends(require_device)])
def device_app_update_apk():
    if not APP_APK.exists():
        raise HTTPException(404, "Kein Update vorhanden")
    return FileResponse(APP_APK, media_type="application/vnd.android.package-archive",
                        filename="RetailDemo-Demo.apk")


# --------------------------------------------------------------------- overview

class SystemMonitor:
    """Misst alle 2 s CPU und RAM des (Proxmox-)Containers (Live-Anzeige) und speichert alle 15 s
    den Durchschnitt als Verlauf (eine Stunde)."""
    INTERVAL_S = 2
    HISTORY_STEP_S = 15

    def __init__(self):
        self.history: deque = deque(maxlen=3600 // self.HISTORY_STEP_S)
        self._last_cpu: Optional[tuple[int, int]] = None
        self._window: list[tuple[float, float]] = []
        self._window_start = time.time()
        self.cpu_percent = 0.0
        self.ram_percent = 0.0
        threading.Thread(target=self._loop, daemon=True).start()

    @staticmethod
    def _cpu_times() -> tuple[int, int]:
        fields = (HOST_PROC / "stat").read_text().splitlines()[0].split()[1:]
        values = [int(v) for v in fields]
        idle = values[3] + (values[4] if len(values) > 4 else 0)
        return sum(values[:8]), idle

    @staticmethod
    def memory() -> tuple[int, int]:
        info = {}
        for line in (HOST_PROC / "meminfo").read_text().splitlines():
            key, _, rest = line.partition(":")
            info[key] = int(rest.split()[0]) * 1024
        total = info.get("MemTotal", 0)
        available = info.get("MemAvailable", info.get("MemFree", 0))
        return total - available, total

    @staticmethod
    def cpu_count() -> int:
        try:
            text = (HOST_PROC / "stat").read_text()
            return max(1, sum(1 for line in text.splitlines() if line.startswith("cpu") and line[3:4].isdigit()))
        except OSError:
            return os.cpu_count() or 1

    def sample(self):
        total, idle = self._cpu_times()
        if self._last_cpu:
            dt, di = total - self._last_cpu[0], idle - self._last_cpu[1]
            self.cpu_percent = round(max(0.0, min(100.0, 100.0 * (dt - di) / dt)), 1) if dt > 0 else 0.0
        self._last_cpu = (total, idle)
        used, mem_total = self.memory()
        self.ram_percent = round(100.0 * used / mem_total, 1) if mem_total else 0.0
        self._window.append((self.cpu_percent, self.ram_percent))
        now = time.time()
        if now - self._window_start >= self.HISTORY_STEP_S or not self.history:
            n = len(self._window)
            self.history.append({
                "t": int(now),
                "cpu": round(sum(c for c, _ in self._window) / n, 1),
                "ram": round(sum(r for _, r in self._window) / n, 1),
            })
            self._window = []
            self._window_start = now

    def _loop(self):
        while True:
            try:
                self.sample()
            except Exception:
                pass
            time.sleep(self.INTERVAL_S)


monitor = SystemMonitor()


def _version_tuple(v: str) -> tuple:
    """"1.10.2" -> (1, 10, 2), damit 1.10 nach 1.9 kommt."""
    return tuple(int(x) if x.isdigit() else 0 for x in re.split(r"[.\-]", v or "0"))


def _status_group(status: Optional[str]) -> str:
    s = (status or "").lower()
    if s.startswith("pausiert"):
        return "paused"
    if s.startswith("kunde"):
        return "customer"
    if s.startswith("ruhezeit"):
        return "sleeping"
    if s.startswith("demo läuft") or s.startswith("gestartet"):
        return "running"
    return "other"


@app.get("/api/admin/overview", dependencies=[Depends(require_admin)])
def admin_overview(history: bool = True):
    """Übersicht. Die Webseite fragt alle 2 s mit history=false ab (schlank), den Verlauf seltener."""
    release = _app_release()
    counts = {"total": 0, "online": 0, "offline": 0, "running": 0, "paused": 0, "customer": 0,
              "sleeping": 0, "phones": 0, "laptops": 0, "outdated": 0, "phones_online": 0, "laptops_online": 0, "update_ready": 0}
    versions: dict[str, int] = {}
    with db() as c:
        s = get_settings(c)
        rows = c.execute("SELECT * FROM devices WHERE removed=0").fetchall()
        media = c.execute("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM media").fetchone()
        now = time.time()
        for row in rows:
            # Bewusst ohne device_dict(): das baut je Gerät die ganze Playlist (zu teuer für 2-s-Takt)
            d = {"online": row["last_seen"] is not None and now - row["last_seen"] < ONLINE_WINDOW_S,
                 "status": row["status"]}
            counts["total"] += 1
            counts["laptops" if is_laptop(row) else "phones"] += 1
            if not d["online"]:
                counts["offline"] += 1
                continue
            counts["online"] += 1
            group = _status_group(d["status"])
            if group in counts:
                counts[group] += 1

            if is_laptop(row):
                counts["laptops_online"] += 1
            else:
                counts["phones_online"] += 1
        for row in rows:
            if not is_laptop(row) and row["app_version"]:
                versions[row["app_version"]] = versions.get(row["app_version"], 0) + 1
                # Veraltet zählt auch, wenn das Gerät gerade offline ist
                if release and _version_tuple(row["app_version"]) < _version_tuple(release["version_name"]):
                    counts["outdated"] += 1
                    if (row["update_ready"] or 0) >= release["version_code"]:
                        counts["update_ready"] += 1
    used, total = SystemMonitor.memory()
    disk = shutil.disk_usage(DATA_DIR)
    try:
        uptime_s = int(float((HOST_PROC / "uptime").read_text().split()[0]))
    except (OSError, ValueError):
        uptime_s = None
    return {
        "devices": counts,
        "system": {
            "cpu_percent": monitor.cpu_percent,
            "ram_percent": monitor.ram_percent,
            "cpu_cores": SystemMonitor.cpu_count(),
            "ram_used": used,
            "ram_total": total,
            "disk_used": disk.used,
            "disk_total": disk.total,
            "uptime_s": uptime_s,
            "source": "proxmox" if HOST_PROC != Path("/proc") else "docker",
        },
        "media": {"count": media[0], "bytes": media[1]},
        "app_versions": dict(sorted(versions.items(), key=lambda kv: _version_tuple(kv[0]), reverse=True)),
        "history": list(monitor.history) if history else None,
        "history_last_t": monitor.history[-1]["t"] if monitor.history else None,
        "server_time": time.time(),
        "app_release": release,
        "rolled_out": bool(release) and _rollout() == release["version_code"],
    }
