"""Diebstahlschutz für die Demo-Handys (Geofence/GPS-Überwachung).

Auf der Webseite wird ein Mittelpunkt (der Laden) und ein Radius eingetragen. Die Demo-App meldet
regelmäßig ihren Standort (auch verzögert, sobald sie wieder Internet hat). Verlässt ein Handy den
Bereich dauerhaft, löst es Alarm aus und sperrt sich – und der Server benachrichtigt die Admin-App.
Entsperrt wird nur über die Webseite.

Fehlalarm-Schutz (greift hier UND in der App):
  - nur Messungen mit guter Genauigkeit zählen (schlechte GPS-Fixes werden verworfen)
  - ein Puffer um den Radius (mindestens die Messungenauigkeit) gegen GPS-„Zittern" am Rand
  - das Gerät muss den Bereich eine Weile DURCHGEHEND verlassen haben (Verweildauer), nicht nur kurz
  - kurz nach dem Scharfschalten / Neustart gibt es eine Schonzeit (GPS braucht Zeit zum Einrasten)
  - fehlt ein Standort ganz, passiert nichts (kein Alarm bei „kein GPS")
"""
import json
import math
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

DEFAULTS = {
    "enabled": False,
    "lat": None,
    "lon": None,
    "radius_m": 150,          # erlaubter Umkreis um den Laden
    "min_accuracy_m": 60,     # schlechtere GPS-Fixes ignorieren
    "dwell_s": 180,           # so lange muss das Gerät den Bereich durchgehend verlassen haben
    "arm_grace_s": 300,       # Schonzeit nach Scharfschalten / Neustart
    "report_interval_s": 120, # wie oft die App im Normalfall den Standort meldet
    "auto_lock": True,        # Gerät bei Diebstahl automatisch sperren
    "history_hours": 72,      # Standortverlauf so lange aufheben
}
EARTH_R = 6371000.0


def haversine(a_lat, a_lon, b_lat, b_lon) -> float:
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dphi = math.radians(b_lat - a_lat)
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(h)))


class GeofenceConfig(BaseModel):
    enabled: bool = False
    lat: Optional[float] = None
    lon: Optional[float] = None
    radius_m: int = 150
    min_accuracy_m: int = 60
    dwell_s: int = 180
    arm_grace_s: int = 300
    report_interval_s: int = 120
    auto_lock: bool = True
    history_hours: int = 72


class Fix(BaseModel):
    t: Optional[float] = None
    lat: float
    lon: float
    acc: float = 0            # Genauigkeit in m (0 = unbekannt)
    battery: Optional[int] = None
    speed: Optional[float] = None
    source: str = "gps"       # gps | network | fused


class LocationReport(BaseModel):
    device_id: str
    fixes: list[Fix] = []
    # Die App meldet, was sie selbst festgestellt hat (zweite Meinung, ändert aber nichts allein)
    app_outside: bool = False
    app_locked: bool = False


