"""Alarme (Benachrichtigungen) für die Admin-App und die Webseite.

Quellen: Demo-Geräte offline, 3D-Druck fertig/Fehler, Druckbett abräumen, Speicherplatz knapp,
Backup fehlgeschlagen. Die Admin-App holt neue Alarme ab (dauerhafte Verbindung oder alle 15 Minuten)
und zeigt sie als Push-Benachrichtigung.
"""
import json
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

KINDS = {
    "device_offline": "Demo-Gerät offline",
    "print_done": "3D-Druck fertig",
    "print_error": "3D-Druck Fehler",
    "bed_clear": "Druckbett abräumen",
    "disk": "Speicherplatz knapp",
    "backup": "Backup fehlgeschlagen",
}
DEFAULT_CONFIG = {
    "enabled": {k: True for k in KINDS},
    "offline_minutes": 15,
    "only_opening_hours": True,  # Offline-Alarm nur während der Betriebszeiten
    "disk_min_percent": 10,
}


class AlertConfig(BaseModel):
    enabled: dict[str, bool] = {}
    offline_minutes: int = 15
    only_opening_hours: bool = True
    disk_min_percent: int = 10


class Alerts:
    def __init__(self, db: Callable, data_dir: Path):
        self.db = db
        self.cfg_file = data_dir / "alerts.json"
        self.cond = threading.Condition()
        with db() as c:
            c.executescript("""
                CREATE TABLE IF NOT EXISTS alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    t REAL NOT NULL,
                    kind TEXT NOT NULL,
                    level TEXT NOT NULL,
                    title TEXT NOT NULL,
                    body TEXT NOT NULL DEFAULT '',
                    key TEXT,
                    resolved INTEGER NOT NULL DEFAULT 0,
                    acked INTEGER NOT NULL DEFAULT 0,
                    data TEXT
                );
                CREATE INDEX IF NOT EXISTS alerts_key ON alerts(key, resolved);
            """)

    # ------------------------------------------------ Einstellungen
    def config(self) -> dict:
        c = json.loads(json.dumps(DEFAULT_CONFIG))
        try:
            saved = json.loads(self.cfg_file.read_text())
            c["enabled"].update({k: bool(v) for k, v in (saved.get("enabled") or {}).items() if k in KINDS})
            for k in ("offline_minutes", "only_opening_hours", "disk_min_percent"):
                if k in saved:
                    c[k] = saved[k]
        except (OSError, ValueError):
            pass
        return c

    def save_config(self, body: AlertConfig) -> dict:
        c = self.config()
        c["enabled"].update({k: bool(v) for k, v in body.enabled.items() if k in KINDS})
        c["offline_minutes"] = max(5, min(240, body.offline_minutes))
        c["only_opening_hours"] = body.only_opening_hours
        c["disk_min_percent"] = max(1, min(50, body.disk_min_percent))
        self.cfg_file.write_text(json.dumps(c))
        return c

    # ------------------------------------------------ Alarme auslösen
    def raise_(self, kind: str, title: str, body: str = "", level: str = "warn", key: Optional[str] = None,
               data: Optional[dict] = None) -> Optional[int]:
        """Neuen Alarm anlegen. Mit key: nur einmal, solange der gleiche Alarm noch nicht erledigt ist."""
        if kind in KINDS and not self.config()["enabled"].get(kind, True):
            return None
        with self.db() as c:
            if key and c.execute("SELECT 1 FROM alerts WHERE key=? AND resolved=0", (key,)).fetchone():
                return None
            cur = c.execute("INSERT INTO alerts (t, kind, level, title, body, key, data) VALUES (?,?,?,?,?,?,?)",
                            (time.time(), kind, level, title[:200], body[:1000], key, json.dumps(data) if data else None))
            new_id = cur.lastrowid
            # alte Einträge aufräumen
            c.execute("DELETE FROM alerts WHERE t < ?", (time.time() - 60 * 86400,))
        with self.cond:
            self.cond.notify_all()
        return new_id

    def resolve(self, key: str):
        with self.db() as c:
            c.execute("UPDATE alerts SET resolved=1 WHERE key=? AND resolved=0", (key,))

    def latest_id(self) -> int:
        with self.db() as c:
            return c.execute("SELECT COALESCE(MAX(id), 0) FROM alerts").fetchone()[0]

    def items(self, after: int = 0, limit: int = 50) -> list[dict]:
        with self.db() as c:
            if after:
                rows = c.execute("SELECT * FROM alerts WHERE id > ? ORDER BY id LIMIT ?", (after, limit)).fetchall()
            else:
                rows = c.execute("SELECT * FROM alerts ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [{"id": r["id"], "t": r["t"], "kind": r["kind"], "level": r["level"], "title": r["title"], "body": r["body"],
                 "resolved": bool(r["resolved"]), "acked": bool(r["acked"]), "data": json.loads(r["data"]) if r["data"] else None}
                for r in rows]

    def wait(self, after: int, timeout: float) -> list[dict]:
        end = time.time() + timeout
        while True:
            items = self.items(after)
            left = end - time.time()
            if items or left <= 0:
                return items
            with self.cond:
                self.cond.wait(min(left, 5))


