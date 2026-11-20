"""Aktivitätsprotokoll: wer hat wann was geändert (Webseite oder Admin-App).

Protokolliert werden alle ändernden Anfragen (POST/PUT/PATCH/DELETE) an die Verwaltung – mit einer
verständlichen Beschreibung, dem Namen des betroffenen Eintrags und ob es geklappt hat.
"""
import re
import time
from typing import Callable, Optional

from fastapi import APIRouter, Depends, Request

# (Methode, Pfad-Muster, Beschreibung). {name} wird durch den Namen des Eintrags ersetzt.
ACTIONS = [
    ("POST", r"^/api/web/login$", "Angemeldet"),
    ("POST", r"^/api/web/logout$", "Abgemeldet"),
    ("POST", r"^/api/web/setup$", "Passwort der Webseite eingerichtet"),
    ("POST", r"^/api/web/password$", "Passwort der Webseite geändert"),
    ("POST", r"^/api/admin/media$", "Medium hochgeladen"),
    ("POST", r"^/api/admin/uploads/[^/]+/complete$", "Datei hochgeladen"),
    ("PATCH", r"^/api/admin/media/(?P<media>[^/]+)$", "Medium „{name}“ umbenannt"),
    ("DELETE", r"^/api/admin/media/(?P<media>[^/]+)$", "Medium „{name}“ gelöscht"),
    ("POST", r"^/api/admin/media/bulk-delete$", "Mehrere Medien gelöscht"),
    ("POST", r"^/api/admin/playlists$", "Playlist angelegt"),
    ("PUT", r"^/api/admin/playlists/(?P<playlist>\d+)$", "Playlist „{name}“ geändert"),
    ("DELETE", r"^/api/admin/playlists/(?P<playlist>\d+)$", "Playlist „{name}“ gelöscht"),
    ("PATCH", r"^/api/admin/devices/(?P<device>[^/]+)$", "Gerät „{name}“ geändert"),
    ("DELETE", r"^/api/admin/devices/(?P<device>[^/]+)$", "Gerät „{name}“ entfernt"),
    ("POST", r"^/api/admin/devices/(?P<device>[^/]+)/sync-now$", "Gerät „{name}“ aktualisiert"),
    ("POST", r"^/api/admin/devices/sync-all$", "Alle Geräte aktualisiert"),
    ("PUT", r"^/api/admin/settings$", "Einstellungen geändert"),
    ("POST", r"^/api/admin/logo$", "Logo hochgeladen"),
    ("DELETE", r"^/api/admin/logo$", "Logo entfernt"),
    ("POST", r"^/api/admin/app-release/rollout$", "Demo-App-Update an alle Geräte verteilt"),
    ("POST", r"^/api/admin/app-release/install-now$", "Demo-App-Update sofort installieren"),
    ("DELETE", r"^/api/admin/app-release/rollout$", "Demo-App-Update gestoppt"),
    ("DELETE", r"^/api/admin/app-release$", "Demo-App-Update gelöscht"),
    ("DELETE", r"^/api/admin/admin-app/release$", "Admin-App-Update gelöscht"),
    ("POST", r"^/api/admin/druck/release/install-now$", "Druckmonitor-Update installieren"),
    ("DELETE", r"^/api/admin/druck/release$", "Druckmonitor-Update gelöscht"),
    ("POST", r"^/api/admin/druck/jobs/[^/]+/print$", "3D-Druck gestartet"),
    ("POST", r"^/api/admin/druck/jobs/[^/]+/queue$", "3D-Druck in die Warteschlange"),
    ("POST", r"^/api/admin/druck/jobs/[^/]+/cancel$", "3D-Druck zurückgeholt"),
    ("DELETE", r"^/api/admin/druck/jobs/[^/]+$", "3D-Druckauftrag gelöscht"),
    ("POST", r"^/api/admin/druck/jobs/[^/]+/slice$", "3D-Modell neu geslict"),
    ("POST", r"^/api/admin/druck/jobs/[^/]+/as-model$", "3D-Modell an den Druckmonitor geschickt"),
    ("POST", r"^/api/admin/druck/bed-clear$", "Druckbett als frei bestätigt"),
    ("PUT", r"^/api/admin/druck/queue$", "Druck-Warteschlange geändert"),
    ("POST", r"^/api/admin/druck/plates$", "Druckplatte mit mehreren Modellen angelegt"),
    ("PUT", r"^/api/admin/druck/plates/[^/]+$", "Druckplatte geändert"),
    ("POST", r"^/api/admin/druck/thingiverse/import$", "Modell von Thingiverse geladen"),
    ("PUT", r"^/api/admin/druck/slicer/defaults$", "Slicer-Standards gespeichert"),
    ("POST", r"^/api/admin/editor/projects$", "Schnitt-Projekt angelegt"),
    ("DELETE", r"^/api/admin/editor/projects/[^/]+$", "Schnitt-Projekt gelöscht"),
    ("POST", r"^/api/admin/editor/projects/[^/]+/render$", "Video im Video-Schnitt erstellt"),
    ("POST", r"^/api/admin/editor/projects/[^/]+/subtitles$", "Untertitel erzeugt"),
    ("POST", r"^/api/admin/scobetube/import$", "YouTube-Import gestartet"),
    ("PUT", r"^/api/admin/scobetube$", "ScobeTube-Zugang geändert"),
    ("POST", r"^/api/admin/backups$", "Backup erstellt"),
    ("POST", r"^/api/admin/backups/[^/]+/restore$", "Backup wiederhergestellt"),
    ("DELETE", r"^/api/admin/backups/[^/]+$", "Backup gelöscht"),
    ("PUT", r"^/api/admin/backups/config$", "Backup-Einstellungen geändert"),
    ("PUT", r"^/api/admin/alerts/config$", "Benachrichtigungen eingestellt"),
    ("DELETE", r"^/api/admin/stats$", "Statistik zurückgesetzt"),
    ("POST", r"^/api/admin/convert/jobs/[^/]+/to-slicer/[^/]+$", "Umgewandeltes 3D-Modell in den Slicer übernommen"),
    ("DELETE", r"^/api/admin/convert/jobs/[^/]+$", "Umwandlung gelöscht"),
    ("PUT", r"^/api/admin/timelapse/config$", "Zeitraffer-Einstellungen geändert"),
    ("POST", r"^/api/admin/druck/inputlock$", "Tastatur & Maus am Druckmonitor-PC gesperrt/entsperrt"),
    ("PUT", r"^/api/admin/theft/config$", "Diebstahlschutz-Bereich (Geofence) geändert"),
    ("POST", r"^/api/admin/theft/[^/]+/lock$", "Gerät gesperrt/entsperrt (Diebstahlschutz)"),
    ("POST", r"^/api/admin/theft/[^/]+/arm$", "Diebstahlschutz für Gerät scharf/unscharf"),
    ("POST", r"^/api/admin/theft/[^/]+/test$", "Diebstahl-Testalarm ausgelöst"),
    ("PUT", r"^/api/admin/druck/shutdown$", "Zeitplan „PC herunterfahren“ geändert"),
    ("POST", r"^/api/admin/druck/shutdown/skip$", "Herunterfahren heute ausgelassen/wieder aktiviert"),
]
# nicht protokollieren (zu häufig / ändert nichts Dauerhaftes)
SKIP = [r"^/api/admin/uploads/[^/]+$", r"^/api/admin/druck/jobs/[^/]+/live$", r"^/api/admin/editor/projects/[^/]+$",
        r"^/api/admin/alerts/", r"^/api/admin/uploads$", r"^/api/admin/stats/"]
