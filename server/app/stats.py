"""Wiedergabe-Statistik: Was lief wie oft, wo, wie lange – und wie lange waren die Geräte online.

Die Demo-App meldet gesammelt (POST /api/device/stats):
  {"device_id": "…", "events": [{"type": "play", "media_id": "…", "start": 1700000000, "duration_s": 12.3, "completed": true},
                                {"type": "promo", "start": …, "duration_s": 10},
                                {"type": "touch", "start": …}]}
Online-Zeiten misst der Server selbst (minütlich: hat sich das Gerät gerade gemeldet?).
"""
import threading
import time
from datetime import date, datetime, timedelta
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel


class StatEvent(BaseModel):
    type: str
    media_id: Optional[str] = None
    start: float
    duration_s: float = 0
    completed: bool = True


class StatReport(BaseModel):
    device_id: str
    events: list[StatEvent] = []


def _opening_minutes(schedule: dict, day: date) -> int:
    if not schedule or not schedule.get("enabled"):
        return 24 * 60
    d = (schedule.get("days") or [None] * 7)[day.weekday()]
    if not d or not d.get("active"):
        return 0
    on = int(d["on"][:2]) * 60 + int(d["on"][3:])
    off = int(d["off"][:2]) * 60 + int(d["off"][3:])
    return off - on if off > on else 24 * 60 - on + off


