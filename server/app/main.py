"""Retail Demo Server.

Speichert Medien (Videos/Bilder), Playlists und registrierte Demo-Geräte.
- Admin-App:  Authorization: Bearer <ADMIN_TOKEN>
- Demo-App:   Authorization: Bearer <DEVICE_TOKEN>
"""
import hashlib
import json
import mimetypes
import os
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

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
MEDIA_DIR = DATA_DIR / "media"
THUMB_DIR = DATA_DIR / "thumbs"
DB_PATH = DATA_DIR / "demo.db"
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
DEVICE_TOKEN = os.environ.get("DEVICE_TOKEN", "")

HEARTBEAT_INTERVAL_S = 300
DEFAULT_SETTINGS = {
    "sync_interval_min": 60,
    "idle_timeout_s": 30,
    "specs_every_n": 3,
    "specs_duration_s": 10,
    "image_duration_s": 8,
    "cleanup_interval_h": 2,
}
# Einstellungen, bei denen 0 "aus" bedeutet
ZERO_ALLOWED = {"cleanup_interval_h"}
WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
DEFAULT_SCHEDULE = {
    "enabled": False,
    "days": [{"active": i < 6, "on": "09:00", "off": "20:00"} for i in range(7)],
}

MEDIA_DIR.mkdir(parents=True, exist_ok=True)
THUMB_DIR.mkdir(parents=True, exist_ok=True)
_db_lock = threading.Lock()


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
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        version = c.execute("SELECT value FROM settings WHERE key='schema_version'").fetchone()
        if version is None:
            # v2: Standard-Wartezeit bis zum Neustart der Demo von 60 auf 30 Sekunden
            c.execute("UPDATE settings SET value='30' WHERE key='idle_timeout_s' AND value='60'")
            c.execute("INSERT INTO settings (key, value) VALUES ('schema_version', '2')")


init_db()
app = FastAPI(title="Retail Demo Server")


# --------------------------------------------------------------------------- auth

def _check(authorization: Optional[str], *tokens: str):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Token fehlt")
    given = authorization[7:]
    if not any(t and secrets.compare_digest(given, t) for t in tokens):
        raise HTTPException(401, "Ungültiges Token")


def require_admin(authorization: Optional[str] = Header(None)):
    _check(authorization, ADMIN_TOKEN)


def require_device(authorization: Optional[str] = Header(None)):
    _check(authorization, DEVICE_TOKEN)


def require_any(authorization: Optional[str] = Header(None)):
    _check(authorization, ADMIN_TOKEN, DEVICE_TOKEN)


# ----------------------------------------------------------------------- helpers

def get_settings(c) -> dict:
    s = dict(DEFAULT_SETTINGS)
    s["schedule"] = json.loads(json.dumps(DEFAULT_SCHEDULE))
    for row in c.execute("SELECT key, value FROM settings"):
        if row["key"] in DEFAULT_SETTINGS:
            s[row["key"]] = int(row["value"])
        elif row["key"] == "schedule":
            s["schedule"] = json.loads(row["value"])
    return s


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


# ------------------------------------------------------------------------- admin

@app.get("/api/admin/media", dependencies=[Depends(require_admin)])
def list_media():
    with db() as c:
        return [media_dict(r) for r in c.execute("SELECT * FROM media ORDER BY created_at DESC")]