COMPILED = [(m, re.compile(p), t) for m, p, t in ACTIONS]
SKIP_RE = [re.compile(p) for p in SKIP]


class Activity:
    def __init__(self, db: Callable):
        self.db = db
        with db() as c:
            c.executescript("""
                CREATE TABLE IF NOT EXISTS activity (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    t REAL NOT NULL,
                    who TEXT NOT NULL,
                    ip TEXT,
                    action TEXT NOT NULL,
                    ok INTEGER NOT NULL DEFAULT 1,
                    detail TEXT
                );
            """)

    def log(self, who: str, ip: str, action: str, ok: bool = True, detail: str = ""):
        with self.db() as c:
            c.execute("INSERT INTO activity (t, who, ip, action, ok, detail) VALUES (?,?,?,?,?,?)",
                      (time.time(), who, ip, action[:300], 1 if ok else 0, detail[:500]))
            if c.execute("SELECT COUNT(*) FROM activity").fetchone()[0] > 20000:
                c.execute("DELETE FROM activity WHERE id IN (SELECT id FROM activity ORDER BY id LIMIT 2000)")

    def name_for(self, kind: str, ident: str) -> str:
        q = {"media": "SELECT title FROM media WHERE id=?",
             "playlist": "SELECT name FROM playlists WHERE id=?",
             "device": "SELECT COALESCE(display_name, marketing_name, model) FROM devices WHERE id=?"}[kind]
        try:
            with self.db() as c:
                row = c.execute(q, (ident,)).fetchone()
            return (row[0] if row and row[0] else ident)[:80]
        except Exception:  # noqa: BLE001
            return ident