def make_stats_router(db: Callable, require_device: Callable, require_admin: Callable, settings: Callable):
    with db() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS plays (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                media_id TEXT,
                kind TEXT NOT NULL,
                t REAL NOT NULL,
                duration_s REAL NOT NULL DEFAULT 0,
                completed INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS plays_t ON plays(t);
            CREATE UNIQUE INDEX IF NOT EXISTS plays_uniq ON plays(device_id, kind, t);
            CREATE TABLE IF NOT EXISTS device_minutes (
                device_id TEXT NOT NULL,
                day TEXT NOT NULL,
                online INTEGER NOT NULL DEFAULT 0,
                demo INTEGER NOT NULL DEFAULT 0,
                customer INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (device_id, day)
            );
        """)
    r = APIRouter()

    # ------------------------------------------------ Online-Zeiten (minütlich)
    def sample():
        now = time.time()
        day = date.today().isoformat()
        with db() as c:
            for row in c.execute("SELECT id, last_seen, status FROM devices WHERE removed=0").fetchall():
                # Herzschlag kommt jede Minute – 3 Minuten Luft für Funklöcher
                if not row["last_seen"] or now - row["last_seen"] > 180:
                    continue
                st = (row["status"] or "").lower()
                demo = 1 if st.startswith(("demo läuft", "gestartet")) else 0
                cust = 1 if st.startswith("kunde") else 0
                c.execute("INSERT INTO device_minutes (device_id, day, online, demo, customer) VALUES (?,?,1,?,?)"
                          " ON CONFLICT(device_id, day) DO UPDATE SET online=online+1, demo=demo+?, customer=customer+?",
                          (row["id"], day, demo, cust, demo, cust))
            if datetime.now().minute == 0:  # einmal pro Stunde aufräumen: ein Jahr aufheben
                c.execute("DELETE FROM plays WHERE t < ?", (now - 366 * 86400,))
                c.execute("DELETE FROM device_minutes WHERE day < ?", ((date.today() - timedelta(days=366)).isoformat(),))

    def loop():
        while True:
            time.sleep(60 - time.time() % 60)
            try:
                sample()
            except Exception:  # noqa: BLE001
                pass

    threading.Thread(target=loop, daemon=True).start()

    # ------------------------------------------------ Geräte melden
    @r.post("/api/device/stats", dependencies=[Depends(require_device)])
    def device_stats(report: StatReport):
        now = time.time()
        rows = []
        for e in report.events[:2000]:
            if e.type not in ("play", "promo", "specs", "touch") or not (now - 30 * 86400 < e.start < now + 300):
                continue
            rows.append((report.device_id[:64], (e.media_id or "")[:64] or None, e.type, e.start,
                         max(0.0, min(e.duration_s, 6 * 3600)), 1 if e.completed else 0))
        with db() as c:
            c.executemany("INSERT OR IGNORE INTO plays (device_id, media_id, kind, t, duration_s, completed) VALUES (?,?,?,?,?,?)", rows)
        return {"ok": True, "stored": len(rows)}

    # ------------------------------------------------ Auswertung
    @r.get("/api/admin/stats", dependencies=[Depends(require_admin)])
    def admin_stats(days: int = 7, device_id: str = ""):
        days = max(1, min(365, days))
        start_day = date.today() - timedelta(days=days - 1)
        t0 = datetime.combine(start_day, datetime.min.time()).timestamp()
        dev_sql, dev_args = (" AND device_id=?", [device_id]) if device_id else ("", [])
        with db() as c:
            s = settings(c)
            names = {row["id"]: row["display_name"] or row["marketing_name"] or row["model"] or row["id"][:8]
                     for row in c.execute("SELECT id, display_name, marketing_name, model FROM devices")}
            titles = {row["id"]: row["title"] for row in c.execute("SELECT id, title FROM media")}
            per_media = c.execute(
                "SELECT media_id, COUNT(*) n, SUM(duration_s) secs, SUM(completed) done FROM plays"
                " WHERE kind='play' AND t>=?" + dev_sql + " GROUP BY media_id ORDER BY n DESC", [t0, *dev_args]).fetchall()
            per_device = c.execute(
                "SELECT device_id, SUM(kind='play') n, SUM(CASE WHEN kind='play' THEN duration_s ELSE 0 END) secs,"
                " SUM(kind='touch') touches, SUM(kind='promo') promos FROM plays WHERE t>=?" + dev_sql +
                " GROUP BY device_id", [t0, *dev_args]).fetchall()
            per_day = c.execute(
                "SELECT date(t, 'unixepoch', 'localtime') d, SUM(kind='play') n, SUM(kind='touch') touches,"
                " SUM(CASE WHEN kind='play' THEN duration_s ELSE 0 END) secs FROM plays WHERE t>=?" + dev_sql +
                " GROUP BY d", [t0, *dev_args]).fetchall()
            per_hour = c.execute(
                "SELECT CAST(strftime('%H', t, 'unixepoch', 'localtime') AS INTEGER) h, COUNT(*) n FROM plays"
                " WHERE kind='touch' AND t>=?" + dev_sql + " GROUP BY h", [t0, *dev_args]).fetchall()
            minutes = c.execute(
                "SELECT device_id, day, online, demo, customer FROM device_minutes WHERE day>=?" + dev_sql,
                [start_day.isoformat(), *dev_args]).fetchall()
        day_list = [(start_day + timedelta(days=i)).isoformat() for i in range(days)]
        by_day = {r["d"]: r for r in per_day}
        opening = {d: _opening_minutes(s.get("schedule") or {}, date.fromisoformat(d)) for d in day_list}
        # bis jetzt verstrichene Betriebszeit von heute
        today = date.today().isoformat()
        if (s.get("schedule") or {}).get("enabled"):
            dd = (s["schedule"]["days"] or [None] * 7)[date.today().weekday()]
            if dd and dd.get("active"):
                now_m = datetime.now().hour * 60 + datetime.now().minute
                on = int(dd["on"][:2]) * 60 + int(dd["on"][3:])
                opening[today] = max(0, min(opening[today], now_m - on))
        else:
            opening[today] = datetime.now().hour * 60 + datetime.now().minute
        dev_minutes: dict[str, dict] = {}
        for m in minutes:
            d = dev_minutes.setdefault(m["device_id"], {"online": 0, "demo": 0, "customer": 0})
            d["online"] += m["online"]
            d["demo"] += m["demo"]
            d["customer"] += m["customer"]
        open_total = sum(opening.values())
        devices = []
        for did in set(dev_minutes) | {r["device_id"] for r in per_device}:
            p = next((r for r in per_device if r["device_id"] == did), None)
            m = dev_minutes.get(did, {"online": 0, "demo": 0, "customer": 0})
            devices.append({"id": did, "name": names.get(did, did[:8]), "plays": p["n"] if p else 0,
                            "play_s": round(p["secs"] or 0) if p else 0, "touches": p["touches"] if p else 0,
                            "promos": p["promos"] if p else 0, "online_min": m["online"], "demo_min": m["demo"],
                            "customer_min": m["customer"],
                            "uptime_pct": round(min(100, 100 * m["online"] / open_total), 1) if open_total else None})
        devices.sort(key=lambda d: (-d["plays"], d["name"]))
        return {
            "days": days, "from": start_day.isoformat(),
            "totals": {"plays": sum(r["n"] for r in per_media), "play_s": round(sum(r["secs"] or 0 for r in per_media)),
                       "touches": sum(d["touches"] for d in devices), "devices": len(devices),
                       "customer_min": sum(d["customer_min"] for d in devices)},
            "media": [{"id": r["media_id"], "title": titles.get(r["media_id"], "(gelöscht)"), "plays": r["n"],
                       "play_s": round(r["secs"] or 0), "completed_pct": round(100 * (r["done"] or 0) / r["n"]) if r["n"] else 0}
                      for r in per_media],
            "devices": devices,
            "per_day": [{"day": d, "plays": by_day[d]["n"] if d in by_day else 0, "touches": by_day[d]["touches"] if d in by_day else 0,
                         "play_s": round(by_day[d]["secs"] or 0) if d in by_day else 0, "opening_min": opening[d]} for d in day_list],
            "touch_hours": [next((r["n"] for r in per_hour if r["h"] == h), 0) for h in range(24)],
        }

    @r.delete("/api/admin/stats", dependencies=[Depends(require_admin)])
    def reset_stats(confirm: bool = False):
        if not confirm:
            raise HTTPException(400, "Bitte bestätigen")
        with db() as c:
            c.execute("DELETE FROM plays")
            c.execute("DELETE FROM device_minutes")
        return {"ok": True}

    return r
