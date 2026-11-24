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
import hashlib
import json
import math
import os
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

DEFAULTS = {
    "enabled": False,
    "lat": None,
    "lon": None,
    "radius_m": 150,          # erlaubter Umkreis um den Laden
    "min_accuracy_m": 50,     # schlechtere GPS-Fixes ignorieren (nur gute zählen für Alarm)
    "dwell_s": 180,           # so lange muss das Gerät den Bereich durchgehend verlassen haben
    "arm_grace_s": 300,       # Schonzeit nach Scharfschalten / Neustart
    "report_interval_s": 120, # wie oft die App im Normalfall den Standort meldet
    "auto_lock": True,        # Gerät bei Diebstahl automatisch sperren
    "history_hours": 72,      # Standortverlauf so lange aufheben
    # --- strenger Fehlalarm-Schutz ---
    "gps_only": True,         # nur echte GPS-Fixes dürfen einen Alarm auslösen (kein Funknetz/WLAN)
    "min_fixes": 4,           # so viele AUFEINANDERFOLGENDE klare Draußen-Messungen nötig
    "margin_m": 50,           # zusätzlicher fester Sicherheitsabstand über Radius+Genauigkeit
    "max_scatter_m": 200,     # Draußen-Messungen müssen nah beieinander liegen (sonst GPS-Rauschen)
    "wifi_ssids": [],         # Namen des Laden-WLANs: solange das Gerät damit verbunden ist, NIE Alarm
    "schedule_enabled": False,# Zeitplan nutzen (nachts/sonntags aus, damit WLAN-Aus keinen Fehlalarm macht)
    "active_from": "08:00",   # Schutz nur in diesem Zeitfenster scharf
    "active_until": "20:00",
    "active_days": [0, 1, 2, 3, 4, 5],  # aktive Wochentage (0=Mo … 6=So), Standard Mo–Sa
    "watch_missing": True,    # Server erkennt selbst, wenn ein anwesendes Gerät plötzlich verschwindet
    "missing_after_s": 300,   # so lange offline (während andere online bleiben) -> möglicher Diebstahl
}
EARTH_R = 6371000.0


def haversine(a_lat, a_lon, b_lat, b_lon) -> float:
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dphi = math.radians(b_lat - a_lat)
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(h)))


def _parse_hhmm(v, default):
    try:
        h, m = str(v).split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return default


def schedule_active(cfg: dict, now_ts: Optional[float] = None) -> bool:
    """True, wenn der Schutz laut Zeitplan gerade scharf sein soll (Zeitzone Europe/Berlin)."""
    if not cfg.get("schedule_enabled"):
        return True
    import datetime as _dt
    tz = None
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo("Europe/Berlin")
    except Exception:
        tz = None
    dt = _dt.datetime.fromtimestamp(now_ts or time.time(), tz)
    days = cfg.get("active_days") or [0, 1, 2, 3, 4, 5]
    if dt.weekday() not in days:
        return False
    start = _parse_hhmm(cfg.get("active_from", "08:00"), 480)
    end = _parse_hhmm(cfg.get("active_until", "20:00"), 1200)
    cur = dt.hour * 60 + dt.minute
    if start == end:
        return True
    return start <= cur < end if start < end else (cur >= start or cur < end)


def on_store_wifi(cfg: dict, ssid: Optional[str]):
    """True/False, wenn ein Laden-WLAN konfiguriert ist; None, wenn kein WLAN-Kriterium gesetzt ist."""
    ssids = cfg.get("wifi_ssids") or []
    if not ssids:
        return None
    if not ssid:
        return False
    norm = ssid.strip().strip(chr(34)).lower()
    return any(norm == str(x).strip().strip(chr(34)).lower() for x in ssids if str(x).strip())


