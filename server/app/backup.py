"""Backups: Datenbank, Einstellungen, 3D-Druck, Video-Schnitt usw. – auf Wunsch mit allen Medien.

- Automatisch jeden Tag zur eingestellten Uhrzeit, die letzten N bleiben erhalten
- Ablage in BACKUP_DIR (docker-compose: Ordner ./backups neben ./data, auch auf ein NAS umstellbar)
- Download über die Webseite, Wiederherstellen aus der Liste oder aus einer hochgeladenen Datei
"""
import json
import os
import re
import shutil
import sqlite3
import tarfile
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

NAME_RE = re.compile(r"^retaildemo-backup-\d{8}-\d{6}(-medien)?\.tar\.gz$")
# nie sichern: Zwischendateien, Backups selbst
SKIP_TOP = {"backups", "uploads", "restore-tmp", "whisper", "converter"}
SKIP_SUFFIX = (".part", ".tmp", "-journal", "-wal", "-shm")


class BackupConfig(BaseModel):
    enabled: bool = True
    time: str = "03:30"
    keep: int = 7
    include_media: bool = False


class Restore(BaseModel):
    confirm: bool = False


def make_backup_router(data_dir: Path, db_path: Path, db_lock, require_admin: Callable, alerts=None):
    backup_dir = Path(os.environ.get("BACKUP_DIR") or (data_dir / "backups"))
    backup_dir.mkdir(parents=True, exist_ok=True)
    cfg_file = data_dir / "backup.json"
    state = {"running": False, "last_error": "", "last_ok": None, "restore": None}
    lock = threading.Lock()
    r = APIRouter()

    def config() -> dict:
        c = BackupConfig().model_dump()
        try:
            c.update(json.loads(cfg_file.read_text()))
        except (OSError, ValueError):
            pass
        return c

    def listing() -> list[dict]:
        out = []
        for f in backup_dir.glob("retaildemo-backup-*.tar.gz"):
            if not NAME_RE.match(f.name):
                continue
            st = f.stat()
            out.append({"name": f.name, "size": st.st_size, "created": st.st_mtime, "media": f.name.endswith("-medien.tar.gz")})
        return sorted(out, key=lambda b: b["created"], reverse=True)

    def files_to_save(include_media: bool):
        for root, dirs, files in os.walk(data_dir):
            rel_root = Path(root).relative_to(data_dir)
            if rel_root == Path("."):
                dirs[:] = [d for d in dirs if d not in SKIP_TOP and (include_media or d not in ("media", "thumbs"))]
            # Live-Vorschauen des Slicers lassen sich jederzeit neu erzeugen
            dirs[:] = [d for d in dirs if d != "live"]
            for fn in files:
                p = Path(root) / fn
                if p == db_path or fn.endswith(SKIP_SUFFIX) or p.resolve().is_relative_to(backup_dir.resolve()):
                    continue
                yield p, rel_root / fn

    def create(include_media: Optional[bool] = None, reason: str = "manuell") -> dict:
        if not lock.acquire(blocking=False):
            raise HTTPException(409, "Es läuft schon ein Backup")
        state["running"] = True
        try:
            include = config()["include_media"] if include_media is None else include_media
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            name = f"retaildemo-backup-{stamp}{'-medien' if include else ''}.tar.gz"
            tmp = backup_dir / (name + ".part")
            with tempfile.TemporaryDirectory(dir=backup_dir, prefix=".tmp-") as td:
                db_copy = Path(td) / db_path.name
                with db_lock:  # konsistente Kopie der Datenbank (SQLite-Backup)
                    src = sqlite3.connect(db_path)
                    dst = sqlite3.connect(db_copy)
                    src.backup(dst)
                    dst.close()
                    src.close()
                manifest = {"app": "retaildemo", "version": 1, "created": time.time(), "media": include, "reason": reason}
                (Path(td) / "backup-info.json").write_text(json.dumps(manifest))
                with tarfile.open(tmp, "w:gz", compresslevel=3) as tar:
                    tar.add(Path(td) / "backup-info.json", "backup-info.json")
                    tar.add(db_copy, db_path.relative_to(data_dir).as_posix())
                    for p, rel in files_to_save(include):
                        try:
                            tar.add(p, rel.as_posix(), recursive=False)
                        except OSError:
                            continue  # gerade gelöscht
            tmp.replace(backup_dir / name)
            # alte automatische Backups aufräumen
            keep = max(1, config()["keep"])
            for old in listing()[keep:]:
                (backup_dir / old["name"]).unlink(missing_ok=True)
            state.update(last_error="", last_ok=time.time())
            if alerts:
                alerts.resolve("backup")
            return next(b for b in listing() if b["name"] == name)
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            state["last_error"] = str(e)[:300]
            for p in backup_dir.glob("*.part"):
                p.unlink(missing_ok=True)
            if alerts:
                alerts.raise_("backup", "Backup fehlgeschlagen", str(e)[:300], key="backup")
            raise HTTPException(500, f"Backup fehlgeschlagen: {e}")
        finally:
            state["running"] = False
            lock.release()

    def safe_members(tar: tarfile.TarFile):
        for m in tar.getmembers():
            p = Path(m.name)
            if p.is_absolute() or ".." in p.parts or not (m.isfile() or m.isdir()):
                raise HTTPException(400, f"Ungültiger Eintrag im Backup: {m.name}")
            yield m

    def restore(path: Path):
        """Backup einspielen: Dateien überschreiben, Datenbank ersetzen, danach Neustart des Servers."""
        try:
            with tarfile.open(path, "r:gz") as tar:
                try:
                    info = json.load(tar.extractfile("backup-info.json"))
                except (KeyError, ValueError, AttributeError):
                    raise HTTPException(400, "Das ist kein Backup der Retail Demo")
                if info.get("app") != "retaildemo":
                    raise HTTPException(400, "Das ist kein Backup der Retail Demo")
                members = list(safe_members(tar))
                tmp = data_dir / "restore-tmp"
                shutil.rmtree(tmp, ignore_errors=True)
                tmp.mkdir()
                tar.extractall(tmp, members=members, filter="data")
        except (tarfile.TarError, OSError) as e:
            raise HTTPException(400, f"Backup lässt sich nicht lesen: {e}")
        # vorher den aktuellen Stand sichern (falls das falsche Backup erwischt wurde)
        try:
            create(include_media=False, reason="vor Wiederherstellung")
        except HTTPException:
            pass
        db_rel = db_path.relative_to(data_dir)
        with db_lock:
            for p in sorted(tmp.rglob("*")):
                rel = p.relative_to(tmp)
                if rel.name == "backup-info.json" or rel == db_rel:
                    continue
                dest = data_dir / rel
                if p.is_dir():
                    dest.mkdir(parents=True, exist_ok=True)
                else:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(p, dest)
            if (tmp / db_rel).exists():
                shutil.copy2(tmp / db_rel, db_path)
        shutil.rmtree(tmp, ignore_errors=True)
        state["restore"] = {"at": time.time(), "media": info.get("media")}
        # alle Teile (Druck, Video-Schnitt, …) laden ihren Stand beim Start: Server neu starten (Docker startet neu)
        threading.Timer(1.5, lambda: os._exit(0)).start()

    def register_upload(tmp: Path, filename: str) -> dict:
        """Hochgeladene Backup-Datei in die Liste übernehmen (danach Wiederherstellen per Klick)."""
        try:
            with tarfile.open(tmp, "r:gz") as tar:
                info = json.load(tar.extractfile("backup-info.json"))
            if info.get("app") != "retaildemo":
                raise ValueError
        except Exception:  # noqa: BLE001
            tmp.unlink(missing_ok=True)
            raise HTTPException(400, "Das ist kein Backup der Retail Demo (retaildemo-backup-….tar.gz)")
        stamp = datetime.fromtimestamp(info.get("created") or time.time()).strftime("%Y%m%d-%H%M%S")
        name = f"retaildemo-backup-{stamp}{'-medien' if info.get('media') else ''}.tar.gz"
        shutil.move(str(tmp), backup_dir / name)
        return next(b for b in listing() if b["name"] == name)

    # ------------------------------------------------ täglich automatisch
    def loop():
        last_day = None
        while True:
            time.sleep(30)
            try:
                c = config()
                now = datetime.now()
                if c["enabled"] and now.strftime("%H:%M") >= c["time"] and last_day != now.date():
                    newest = listing()[0]["created"] if listing() else 0
                    last_day = now.date()
                    if datetime.fromtimestamp(newest).date() != now.date() or newest < now.replace(
                            hour=int(c["time"][:2]), minute=int(c["time"][3:]), second=0).timestamp():
                        create(reason="automatisch")
            except Exception:  # noqa: BLE001 – Fehler meldet create() als Alarm
                pass

    threading.Thread(target=loop, daemon=True).start()

    def file_of(name: str) -> Path:
        if not NAME_RE.match(name or "") or not (backup_dir / name).exists():
            raise HTTPException(404, "Backup nicht gefunden")
        return backup_dir / name

    # ------------------------------------------------ Schnittstelle
    @r.get("/api/admin/backups", dependencies=[Depends(require_admin)])
    def list_backups():
        disk = shutil.disk_usage(backup_dir)
        return {"backups": listing(), "config": config(), "running": state["running"], "last_error": state["last_error"],
                "last_ok": state["last_ok"], "dir": str(backup_dir), "external": bool(os.environ.get("BACKUP_DIR")),
                "disk_free": disk.free, "media_bytes": sum(f.stat().st_size for f in (data_dir / "media").glob("*") if f.is_file())
                if (data_dir / "media").exists() else 0}

    @r.post("/api/admin/backups", dependencies=[Depends(require_admin)])
    def new_backup(include_media: bool = False):
        return create(include_media=include_media)

    @r.put("/api/admin/backups/config", dependencies=[Depends(require_admin)])
    def set_config(body: BackupConfig):
        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", body.time):
            raise HTTPException(400, "Uhrzeit bitte als HH:MM")
        c = body.model_dump()
        c["keep"] = max(1, min(60, c["keep"]))
        cfg_file.write_text(json.dumps(c))
        return c

    @r.get("/api/admin/backups/{name}/file", dependencies=[Depends(require_admin)])
    def download(name: str):
        return FileResponse(file_of(name), media_type="application/gzip", filename=name)

    @r.delete("/api/admin/backups/{name}", dependencies=[Depends(require_admin)])
    def delete(name: str):
        file_of(name).unlink(missing_ok=True)
        return {"ok": True}

    @r.post("/api/admin/backups/{name}/restore", dependencies=[Depends(require_admin)])
    def restore_backup(name: str, body: Restore):
        if not body.confirm:
            raise HTTPException(400, "Bitte bestätigen")
        restore(file_of(name))
        return {"ok": True, "restart": True}

    return r, register_upload
