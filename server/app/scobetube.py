"""YouTube-Import über ScobeTube (eigener Downloader, github.com/Scobecraft/ScobeTube).

Die Demo-Webseite lädt nicht selbst von YouTube, sondern steuert ScobeTube über dessen Schnittstelle
mit einem eigenen Benutzerkonto (ohne Zwei-Faktor-Anmeldung, Rechte „Herunterladen“ und „Dateien“):
  1. Link (oder Suche) → ScobeTube lädt das Video/den Ton herunter (/api/add)
  2. Der Server fragt den Fortschritt ab (/api/items) und holt die fertige Datei (/api/files/{id})
  3. Video → Mediathek (optional gleich in Playlists), Ton → Musik für den Video-Schnitt
"""
import json
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

MAX_FILE = 4 * 1024 ** 3  # 4 GB
ITEM_TIMEOUT_S = 3 * 3600


class StConfig(BaseModel):
    url: str = ""
    username: str = ""
    password: str = ""  # leer = gespeichertes behalten


class ImportIn(BaseModel):
    url: str
    target: str = "media"           # media (Video in die Medien) | audio (Musik für den Video-Schnitt)
    quality: str = "1080"
    start: str = ""                  # Zuschnitt, z. B. "1:20"
    end: str = ""
    sponsorblock: bool = False
    title: str = ""
    playlist_ids: list[int] = []


class StError(Exception):
    pass


class StAuthError(StError):
    """Sitzung abgelaufen (401) – einmal neu anmelden."""