class GeofenceConfig(BaseModel):
    enabled: bool = False
    lat: Optional[float] = None
    lon: Optional[float] = None
    radius_m: int = 150
    min_accuracy_m: int = 50
    dwell_s: int = 180
    arm_grace_s: int = 300
    report_interval_s: int = 120
    auto_lock: bool = True
    history_hours: int = 72
    gps_only: bool = True
    min_fixes: int = 4
    margin_m: int = 50
    max_scatter_m: int = 200
    wifi_ssids: list[str] = []
    schedule_enabled: bool = False
    active_from: str = "08:00"
    active_until: str = "20:00"
    active_days: list[int] = [0, 1, 2, 3, 4, 5]
    watch_missing: bool = True
    missing_after_s: int = 300


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
    # Name des aktuell verbundenen WLANs (für die Laden-WLAN-Prüfung); leer = nicht verbunden/unbekannt
    wifi_ssid: Optional[str] = None


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
                armed_at REAL,
                outside_count INTEGER NOT NULL DEFAULT 0,  -- aufeinanderfolgende klare Draußen-Messungen
                outside_lat REAL, outside_lon REAL,        -- Position der ersten Draußen-Messung (Konsistenz)
                last_photo TEXT, last_photo_at REAL,       -- Diebstahl-Foto (Frontkamera)
                present_at REAL, missing_since REAL,       -- Anwesenheits-/Verschwunden-Erkennung
                missing_alerted INTEGER NOT NULL DEFAULT 0
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
        # Nachträgliche Spalten (für bestehende Installationen)
        tcols = {r["name"] for r in c.execute("PRAGMA table_info(theft_devices)")}
        for col, ddl in (("outside_count", "outside_count INTEGER NOT NULL DEFAULT 0"),
                         ("outside_lat", "outside_lat REAL"), ("outside_lon", "outside_lon REAL"),
                         ("last_photo", "last_photo TEXT"), ("last_photo_at", "last_photo_at REAL"),
                         ("present_at", "present_at REAL"), ("missing_since", "missing_since REAL"),
                         ("missing_alerted", "missing_alerted INTEGER NOT NULL DEFAULT 0")):
            if col not in tcols:
                c.execute(f"ALTER TABLE theft_devices ADD COLUMN {ddl}")

    def set_cfg_path(data_dir: Path):
        cfg_file_holder["path"] = data_dir / "theft.json"

    def _photos_dir() -> Optional[Path]:
        base = cfg_file_holder["path"]
        if not base:
            return None
        d = base.parent / "theft_photos"
        d.mkdir(parents=True, exist_ok=True)
        return d

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

    def _pw_file():
        base = cfg_file_holder["path"]
        return (base.parent / "theft_pw.json") if base else None

    def get_password():
        f = _pw_file()
        try:
            if f and f.exists():
                return json.loads(f.read_text())
        except Exception:
            pass
        return None

    def set_password(pw: str):
        salt = os.urandom(16)
        it = 120000
        h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, it)
        _pw_file().write_text(json.dumps({"salt": salt.hex(), "hash": h.hex(), "iter": it}))

    def clear_password():
        f = _pw_file()
        try:
            if f and f.exists():
                f.unlink()
        except Exception:
            pass

    def verify_password(pw: str) -> bool:
        d = get_password()
        if not d or not pw:
            return False
        try:
            h = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(d["salt"]), int(d["iter"]))
            return h.hex() == d["hash"]
        except Exception:
            return False

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

    def _qualifies(f, cfg) -> bool:
        """Nur verlässliche Messungen dürfen einen Alarm auslösen."""
        if f.acc is None or f.acc <= 0:        # unbekannte Genauigkeit -> niemals
            return False
        if f.acc > cfg["min_accuracy_m"]:      # zu ungenau
            return False
        if cfg.get("gps_only", True) and (f.source or "gps") != "gps":  # kein echtes GPS (Funknetz/WLAN)
            return False
        return True

    def evaluate(c, device_id: str, fixes: list[Fix], pending: list, wifi_ssid: Optional[str] = None) -> dict:
        """Gemeldete Standorte auswerten (strenger Fehlalarm-Schutz). Gibt den Sperr-Status zurück.

        Alarm NUR wenn ALLES zutrifft:
          - Zeitplan gerade scharf (nachts/sonntags optional aus)
          - NICHT im Laden-WLAN (falls eins konfiguriert ist)
          - mehrere AUFEINANDERFOLGENDE, nah beieinander liegende, genaue GPS-Fixes klar außerhalb
          - Verweildauer vorbei und Schonzeit abgelaufen
        """
        cfg = config()
        st = tstate(c, device_id)
        now = time.time()
        has_center = cfg["lat"] is not None and cfg["lon"] is not None
        wifi_cfg = bool(cfg.get("wifi_ssids"))
        store_wifi = on_store_wifi(cfg, wifi_ssid)     # True / False / None
        sched_ok = schedule_active(cfg, now)
        margin = cfg.get("margin_m", 50)
        scatter = cfg.get("max_scatter_m", 200)
        armed_ok = cfg["enabled"] and st["armed"] and has_center and sched_ok
        grace_ok = (not st["armed_at"]) or now - st["armed_at"] > cfg["arm_grace_s"]
        # „Sicher" = im Laden-WLAN ODER Zeitplan gerade aus -> dann niemals Alarm, Zähler zurücksetzen
        safe_context = (wifi_cfg and store_wifi) or (not sched_ok)

        o_since = st["outside_since"]
        o_count = st["outside_count"] or 0
        o_lat = st["outside_lat"]
        o_lon = st["outside_lon"]
        best = None
        trig_dist = None

        for f in sorted(fixes, key=lambda x: (x.t or now)):
            t = f.t or now
            if not (-90 <= f.lat <= 90 and -180 <= f.lon <= 180):
                continue
            dist = None
            inside = None
            if has_center:
                dist = haversine(cfg["lat"], cfg["lon"], f.lat, f.lon)
                if _qualifies(f, cfg):
                    buffer_m = max(f.acc, 30)
                    inside = 1 if dist <= cfg["radius_m"] else (0 if dist > cfg["radius_m"] + buffer_m + margin else None)
            c.execute("INSERT INTO locations (device_id,t,lat,lon,acc,battery,speed,source,distance_m,inside) VALUES (?,?,?,?,?,?,?,?,?,?)",
                      (device_id, t, f.lat, f.lon, f.acc, f.battery, f.speed, f.source, dist, inside))
            if best is None or t >= (best.t or 0):
                best = f
            if not (armed_ok and grace_ok):
                continue
            if safe_context:
                o_count = 0; o_since = None; o_lat = None; o_lon = None
                continue
            if not _qualifies(f, cfg):
                continue
            if inside == 0:                 # klar + sicher draußen UND nicht im Laden-WLAN
                if o_count > 0 and o_lat is not None and haversine(o_lat, o_lon, f.lat, f.lon) > scatter:
                    o_count = 1; o_since = t; o_lat = f.lat; o_lon = f.lon   # Ausreißer -> neu zählen
                else:
                    if o_count == 0:
                        o_since = t; o_lat = f.lat; o_lon = f.lon
                    o_count += 1
                if o_count >= cfg["min_fixes"] and o_since is not None and now - o_since >= cfg["dwell_s"]:
                    trig_dist = dist
            elif inside == 1:               # eindeutig drinnen
                o_count = 0; o_since = None; o_lat = None; o_lon = None
            # inside None (Pufferzone/ungenau) -> Zähler unverändert

        c.execute("DELETE FROM locations WHERE t < ?", (now - cfg["history_hours"] * 3600,))

        if best is not None:
            bdist = haversine(cfg["lat"], cfg["lon"], best.lat, best.lon) if has_center else None
            disp_inside = st["inside"]
            if has_center and _qualifies(best, cfg):
                disp_inside = 1 if bdist <= cfg["radius_m"] else (0 if bdist > cfg["radius_m"] + max(best.acc, 30) else st["inside"])
            c.execute("UPDATE theft_devices SET last_lat=?, last_lon=?, last_acc=?, last_at=?, last_source=?, "
                      "last_battery=COALESCE(?,last_battery), last_speed=?, last_distance_m=?, inside=?, "
                      "outside_since=?, outside_count=?, outside_lat=?, outside_lon=? WHERE device_id=?",
                      (best.lat, best.lon, best.acc, best.t or now, best.source, best.battery, best.speed,
                       bdist, disp_inside, o_since, o_count, o_lat, o_lon, device_id))
        else:
            c.execute("UPDATE theft_devices SET outside_since=?, outside_count=?, outside_lat=?, outside_lon=? WHERE device_id=?",
                      (o_since, o_count, o_lat, o_lon, device_id))

        if trig_dist is not None:
            _trigger_theft(c, device_id, trig_dist, cfg, pending)
        return device_theft_status(c, device_id)

    def device_theft_status(c, device_id: str) -> dict:
        cfg = config()
        st = tstate(c, device_id)
        reason = st["lock_reason"] or ""
        pw = get_password()
        return {
            "armed": bool(st["armed"]) and cfg["enabled"] and schedule_active(cfg),
            "locked": bool(st["locked"]),
            "lock_seq": st["lock_seq"],
            "lock_reason": reason,
            "test": reason.startswith("Test"),
            "geofence": {"enabled": cfg["enabled"] and cfg["lat"] is not None,
                         "lat": cfg["lat"], "lon": cfg["lon"], "radius_m": cfg["radius_m"]},
            "params": {k: cfg[k] for k in ("min_accuracy_m", "dwell_s", "arm_grace_s", "report_interval_s",
                                            "gps_only", "min_fixes", "margin_m")},
            "wifi_ssids": cfg.get("wifi_ssids") or [],
            "schedule": {"enabled": bool(cfg.get("schedule_enabled")), "from": cfg.get("active_from", "08:00"),
                         "until": cfg.get("active_until", "20:00"), "days": cfg.get("active_days") or [0, 1, 2, 3, 4, 5]},
            "unlock": ({"salt": pw["salt"], "hash": pw["hash"], "iter": pw["iter"]} if pw else None),
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
            status = evaluate(c, report.device_id, report.fixes[:200], pending, report.wifi_ssid)
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
        check_missing()   # bei jedem Aufruf der Webseite selbst prüfen, ob ein Gerät verschwunden ist
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
                    "has_photo": bool(st.get("last_photo")),
                    "photo_at": st.get("last_photo_at"),
                    "readiness": (json.loads(d["readiness"]) if d["readiness"] else None),
                    "present_at": st.get("present_at"),
                    "missing_since": st.get("missing_since"),
                    "missing": bool(st.get("missing_alerted")),
                })
        return {"config": cfg, "pw_set": get_password() is not None, "devices": out}

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
        cfg["min_fixes"] = max(1, min(20, cfg.get("min_fixes", 4)))
        cfg["margin_m"] = max(0, min(2000, cfg.get("margin_m", 50)))
        cfg["max_scatter_m"] = max(30, min(5000, cfg.get("max_scatter_m", 200)))
        cfg["wifi_ssids"] = [str(x).strip() for x in (cfg.get("wifi_ssids") or []) if str(x).strip()][:10]
        cfg["active_days"] = sorted({int(d) for d in (cfg.get("active_days") or []) if 0 <= int(d) <= 6})
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

    @r.post("/api/device/theft/photo", dependencies=[Depends(require_device)])
    async def upload_photo(device_id: str = Form(...), photo: UploadFile = File(...)):
        """Frontkamera-Foto bei (vermutetem) Diebstahl – als Beweis/Abschreckung."""
        d = _photos_dir()
        if not d:
            raise HTTPException(500, "Kein Speicherort")
        data = await photo.read()
        if len(data) > 8_000_000:
            raise HTTPException(413, "Foto zu groß")
        safe = "".join(ch for ch in device_id if ch.isalnum() or ch in "-_")[:64] or "dev"
        fn = d / f"{safe}.jpg"
        fn.write_bytes(data)
        with db() as c:
            tstate(c, device_id)
            c.execute("UPDATE theft_devices SET last_photo=?, last_photo_at=? WHERE device_id=?",
                      (str(fn.name), time.time(), device_id))
        return {"ok": True}

    @r.get("/api/admin/theft/{device_id}/photo", dependencies=[Depends(require_admin)])
    def get_photo(device_id: str):
        with db() as c:
            row = c.execute("SELECT last_photo FROM theft_devices WHERE device_id=?", (device_id,)).fetchone()
        d = _photos_dir()
        if not row or not row["last_photo"] or not d or not (d / row["last_photo"]).exists():
            raise HTTPException(404, "Kein Foto")
        return FileResponse(d / row["last_photo"], media_type="image/jpeg")

    class PwBody(BaseModel):
        password: str = ""

    @r.put("/api/admin/theft/password", dependencies=[Depends(require_admin)])
    def set_theft_password(body: PwBody):
        if body.password:
            if len(body.password) < 4:
                raise HTTPException(400, "Passwort zu kurz (mindestens 4 Zeichen).")
            set_password(body.password)
            return {"set": True}
        clear_password()
        return {"set": False}

    class DevUnlockBody(BaseModel):
        device_id: str
        password: str

    @r.post("/api/device/theft/unlock", dependencies=[Depends(require_device)])
    def device_unlock(body: DevUnlockBody):
        """Entsperren direkt am Gerät mit dem Admin-Passwort (von der Webseite festgelegt)."""
        if not verify_password(body.password):
            raise HTTPException(403, "Falsches Passwort")
        with db() as c:
            tstate(c, body.device_id)
            c.execute("UPDATE theft_devices SET locked=0, lock_seq=lock_seq+1, lock_reason=NULL, locked_at=NULL, "
                      "outside_since=NULL, outside_count=0 WHERE device_id=?", (body.device_id,))
            status = device_theft_status(c, body.device_id)
        if alerts:
            alerts.resolve(f"theft:{body.device_id}")
        return status

    def check_missing():
        """Vom Server regelmäßig aufgerufen: erkennt selbst, wenn ein anwesendes Gerät plötzlich
        verschwindet (kein WLAN mehr → meldet sich nicht mehr), während die anderen online bleiben.
        Ein WLAN-/Strom-Ausfall (viele gleichzeitig offline) löst bewusst KEINEN Alarm aus."""
        cfg = config()
        if not cfg["enabled"] or not cfg.get("watch_missing", True) or not schedule_active(cfg):
            return
        now = time.time()
        win = max(120, int(cfg.get("missing_after_s", 300)))
        new_missing, resolved = [], []
        with db() as c:
            rows = c.execute(
                "SELECT d.id AS id, d.last_seen AS last_seen, t.armed AS armed, t.locked AS locked, "
                "t.present_at AS present_at, t.missing_since AS missing_since, t.missing_alerted AS missing_alerted "
                "FROM devices d LEFT JOIN theft_devices t ON t.device_id=d.id "
                "WHERE d.removed=0 AND (d.platform IS NULL OR d.platform='android')").fetchall()
            armed = [r for r in rows if (r["armed"] if r["armed"] is not None else 1)]
            recent = [r for r in armed if r["present_at"] and now - r["present_at"] < 1800]
            online_recent = [r for r in recent if r["last_seen"] and now - r["last_seen"] < win]
            # Ausfall-Schutz: wenn von mehreren kürzlich anwesenden Geräten die meisten gleichzeitig weg sind
            outage = len(recent) >= 3 and len(online_recent) < 0.4 * len(recent)
            for r in armed:
                dev = r["id"]
                online = r["last_seen"] and now - r["last_seen"] < win
                if online:
                    c.execute("INSERT OR IGNORE INTO theft_devices (device_id, armed, armed_at) VALUES (?,1,?)", (dev, now))
                    if r["missing_alerted"]:
                        resolved.append(dev)
                    c.execute("UPDATE theft_devices SET present_at=?, missing_since=NULL, missing_alerted=0 WHERE device_id=?", (now, dev))
                elif r["present_at"] and now - r["present_at"] < 1800:
                    ms = r["missing_since"] or r["last_seen"] or now
                    if not r["missing_since"]:
                        c.execute("UPDATE theft_devices SET missing_since=? WHERE device_id=?", (ms, dev))
                    if (not outage) and (not r["locked"]) and (not r["missing_alerted"]) and now - ms >= win:
                        c.execute("UPDATE theft_devices SET missing_alerted=1 WHERE device_id=?", (dev,))
                        new_missing.append(dev)
        if alerts:
            for dev in new_missing:
                name = device_name(dev)
                alerts.raise_("theft", f"Möglicher Diebstahl: {name} ist verschwunden",
                              "Das Gerät war im Laden erreichbar und meldet sich jetzt nicht mehr "
                              "(kein WLAN mehr – es könnte den Laden verlassen haben).",
                              level="error", key=f"theftmissing:{dev}", data={"device_id": dev, "action": "theft"})
            for dev in resolved:
                alerts.resolve(f"theftmissing:{dev}")

    return r, status_for_device, set_cfg_path, check_missing