@app.post("/api/admin/media", dependencies=[Depends(require_admin)])
def upload_media(file: UploadFile = File(...), title: str = Form("")):
    mime = file.content_type or ""
    if not mime.startswith(("video/", "image/")):
        mime = mimetypes.guess_type(file.filename or "")[0] or mime
    if mime.startswith("video/"):
        mtype = "video"
    elif mime.startswith("image/"):
        mtype = "image"
    else:
        raise HTTPException(400, f"Nur Videos und Bilder erlaubt (bekommen: {mime or 'unbekannt'})")
    media_id = uuid.uuid4().hex
    ext = Path(file.filename or "").suffix.lower() or mimetypes.guess_extension(mime) or ""
    filename = media_id + ext
    dest = MEDIA_DIR / filename
    sha = hashlib.sha256()
    size = 0
    with open(dest, "wb") as out:
        while chunk := file.file.read(1024 * 1024):
            sha.update(chunk)
            size += len(chunk)
            out.write(chunk)
    make_thumbnail(media_id, dest, mtype)
    title = title.strip() or Path(file.filename or filename).stem
    with db() as c:
        c.execute(
            "INSERT INTO media (id, title, filename, type, mime, size, sha256, duration_s, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (media_id, title, filename, mtype, mime, size, sha.hexdigest(), None, time.time()))
        return media_dict(c.execute("SELECT * FROM media WHERE id=?", (media_id,)).fetchone())


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
    online = row["last_seen"] is not None and now - row["last_seen"] < HEARTBEAT_INTERVAL_S * 2 + 60
    return {
        "id": row["id"],
        "display_name": row["display_name"] or "",
        "effective_name": manifest["display_name"],
        "manufacturer": row["manufacturer"],
        "model": row["model"],
        "marketing_name": row["marketing_name"],
        "android_version": row["android_version"],
        "app_version": row["app_version"],
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
        return [device_dict(c, r, s) for r in c.execute("SELECT * FROM devices ORDER BY created_at")]


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
    with db() as c:
        for k, v in body.items():
            if k in DEFAULT_SETTINGS:
                c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)",
                          (k, str(max(0 if k in ZERO_ALLOWED else 1, int(v)))))
            elif k == "schedule" and isinstance(v, dict):
                c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('schedule', ?)",
                          (json.dumps(clean_schedule(v)),))
        return get_settings(c)


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


def _upsert_device(c, r: DeviceReport, ip: Optional[str], full_sync: bool):
    now = time.time()
    row = c.execute("SELECT * FROM devices WHERE id=?", (r.device_id,)).fetchone()
    if row is None:
        c.execute(
            "INSERT INTO devices (id, manufacturer, model, marketing_name, android_version, app_version,"
            " auto_specs, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (r.device_id, r.manufacturer, r.model, r.marketing_name, r.android_version, r.app_version,
             json.dumps(r.specs), now))
    else:
        c.execute(
            "UPDATE devices SET manufacturer=?, model=?, marketing_name=?, android_version=?, app_version=?"
            + (", auto_specs=?" if r.specs else "") + " WHERE id=?",
            (r.manufacturer, r.model, r.marketing_name, r.android_version, r.app_version)
            + ((json.dumps(r.specs),) if r.specs else ()) + (r.device_id,))
    c.execute(
        "UPDATE devices SET last_seen=?, status=?, last_error=?, battery=?, ip=?,"
        " synced_hash=COALESCE(?, synced_hash) WHERE id=?",
        (now, r.status, r.error, r.battery, ip, r.synced_hash, r.device_id))
    if full_sync:
        c.execute("UPDATE devices SET last_sync=?, sync_requested=0 WHERE id=?", (now, r.device_id))
    return c.execute("SELECT * FROM devices WHERE id=?", (r.device_id,)).fetchone()


@app.post("/api/device/sync", dependencies=[Depends(require_device)])
def device_sync(report: DeviceReport, x_forwarded_for: Optional[str] = Header(None)):
    """Stündlicher Abgleich: liefert die vollständige Playlist (Manifest)."""
    with db() as c:
        row = _upsert_device(c, report, x_forwarded_for, full_sync=True)
        return build_manifest(c, row)


@app.post("/api/device/heartbeat", dependencies=[Depends(require_device)])
def device_heartbeat(report: DeviceReport, x_forwarded_for: Optional[str] = Header(None)):
    """Alle paar Minuten: nur Online-Status. sync_now=True wenn der Admin 'Jetzt aktualisieren' gedrückt hat."""
    with db() as c:
        row = _upsert_device(c, report, x_forwarded_for, full_sync=False)
        return {"sync_now": bool(row["sync_requested"]), "heartbeat_interval_s": HEARTBEAT_INTERVAL_S}