def describe(method: str, path: str) -> Optional[tuple[str, Optional[tuple[str, str]]]]:
    """Beschreibung und (Art, ID) des betroffenen Eintrags – None = nicht protokollieren."""
    if any(r.match(path) for r in SKIP_RE):
        return None
    for m, rx, text in COMPILED:
        if m == method and (mt := rx.match(path)):
            ref = next(((k, v) for k, v in mt.groupdict().items() if v), None)
            return text, ref
    if path.startswith("/api/admin/"):
        return f"{method} {path}", None
    return None


def install(app, activity: Activity, client_ip: Callable[[Request], str]):
    """Reine ASGI-Middleware (stört keine langen Streams wie das Kamerabild)."""
    class ActivityMiddleware:
        def __init__(self, inner):
            self.inner = inner

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http" or scope["method"] not in ("POST", "PUT", "PATCH", "DELETE"):
                return await self.inner(scope, receive, send)
            method, path = scope["method"], scope["path"]
            d = describe(method, path)
            if not d:
                return await self.inner(scope, receive, send)
            text, ref = d
            name = activity.name_for(*ref) if ref else ""  # vor dem Löschen nachsehen
            status = {"code": 500}

            async def send_wrapper(msg):
                if msg["type"] == "http.response.start":
                    status["code"] = msg["status"]
                await send(msg)

            try:
                await self.inner(scope, receive, send_wrapper)
            finally:
                code = status["code"]
                if not (code == 401 and path != "/api/web/login"):  # nicht angemeldet: nichts geschehen
                    request = Request(scope)
                    who = "Admin-App" if request.headers.get("authorization", "").lower().startswith("bearer ") else "Webseite"
                    ok = code < 400
                    t = "Anmeldung fehlgeschlagen" if path == "/api/web/login" and not ok else text
                    try:
                        activity.log(who, client_ip(request), t.replace("{name}", name or "?"), ok, "" if ok else f"Fehler {code}")
                    except Exception:  # noqa: BLE001 – Protokoll darf nie stören
                        pass

    app.add_middleware(ActivityMiddleware)


def make_activity_router(activity: Activity, require_admin: Callable):
    r = APIRouter()

    @r.get("/api/admin/activity", dependencies=[Depends(require_admin)])
    def list_activity(before: int = 0, limit: int = 100, q: str = ""):
        limit = max(1, min(500, limit))
        sql, args = "SELECT * FROM activity WHERE 1=1", []
        if before:
            sql += " AND id < ?"
            args.append(before)
        if q.strip():
            sql += " AND (action LIKE ? OR who LIKE ? OR ip LIKE ?)"
            args += [f"%{q.strip()}%"] * 3
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(limit)
        with activity.db() as c:
            rows = c.execute(sql, args).fetchall()
        return {"items": [dict(r) for r in rows], "more": len(rows) == limit}

    return r