def make_theft_router(db: Callable, require_admin: Callable, require_device: Callable,
                      alerts, client_ip: Callable, device_name: Callable[[str], str]):
    r = APIRouter()
    cfg_file_holder = {"path": None}

    with db() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS theft_devices (
                device_id TEXT PRIMARY KEY,
                armed INTEGER NOT NULL DEFAULT 1,
                locked INTEGER NOT NULL DEFAULT 0,
                lock_seq INTEGER NOT NULL DEFAULT 0,
                lock_reason TEXT,
                locked_at REAL,
                outside_since REAL,            -- seit wann durchgehend außerhalb (NULL = drinnen/unbekannt)
                last_lat REAL, last_lon REAL, last_acc REAL, last_at REAL,
                last_source TEXT, last_battery INTEGER, last_speed REAL,
                last_distance_m REAL,
                inside INTEGER,                -- 1 drinnen, 0 draußen, NULL unbekannt
                armed_at REAL
            );
            CREATE TABLE IF NOT EXISTS locations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                t REAL NOT NULL,
                lat REAL NOT NULL, lon REAL NOT NULL, acc REAL,
                battery INTEGER, speed REAL, source TEXT,
                distance_m REAL, inside INTEGER
            );
            CREATE INDEX IF NOT EXISTS loc_dev_t ON locations(device_id, t);
        """)

    def set_cfg_path(data_dir: Path):
        cfg_file_holder["path"] = data_dir / "theft.json"

    def config() -> dict:
        c = dict(DEFAULTS)
        p = cfg_file_holder["path"]
        try:
            if p and p.exists():
                c.update({k: v for k, v in json.loads(p.read_text()).items() if k in DEFAULTS})
        except (OSError, ValueError):
            pass
        return c

    def save_config(cfg: dict):
        cfg_file_holder["path"].write_text(json.dumps(cfg))

    def tstate(c, device_id: str) -> dict:
        row = c.execute("SELECT * FROM theft_devices WHERE device_id=?", (device_id,)).fetchone()
        if row:
            return dict(row)
        c.execute("INSERT INTO theft_devices (device_id, armed, armed_at) VALUES (?,1,?)", (device_id, time.time()))
        return dict(c.execute("SELECT * FROM theft_devices WHERE device_id=?", (device_id,)).fetchone())

    def _trigger_theft(c, device_id: str, dist: float, cfg: dict, pending: list):
        """Diebstahl erkannt: Gerät (optional) sperren. Alarm wird erst nach dem DB-Block ausgelöst."""
        st = tstate(c, device_id)
        if st["locked"]:
            return
        if cfg["auto_lock"]:
            c.execute("UPDATE theft_devices SET locked=1, lock_seq=lock_seq+1, lock_reason=?, locked_at=? WHERE device_id=?",
                      (f"Bereich verlassen ({dist:.0f} m vom Laden)", time.time(), device_id))
        pending.append((device_id, dist, cfg["auto_lock"]))

    def evaluate(c, device_id: str, fixes: list[Fix], pending: list) -> dict:
        """Gemeldete Standorte auswerten (Fehlalarm-Schutz). Gibt den aktuellen Sperr-Status zurück."""
        cfg = config()
        st = tstate(c, device_id)
        now = time.time()
        # Standorte speichern (auch wenn der Geofence aus ist – für die Karte)
        best = None
        for f in fixes:
            t = f.t or now
            if not (-90 <= f.lat <= 90 and -180 <= f.lon <= 180):
                continue
            dist = None
            inside = None
            if cfg["lat"] is not None and cfg["lon"] is not None:
                dist = haversine(cfg["lat"], cfg["lon"], f.lat, f.lon)
                good = f.acc <= 0 or f.acc <= cfg["min_accuracy_m"]
                if good:
                    buffer_m = max(f.acc, 30)
                    inside = 1 if dist <= cfg["radius_m"] else (0 if dist > cfg["radius_m"] + buffer_m else None)
            c.execute("INSERT INTO locations (device_id,t,lat,lon,acc,battery,speed,source,distance_m,inside) VALUES (?,?,?,?,?,?,?,?,?,?)",
                      (device_id, t, f.lat, f.lon, f.acc, f.battery, f.speed, f.source, dist, inside))
            if best is None or t >= (best.t or 0):
                best = f
        # ältere Standorte aufräumen
        c.execute("DELETE FROM locations WHERE t < ?", (now - cfg["history_hours"] * 3600,))

        if best is not None:
            dist = haversine(cfg["lat"], cfg["lon"], best.lat, best.lon) if cfg["lat"] is not None else None
            inside = None
            good = best.acc <= 0 or best.acc <= cfg["min_accuracy_m"]
            if dist is not None and good:
                buffer_m = max(best.acc, 30)
                inside = dist <= cfg["radius_m"]
                outside_hard = dist > cfg["radius_m"] + buffer_m
            else:
                outside_hard = False
            c.execute("UPDATE theft_devices SET last_lat=?, last_lon=?, last_acc=?, last_at=?, last_source=?, "
                      "last_battery=COALESCE(?,last_battery), last_speed=?, last_distance_m=?, inside=? WHERE device_id=?",
                      (best.lat, best.lon, best.acc, best.t or now, best.source, best.battery, best.speed,
                       dist, (1 if inside else 0) if inside is not None else st["inside"], device_id))
            st = tstate(c, device_id)
            # Geofence-Auswertung nur wenn scharf, eingerichtet, Genauigkeit gut und Schonzeit vorbei
            armed_ok = cfg["enabled"] and st["armed"] and cfg["lat"] is not None
            grace_ok = not st["armed_at"] or now - st["armed_at"] > cfg["arm_grace_s"]
            if armed_ok and grace_ok and good and dist is not None:
                if outside_hard:
                    if not st["outside_since"]:
                        c.execute("UPDATE theft_devices SET outside_since=? WHERE device_id=?", (now, device_id))
                        st["outside_since"] = now
                    if now - st["outside_since"] >= cfg["dwell_s"]:
                        _trigger_theft(c, device_id, dist, cfg, pending)
                elif inside:
                    # eindeutig wieder drinnen: Zähler zurücksetzen (Sperre bleibt aber bestehen)
                    c.execute("UPDATE theft_devices SET outside_since=NULL WHERE device_id=?", (device_id,))
        return device_theft_status(c, device_id)

    def device_theft_status(c, device_id: str) -> dict:
        cfg = config()
        st = tstate(c, device_id)
        reason = st["lock_reason"] or ""
        return {
            "armed": bool(st["armed"]) and cfg["enabled"],
            "locked": bool(st["locked"]),
            "lock_seq": st["lock_seq"],
            "lock_reason": reason,
            "test": reason.startswith("Test"),
            "geofence": {"enabled": cfg["enabled"] and cfg["lat"] is not None,
                         "lat": cfg["lat"], "lon": cfg["lon"], "radius_m": cfg["radius_m"]},
            "params": {k: cfg[k] for k in ("min_accuracy_m", "dwell_s", "arm_grace_s", "report_interval_s")},
        }

    # ---- von Heartbeat/Sync aufgerufen (damit das Handy Geofence + Sperrstand oft erfährt) ----
    def status_for_device(device_id: str) -> dict:
        with db() as c:
            st = c.execute("SELECT lock_reason, locked_at FROM theft_devices WHERE device_id=?", (device_id,)).fetchone()
            if st and st["lock_reason"] and st["lock_reason"].startswith("Test") and st["locked_at"] and time.time() - st["locked_at"] > 120:
                c.execute("UPDATE theft_devices SET locked=0, lock_seq=lock_seq+1, lock_reason=NULL WHERE device_id=?", (device_id,))
            return device_theft_status(c, device_id)

    # ------------------------------------------------ Gerät meldet Standort
    @r.post("/api/device/location", dependencies=[Depends(require_device)])
    def device_location(report: LocationReport):
        pending = []
        with db() as c:
            status = evaluate(c, report.device_id, report.fixes[:200], pending)
        for dev_id, dist, auto_lock in pending:
            if alerts:
                name = device_name(dev_id)
                alerts.raise_("theft", f"Diebstahlschutz: {name} hat den Bereich verlassen",
                              f"Das Gerät ist {dist:.0f} m vom eingestellten Mittelpunkt entfernt" +
                              (" und wurde gesperrt." if auto_lock else ". (Automatische Sperre ist aus.)"),
                              level="error", key=f"theft:{dev_id}", data={"device_id": dev_id, "action": "theft"})
        return status

    # ------------------------------------------------ Webseite
    @r.get("/api/admin/theft", dependencies=[Depends(require_admin)])
    def admin_theft():
        cfg = config()
        with db() as c:
            rows = c.execute("SELECT * FROM devices WHERE removed=0 AND (platform IS NULL OR platform='android')").fetchall()
            out = []
            now = time.time()
            for d in rows:
                st = c.execute("SELECT * FROM theft_devices WHERE device_id=?", (d["id"],)).fetchone()
                st = dict(st) if st else {}
                # Entfernung und drinnen/draußen IMMER gegen den aktuell eingestellten Mittelpunkt
                # berechnen – sonst passt die Anzeige nicht zum gezeichneten Kreis, wenn der
                # Mittelpunkt/Radius geändert wurde, seit das Gerät zuletzt gemeldet hat.
                lat, lon = st.get("last_lat"), st.get("last_lon")
                dist = st.get("last_distance_m")
                inside = st.get("inside")
                if lat is not None and lon is not None and cfg["lat"] is not None and cfg["lon"] is not None:
                    dist = haversine(cfg["lat"], cfg["lon"], lat, lon)
                    inside = 1 if dist <= cfg["radius_m"] else 0
                out.append({
                    "id": d["id"],
                    "name": d["display_name"] or d["marketing_name"] or d["model"] or d["id"][:8],
                    "online": d["last_seen"] is not None and now - d["last_seen"] < 660,
                    "battery": st.get("last_battery") if st.get("last_battery") is not None else d["battery"],
                    "armed": bool(st.get("armed", 1)),
                    "locked": bool(st.get("locked", 0)),
                    "lock_reason": st.get("lock_reason"),
                    "locked_at": st.get("locked_at"),
                    "lat": lat, "lon": lon, "acc": st.get("last_acc"),
                    "last_at": st.get("last_at"), "distance_m": dist,
                    "inside": inside, "source": st.get("last_source"),
                    "imei": d["imei"], "serial": d["serial"],
                })
        return {"config": cfg, "devices": out}

    @r.put("/api/admin/theft/config", dependencies=[Depends(require_admin)])
    def set_config(body: GeofenceConfig):
        cfg = body.model_dump()
        if cfg["enabled"] and (cfg["lat"] is None or cfg["lon"] is None):
            raise HTTPException(400, "Bitte zuerst einen Mittelpunkt auf der Karte wählen.")
        cfg["radius_m"] = max(25, min(100000, cfg["radius_m"]))
        cfg["min_accuracy_m"] = max(10, min(500, cfg["min_accuracy_m"]))
        cfg["dwell_s"] = max(15, min(3600, cfg["dwell_s"]))
        cfg["arm_grace_s"] = max(0, min(3600, cfg["arm_grace_s"]))
        cfg["report_interval_s"] = max(30, min(3600, cfg["report_interval_s"]))
        cfg["history_hours"] = max(1, min(720, cfg["history_hours"]))
        prev = config()
        save_config(cfg)
        # beim (neu) Scharfschalten: Schonzeit für alle neu starten und „außerhalb"-Zähler löschen
        if cfg["enabled"] and (not prev["enabled"] or prev.get("lat") != cfg["lat"] or prev.get("lon") != cfg["lon"]
                               or prev.get("radius_m") != cfg["radius_m"]):
            with db() as c:
                c.execute("UPDATE theft_devices SET armed_at=?, outside_since=NULL", (time.time(),))
        return cfg

    @r.get("/api/admin/theft/{device_id}/track", dependencies=[Depends(require_admin)])
    def device_track(device_id: str, hours: int = 24, limit: int = 500):
        since = time.time() - max(1, min(720, hours)) * 3600
        with db() as c:
            rows = c.execute("SELECT t,lat,lon,acc,battery,source,distance_m,inside FROM locations "
                             "WHERE device_id=? AND t>=? ORDER BY t DESC LIMIT ?",
                             (device_id, since, max(1, min(5000, limit)))).fetchall()
        return {"points": [dict(x) for x in rows][::-1]}

    class LockBody(BaseModel):
        locked: bool

    @r.post("/api/admin/theft/{device_id}/lock", dependencies=[Depends(require_admin)])
    def set_lock(device_id: str, body: LockBody):
        with db() as c:
            tstate(c, device_id)
            reason = "Von der Webseite gesperrt" if body.locked else None
            c.execute("UPDATE theft_devices SET locked=?, lock_seq=lock_seq+1, lock_reason=?, locked_at=?, outside_since=NULL WHERE device_id=?",
                      (1 if body.locked else 0, reason, time.time() if body.locked else None, device_id))
            status = device_theft_status(c, device_id)
        if not body.locked and alerts:
            alerts.resolve(f"theft:{device_id}")
        return status

    @r.post("/api/admin/theft/{device_id}/test", dependencies=[Depends(require_admin)])
    def test_alarm(device_id: str):
        """Test: Gerät sperren und Alarm auslösen (Sperrbildschirm zeigt TEST). Endet nach 2 Minuten von selbst
        oder sofort über „Entsperren". Löst keinen Push-Alarm aus."""
        with db() as c:
            tstate(c, device_id)
            c.execute("UPDATE theft_devices SET locked=1, lock_seq=lock_seq+1, "
                      "lock_reason=?, locked_at=? WHERE device_id=?",
                      ("Testalarm vom Händler", time.time(), device_id))
            status = device_theft_status(c, device_id)
        return status

    class ArmBody(BaseModel):
        armed: bool

    @r.post("/api/admin/theft/{device_id}/arm", dependencies=[Depends(require_admin)])
    def set_arm(device_id: str, body: ArmBody):
        with db() as c:
            tstate(c, device_id)
            c.execute("UPDATE theft_devices SET armed=?, armed_at=?, outside_since=NULL WHERE device_id=?",
                      (1 if body.armed else 0, time.time(), device_id))
            return device_theft_status(c, device_id)

    return r, status_for_device, set_cfg_path