def in_opening_hours(schedule: dict, now: Optional[datetime] = None) -> bool:
    """Betriebszeit laut Zeitplan der Demo (ohne aktiven Zeitplan: immer)."""
    if not schedule or not schedule.get("enabled"):
        return True
    now = now or datetime.now()
    day = (schedule.get("days") or [])[now.weekday()] if len(schedule.get("days") or []) == 7 else None
    if not day or not day.get("active"):
        return False
    hm = now.strftime("%H:%M")
    on, off = day.get("on", "00:00"), day.get("off", "23:59")
    return on <= hm < off if on <= off else (hm >= on or hm < off)


def make_alerts_router(alerts: Alerts, require_admin: Callable, db: Callable, settings: Callable, data_dir: Path,
                       online_window_s: int):
    r = APIRouter()

    # ------------------------------------------------ Überwachung im Hintergrund
    def check():
        cfg = alerts.config()
        now = time.time()
        with db() as c:
            s = settings(c)
            rows = c.execute("SELECT id, display_name, marketing_name, model, last_seen, platform FROM devices WHERE removed=0").fetchall()
        open_hours = in_opening_hours(s.get("schedule") or {})
        limit = cfg["offline_minutes"] * 60
        for row in rows:
            key = f"offline:{row['id']}"
            name = row["display_name"] or row["marketing_name"] or row["model"] or row["id"][:8]
            last = row["last_seen"] or 0
            if now - last < online_window_s:
                alerts.resolve(key)  # wieder da
                continue
            # nur Geräte, die bis vor kurzem liefen (sonst meldet ein abgebautes Gerät ewig)
            if limit <= now - last < 2 * 86400 and (open_hours or not cfg["only_opening_hours"]):
                mins = int((now - last) // 60)
                alerts.raise_("device_offline", f"{name} ist offline",
                              f"Seit {mins} Minuten keine Meldung mehr (zuletzt {datetime.fromtimestamp(last).strftime('%H:%M')} Uhr).",
                              key=key, data={"device_id": row["id"]})
        disk = shutil.disk_usage(data_dir)
        free_pct = 100 * disk.free / disk.total if disk.total else 100
        if free_pct < cfg["disk_min_percent"]:
            alerts.raise_("disk", "Speicherplatz auf dem Server wird knapp",
                          f"Nur noch {disk.free / 1e9:.1f} GB frei ({free_pct:.0f} %). Bitte alte Medien oder Backups löschen.",
                          key="disk")
        elif free_pct > cfg["disk_min_percent"] + 2:
            alerts.resolve("disk")

    def loop():
        time.sleep(30)
        while True:
            try:
                check()
            except Exception:  # noqa: BLE001 – Überwachung darf nie abbrechen
                pass
            time.sleep(60)

    threading.Thread(target=loop, daemon=True).start()

    # ------------------------------------------------ Schnittstelle
    @r.get("/api/admin/alerts", dependencies=[Depends(require_admin)])
    def list_alerts(after: int = 0, limit: int = 50):
        return {"alerts": alerts.items(after, max(1, min(200, limit))), "latest_id": alerts.latest_id(), "kinds": KINDS}

    @r.get("/api/admin/alerts/wait", dependencies=[Depends(require_admin)])
    def wait_alerts(after: int = 0, timeout: int = 25):
        """Langes Warten für die Admin-App (sofortige Benachrichtigung)."""
        items = alerts.wait(after, max(1, min(55, timeout)))
        return {"alerts": items, "latest_id": max([a["id"] for a in items], default=after)}

    @r.post("/api/admin/alerts/{alert_id}/ack", dependencies=[Depends(require_admin)])
    def ack(alert_id: int):
        with db() as c:
            c.execute("UPDATE alerts SET acked=1 WHERE id=?", (alert_id,))
        return {"ok": True}

    @r.post("/api/admin/alerts/ack-all", dependencies=[Depends(require_admin)])
    def ack_all():
        with db() as c:
            c.execute("UPDATE alerts SET acked=1 WHERE acked=0")
        return {"ok": True}

    @r.get("/api/admin/alerts/config", dependencies=[Depends(require_admin)])
    def get_config():
        return {**alerts.config(), "kinds": KINDS}

    @r.put("/api/admin/alerts/config", dependencies=[Depends(require_admin)])
    def put_config(body: AlertConfig):
        return {**alerts.save_config(body), "kinds": KINDS}

    @r.post("/api/admin/alerts/test", dependencies=[Depends(require_admin)])
    def test_alert():
        alerts.raise_("test", "Test-Benachrichtigung", "So sehen Alarme der Retail Demo aus.", level="info", data={"test": True})
        return {"ok": True}

    return r