class ScobeTube:
    """Kleiner Client mit eigener Anmeldung (Sitzungs-Cookie wird selbst verwaltet)."""

    def __init__(self, cfg_file: Path):
        self.cfg_file = cfg_file
        self.cookie: Optional[str] = None
        self.lock = threading.Lock()

    def cfg(self) -> dict:
        try:
            return json.loads(self.cfg_file.read_text())
        except (OSError, ValueError):
            return {}

    def save_cfg(self, c: dict):
        self.cfg_file.write_text(json.dumps(c))
        try:
            self.cfg_file.chmod(0o600)
        except OSError:
            pass
        self.cookie = None

    def base(self) -> str:
        u = (self.cfg().get("url") or "").strip().rstrip("/")
        if not u:
            raise StError("ScobeTube ist noch nicht eingerichtet")
        return u

    def _req(self, method: str, path: str, body: Optional[dict] = None, raw: bool = False, auth: bool = True, timeout: int = 60):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"X-ScobeTube": "1", "Accept": "application/json", "User-Agent": "RetailDemo/1.0"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if auth:
            headers["Cookie"] = f"scobetube_session={self.session()}"
        req = urllib.request.Request(self.base() + path, data=data, method=method, headers=headers)
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = json.loads(e.read(4000) or b"{}").get("detail", "")
            except (ValueError, AttributeError):
                pass
            if e.code == 401 and auth:
                self.cookie = None
                raise StAuthError(detail or "Sitzung abgelaufen") from None
            if e.code == 401:
                raise StError("Benutzername oder Passwort für ScobeTube stimmen nicht") from None
            raise StError(detail or f"ScobeTube antwortet mit Fehler {e.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise StError(f"ScobeTube nicht erreichbar ({getattr(e, 'reason', e)})") from None
        if raw:
            return resp
        with resp:
            return json.loads(resp.read() or b"{}"), resp.headers

    def session(self) -> str:
        with self.lock:
            if self.cookie:
                return self.cookie
            c = self.cfg()
            if not c.get("username") or not c.get("password"):
                raise StError("Benutzername oder Passwort für ScobeTube fehlen")
            data, headers = self._req("POST", "/api/auth/login", {"username": c["username"], "password": c["password"], "remember": True}, auth=False)
            if data.get("twofa"):
                raise StError("Dieses ScobeTube-Konto nutzt Zwei-Faktor-Anmeldung. Bitte ein eigenes Konto ohne 2FA für die Demo-Webseite anlegen.")
            for h in headers.get_all("Set-Cookie") or []:
                m = re.match(r"scobetube_session=([^;]+)", h)
                if m:
                    self.cookie = m.group(1)
            if not self.cookie:
                raise StError("Anmeldung bei ScobeTube fehlgeschlagen (kein Sitzungs-Cookie)")
            return self.cookie

    def call(self, method: str, path: str, body: Optional[dict] = None, **kw):
        """Wie _req, meldet sich bei abgelaufener Sitzung einmal neu an."""
        try:
            return self._req(method, path, body, **kw)
        except StAuthError:
            return self._req(method, path, body, **kw)


def make_scobetube_router(data_dir: Path, require_admin: Callable, register_media: Callable,
                          add_to_playlists: Callable, register_audio: Callable):
    st = ScobeTube(data_dir / "scobetube.json")
    jobs_file = data_dir / "scobetube-jobs.json"
    jobs: dict[str, dict] = {}
    jlock = threading.RLock()
    try:
        jobs.update({j["id"]: j for j in json.loads(jobs_file.read_text())})
    except (OSError, ValueError):
        pass
    r = APIRouter()

    def save_jobs():
        with jlock:
            recent = sorted(jobs.values(), key=lambda j: j["created"], reverse=True)[:100]
            jobs_file.write_text(json.dumps(recent))

    def proxied(thumb):
        """ScobeTube-Bildadressen (api/img?…) über diesen Server laden; fremde Adressen nicht direkt einbinden."""
        t = str(thumb or "")
        return "/api/admin/scobetube/" + t[4:] if t.startswith("api/img?") else None

    def http_error(e: StError):
        return HTTPException(502, str(e))

    # ------------------------------------------------ Einrichtung
    @r.get("/api/admin/scobetube", dependencies=[Depends(require_admin)])
    def status():
        c = st.cfg()
        return {"configured": bool(c.get("url") and c.get("username") and c.get("password")), "url": c.get("url", ""), "username": c.get("username", "")}

    @r.put("/api/admin/scobetube", dependencies=[Depends(require_admin)])
    def configure(body: StConfig):
        c = st.cfg()
        url = body.url.strip().rstrip("/")
        if url and not re.match(r"^https?://[^\s/]+", url):
            raise HTTPException(400, "Bitte die Adresse mit http:// oder https:// angeben, z. B. http://192.168.1.10:8081")
        c.update(url=url, username=body.username.strip())
        if body.password:
            c["password"] = body.password
        st.save_cfg(c)
        try:  # gleich ausprobieren
            data, _ = st.call("GET", "/api/auth/me")
        except StError as e:
            raise HTTPException(400, f"Gespeichert, aber die Verbindung klappt nicht: {e}")
        return {"ok": True, "user": (data.get("user") or data).get("username") if isinstance(data, dict) else None}

    # ------------------------------------------------ Suche (mit Vorschaubildern über den Server)
    @r.get("/api/admin/scobetube/search", dependencies=[Depends(require_admin)])
    def search(q: str):
        try:
            data, _ = st.call("GET", "/api/search?" + urllib.parse.urlencode({"q": q[:200], "source": "youtube"}), timeout=60)
        except StError as e:
            raise http_error(e)
        res = data.get("results") or []
        for x in res:
            x["thumbnail"] = proxied(x.get("thumbnail"))
        return {"results": res}

    @r.get("/api/admin/scobetube/img", dependencies=[Depends(require_admin)])
    def image(u: str, s: str):
        try:
            resp = st.call("GET", "/api/img?" + urllib.parse.urlencode({"u": u, "s": s}), raw=True, timeout=30)
            with resp:
                return Response(resp.read(5 * 1024 * 1024), media_type=resp.headers.get("Content-Type", "image/jpeg"),
                                headers={"Cache-Control": "private, max-age=86400"})
        except StError:
            raise HTTPException(404, "Bild nicht verfügbar")

    # ------------------------------------------------ Import
    def finish(job: dict, item: dict):
        """Fertige Datei von ScobeTube holen und übernehmen."""
        job.update(state="transfer", note="Wird übernommen …")
        resp = st.call("GET", f"/api/files/{item['id']}", raw=True, timeout=120)
        name = Path(item.get("filename") or "video.mp4").name
        with resp, tempfile.NamedTemporaryFile(delete=False, dir=data_dir, suffix=".part") as out:
            job["tmp"] = out.name
            size = 0
            while chunk := resp.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_FILE:
                    raise StError("Datei zu groß (über 4 GB)")
                out.write(chunk)
        tmp = Path(out.name)
        job["tmp"] = str(tmp)
        title = job.get("title") or item.get("title") or Path(name).stem
        if job["target"] == "audio":
            a = register_audio(tmp, title[:100] + Path(name).suffix)
            job.update(state="done", audio_id=a["id"], result_title=a["name"])
        else:
            mime = "video/webm" if name.lower().endswith(".webm") else "video/mp4"
            m = register_media(tmp, title[:100] + Path(name).suffix, mime, title[:120])
            if job.get("playlist_ids"):
                add_to_playlists(m["id"], job["playlist_ids"])
            job.update(state="done", media_id=m["id"], result_title=m["title"])
        job["note"] = ""
        # Datei in ScobeTube nicht mehr nötig (Fehler hier sind egal)
        try:
            st.call("DELETE", f"/api/items/{item['id']}")
        except StError:
            pass

    def watch(job_id: str):
        job = jobs[job_id]
        t0 = time.time()
        try:
            while time.time() - t0 < ITEM_TIMEOUT_S:
                items, _ = st.call("GET", "/api/items")
                item = next((i for i in items if i.get("id") == job["item_id"]), None) if isinstance(items, list) else None
                if not item:
                    raise StError("Der Download ist in ScobeTube verschwunden")
                job.update(progress=round(float(item.get("progress") or 0), 1), title=job.get("title") or item.get("title"),
                           thumbnail=job.get("thumbnail") or proxied(item.get("thumbnail")), duration=item.get("duration"),
                           note=item.get("note") or "")
                status = item.get("status")
                if status == "done":
                    finish(job, item)
                    break
                if status in ("error", "failed", "canceled", "cancelled"):
                    raise StError(item.get("error") or "Download fehlgeschlagen")
                time.sleep(2)
            else:
                raise StError("Download hat zu lange gedauert")
        except Exception as e:  # noqa: BLE001 – Fehler am Auftrag anzeigen
            job.update(state="error", error=str(getattr(e, "detail", None) or e)[:300])
        tmp = job.pop("tmp", None)
        if tmp:
            Path(tmp).unlink(missing_ok=True)
        save_jobs()

    @r.post("/api/admin/scobetube/import", dependencies=[Depends(require_admin)])
    def start_import(body: ImportIn):
        url = body.url.strip()
        if not re.match(r"^https?://", url):
            raise HTTPException(400, "Bitte einen Link einfügen (z. B. https://www.youtube.com/watch?v=…)")
        if body.target not in ("media", "audio"):
            raise HTTPException(400, "Unbekanntes Ziel")
        opts = {"url": url, "sponsorblock": body.sponsorblock}
        if body.target == "audio":
            opts.update(kind="audio", format="mp3", quality="best")
        else:
            q = body.quality if body.quality in ("best", "1440", "1080", "720", "480") else "1080"
            opts.update(kind="video", format="mp4", quality=q)
        if body.start.strip():
            opts["start"] = body.start.strip()
        if body.end.strip():
            opts["end"] = body.end.strip()
        try:
            data, _ = st.call("POST", "/api/add", opts)
        except StError as e:
            raise http_error(e)
        added = data.get("added") or []
        if not added:
            raise HTTPException(502, "ScobeTube hat nichts angenommen")
        if len(added) > 1:
            # Playlist-Link: nur das erste Video (Playlists bitte einzeln)
            for extra in added[1:]:
                try:
                    st.call("POST", f"/api/items/{extra}/cancel")
                except StError:
                    pass
        job = {"id": uuid.uuid4().hex, "item_id": added[0], "url": url, "target": body.target, "title": body.title.strip()[:120],
               "playlist_ids": body.playlist_ids, "state": "loading", "progress": 0, "created": time.time(), "note": "",
               "playlist_skipped": len(added) - 1}
        with jlock:
            jobs[job["id"]] = job
        save_jobs()
        threading.Thread(target=watch, args=(job["id"],), daemon=True).start()
        return job

    # nach einem Neustart laufende Aufträge weiter beobachten
    for j in list(jobs.values()):
        if j.get("state") in ("loading", "transfer"):
            j["state"] = "loading"
            threading.Thread(target=watch, args=(j["id"],), daemon=True).start()

    @r.get("/api/admin/scobetube/jobs", dependencies=[Depends(require_admin)])
    def list_jobs():
        with jlock:
            return sorted(jobs.values(), key=lambda j: j["created"], reverse=True)[:30]

    class PlIn(BaseModel):
        playlist_ids: list[int]

    @r.post("/api/admin/scobetube/jobs/{job_id}/playlists", dependencies=[Depends(require_admin)])
    def job_to_playlists(job_id: str, body: PlIn):
        j = jobs.get(job_id)
        if not j or not j.get("media_id"):
            raise HTTPException(404, "Kein fertiges Video")
        add_to_playlists(j["media_id"], body.playlist_ids)
        return {"ok": True}

    @r.delete("/api/admin/scobetube/jobs/{job_id}", dependencies=[Depends(require_admin)])
    def forget_job(job_id: str):
        with jlock:
            j = jobs.pop(job_id, None)
        if j and j["state"] in ("loading",):
            try:
                st.call("POST", f"/api/items/{j['item_id']}/cancel")
            except StError:
                pass
        save_jobs()
        return {"ok": True}

    return r
