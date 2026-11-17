"""Video-Schnitt (Reiter "Video-Schnitt"): Projekte, Musik und Rendern mit ffmpeg.

Ein Projekt besteht aus
  - clips:  Videos/Bilder aus der Mediathek nacheinander (in/out = Ausschnitt, Lautstärke, Einpassung,
            Überblendung zum vorigen Clip)
  - texts:  Texteinblendungen mit Zeit, Position, Größe, Farbe, Hintergrund und Animation
  - audio:  Musik/Ton-Spuren (hochgeladene Audiodateien) mit Lage, Ausschnitt, Lautstärke, Ein-/Ausblenden
Gerendert wird auf dem Server zu einem MP4 (H.264/AAC), das danach in der Mediathek liegt.
"""
import json
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

FORMATS = {"portrait": (1080, 1920), "landscape": (1920, 1080), "square": (1080, 1080)}
FPS = 30
FONTS = {  # Schriften im Server-Image (fonts-dejavu-core); die Vorschau im Browser nutzt ähnliche
    "sans-bold": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "sans": "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "serif-bold": "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    "mono": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
}
AUDIO_EXT = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".flac"}
MAX_CLIPS, MAX_TEXTS, MAX_AUDIO = 200, 100, 20


def _f(v, lo, hi, default):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return default if v != v else max(lo, min(hi, v))


def _color(v, default="#ffffff"):
    return v if isinstance(v, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", v) else default


def clean_project(p: dict, media_ok: Callable[[str], Optional[dict]], audio_ok: Callable[[str], bool]) -> dict:
    """Projekt prüfen und auf sinnvolle Werte begrenzen (alles kommt aus dem Browser)."""
    out = {
        "name": str(p.get("name") or "Neues Video")[:120],
        "format": p.get("format") if p.get("format") in FORMATS else "portrait",
        "master_volume": _f(p.get("master_volume"), 0, 2, 1),
        "clips": [], "texts": [], "audio": [],
    }
    for c in (p.get("clips") or [])[:MAX_CLIPS]:
        m = media_ok(str(c.get("media_id", "")))
        if not m:
            continue
        dur = m.get("duration") or 3600
        is_img = m["type"] == "image"
        cin = 0 if is_img else _f(c.get("in"), 0, max(0, dur - 0.1), 0)
        cout = _f(c.get("out"), cin + 0.1, 3600 if is_img else dur, cin + (5 if is_img else min(dur, 10)))
        out["clips"].append({
            "id": str(c.get("id") or uuid.uuid4().hex)[:40], "media_id": m["id"], "in": round(cin, 3), "out": round(cout, 3),
            "volume": _f(c.get("volume"), 0, 2, 1), "muted": bool(c.get("muted")),
            "fit": c.get("fit") if c.get("fit") in ("cover", "contain", "blur") else "blur",
            "transition": c.get("transition") if c.get("transition") in ("none", "fade", "slideleft", "wipeleft", "circleopen", "fadeblack") else "none",
            "transition_s": _f(c.get("transition_s"), 0.2, 2, 0.5),
            "zoom": c.get("zoom") if c.get("zoom") in ("none", "in", "out") else "none",
        })
    for t in (p.get("texts") or [])[:MAX_TEXTS]:
        start = _f(t.get("start"), 0, 36000, 0)
        out["texts"].append({
            "id": str(t.get("id") or uuid.uuid4().hex)[:40], "text": str(t.get("text") or "")[:500],
            "start": round(start, 3), "end": round(_f(t.get("end"), start + 0.1, 36000, start + 3), 3),
            "x": _f(t.get("x"), 0, 1, 0.5), "y": _f(t.get("y"), 0, 1, 0.8),
            "size": _f(t.get("size"), 1, 30, 6), "color": _color(t.get("color")),
            "bg": _color(t.get("bg"), "#000000"), "bg_on": bool(t.get("bg_on")), "bg_alpha": _f(t.get("bg_alpha"), 0, 1, 0.6),
            "font": t.get("font") if t.get("font") in FONTS else "sans-bold",
            "anim": t.get("anim") if t.get("anim") in ("none", "fade", "slide", "pop") else "fade",
            "shadow": bool(t.get("shadow", True)),
        })
    for a in (p.get("audio") or [])[:MAX_AUDIO]:
        if not audio_ok(str(a.get("file_id", ""))):
            continue
        ain = _f(a.get("in"), 0, 36000, 0)
        out["audio"].append({
            "id": str(a.get("id") or uuid.uuid4().hex)[:40], "file_id": str(a["file_id"]), "name": str(a.get("name") or "")[:120],
            "start": round(_f(a.get("start"), 0, 36000, 0), 3), "in": round(ain, 3),
            "out": round(_f(a.get("out"), ain + 0.1, 36000, ain + 30), 3),
            "volume": _f(a.get("volume"), 0, 2, 0.8), "fade_in": _f(a.get("fade_in"), 0, 10, 0), "fade_out": _f(a.get("fade_out"), 0, 10, 1),
        })
    return out


def timeline(clips: list[dict]) -> tuple[list[float], float]:
    """Startzeit jedes Clips im fertigen Video und Gesamtlänge (Überblendungen überlappen)."""
    starts, t = [], 0.0
    for i, c in enumerate(clips):
        d = c["out"] - c["in"]
        tr = min(c["transition_s"], d / 2, (clips[i - 1]["out"] - clips[i - 1]["in"]) / 2) if i and c["transition"] != "none" else 0
        t -= tr
        starts.append(t)
        t += d
    return starts, max(t, 0.0)


def build_ffmpeg(project: dict, media: Callable[[str], dict], audio_path: Callable[[str], Path], workdir: Path, out: Path) -> tuple[list[str], float]:
    """Kommandozeile für ffmpeg (ein filter_complex für alles)."""
    W, H = FORMATS[project["format"]]
    clips = project["clips"]
    if not clips:
        raise HTTPException(400, "Das Projekt hat noch keine Clips")
    starts, total = timeline(clips)
    args, fc = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"], []
    n = 0
    vlabels, alabels = [], []
    for i, c in enumerate(clips):
        m = media(c["media_id"])
        d = c["out"] - c["in"]
        if m["type"] == "image":
            args += ["-loop", "1", "-framerate", str(FPS), "-t", f"{d:.3f}", "-i", m["path"]]
        else:
            args += ["-ss", f"{c['in']:.3f}", "-t", f"{d:.3f}", "-i", m["path"]]
        vi = n
        n += 1
        # Bild einpassen: füllen (zuschneiden), einpassen (Balken) oder einpassen mit unscharfem Hintergrund
        base = f"[{vi}:v]setpts=PTS-STARTPTS,fps={FPS},setsar=1"
        if c["fit"] == "cover":
            fc.append(f"{base},scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}[v{i}a]")
        elif c["fit"] == "contain":
            fc.append(f"{base},scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black[v{i}a]")
        else:
            fc.append(f"{base},split[v{i}bg][v{i}fg]")
            fc.append(f"[v{i}bg]scale={W // 8}:{H // 8}:force_original_aspect_ratio=increase,crop={W // 8}:{H // 8},boxblur=6:2,scale={W}:{H},eq=brightness=-0.08[v{i}bb]")
            fc.append(f"[v{i}fg]scale={W}:{H}:force_original_aspect_ratio=decrease[v{i}ff]")
            fc.append(f"[v{i}bb][v{i}ff]overlay=(W-w)/2:(H-h)/2[v{i}a]")
        # langsamer Zoom (Ken Burns), sonst unverändert
        if c["zoom"] != "none":
            frames = max(1, int(d * FPS))
            z = f"1+0.12*on/{frames}" if c["zoom"] == "in" else f"1.12-0.12*on/{frames}"
            fc.append(f"[v{i}a]scale={W * 2}:{H * 2},zoompan=z='{z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={FPS}[v{i}z]")
            fc.append(f"[v{i}z]format=yuv420p,trim=duration={d:.3f}[v{i}]")
        else:
            fc.append(f"[v{i}a]format=yuv420p,trim=duration={d:.3f}[v{i}]")
        vlabels.append(f"[v{i}]")
        # Ton des Clips (oder Stille)
        if m.get("has_audio") and not c["muted"] and c["volume"] > 0:
            fc.append(f"[{vi}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume={c['volume']:.3f},apad,atrim=duration={d:.3f}[a{i}]")
        else:
            fc.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={d:.3f}[a{i}]")
        alabels.append(f"[a{i}]")
    # Clips verbinden (mit Überblendungen)
    vcur, acur, length = vlabels[0], alabels[0], clips[0]["out"] - clips[0]["in"]
    for i in range(1, len(clips)):
        c = clips[i]
        d = c["out"] - c["in"]
        tr = (length + d) - (starts[i] + d) if c["transition"] != "none" else 0  # = Überlappung
        tr = max(0.0, min(tr, d / 2, length / 2))
        if tr > 0.05:
            fc.append(f"{vcur}{vlabels[i]}xfade=transition={c['transition']}:duration={tr:.3f}:offset={length - tr:.3f}[vx{i}]")
            fc.append(f"{acur}{alabels[i]}acrossfade=d={tr:.3f}[ax{i}]")
        else:
            fc.append(f"{vcur}{acur}{vlabels[i]}{alabels[i]}concat=n=2:v=1:a=1[vx{i}][ax{i}]")
            tr = 0
        vcur, acur, length = f"[vx{i}]", f"[ax{i}]", length + d - tr
    # Texte (jede Zeile einzeln, damit mehrzeilige Texte zentriert sind)
    for k, t in enumerate(project["texts"]):
        lines = [l for l in t["text"].replace("\r", "").split("\n")]
        if not t["text"].strip() or t["start"] >= total:
            continue
        s, e = t["start"], min(t["end"], total)
        fs = max(8, round(min(W, H) * t["size"] / 100))  # Größe in % der kürzeren Bildseite
        lh = fs * 1.25 + (fs * 0.7 if t["bg_on"] else 0)  # Zeilenabstand (mit Hintergrund etwas mehr)
        alpha = "1"
        slide = ""
        if t["anim"] in ("fade", "slide", "pop"):
            alpha = f"if(lt(t,{s:.3f}+0.4),(t-{s:.3f})/0.4,if(gt(t,{e:.3f}-0.4),({e:.3f}-t)/0.4,1))"
        if t["anim"] == "slide":
            slide = f"+if(lt(t,{s:.3f}+0.5),(1-(t-{s:.3f})/0.5)*h*0.05,0)"
        for li, line in enumerate(lines):
            if not line.strip():
                continue
            tf = workdir / f"text{k}_{li}.txt"
            tf.write_text(line, encoding="utf-8")
            dy = (li - (len(lines) - 1) / 2) * lh
            opts = [f"fontfile='{FONTS[t['font']]}'", f"textfile='{tf}'", "expansion=none", f"fontsize={fs}", f"fontcolor={t['color']}",
                    f"x='w*{t['x']:.4f}-text_w/2'", f"y='h*{t['y']:.4f}-{fs}/2{dy:+.1f}{slide}'",
                    f"enable='between(t,{s:.3f},{e:.3f})'", f"alpha='{alpha}'"]
            if t["bg_on"]:
                opts += ["box=1", f"boxcolor={t['bg']}@{t['bg_alpha']:.2f}", f"boxborderw={round(fs * 0.35)}"]
            if t["shadow"] and not t["bg_on"]:
                opts += ["shadowcolor=black@0.55", f"shadowx={max(1, fs // 22)}", f"shadowy={max(1, fs // 22)}"]
            fc.append(f"{vcur}drawtext={':'.join(opts)}[vt{k}_{li}]")
            vcur = f"[vt{k}_{li}]"
    # Musik
    mix = [acur]
    for j, a in enumerate(project["audio"]):
        if a["start"] >= total:
            continue
        d = min(a["out"] - a["in"], total - a["start"])
        args += ["-ss", f"{a['in']:.3f}", "-t", f"{d:.3f}", "-i", str(audio_path(a["file_id"]))]
        ai = n
        n += 1
        f = [f"[{ai}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume={a['volume']:.3f}"]
        if a["fade_in"] > 0:
            f.append(f"afade=t=in:st=0:d={min(a['fade_in'], d):.3f}")
        if a["fade_out"] > 0:
            f.append(f"afade=t=out:st={max(0, d - a['fade_out']):.3f}:d={min(a['fade_out'], d):.3f}")
        ms = int(a["start"] * 1000)
        f.append(f"adelay={ms}|{ms}")
        fc.append(",".join(f) + f"[m{j}]")
        mix.append(f"[m{j}]")
    if len(mix) > 1:
        fc.append(f"{''.join(mix)}amix=inputs={len(mix)}:duration=first:normalize=0[amix]")
        acur = "[amix]"
    fc.append(f"{acur}volume={project['master_volume']:.3f},alimiter=limit=0.95,atrim=duration={total:.3f}[aout]")
    fc.append(f"{vcur}trim=duration={total:.3f},format=yuv420p[vout]")
    (workdir / "filter.txt").write_text(";\n".join(fc))
    args += ["-filter_complex_script", str(workdir / "filter.txt"), "-map", "[vout]", "-map", "[aout]",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", str(FPS), "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-t", f"{total:.3f}", str(out)]
    return args, total


class ProjectIn(BaseModel):
    project: dict


class RenderIn(BaseModel):
    title: str = ""
    playlist_ids: list[int] = []


def make_editor_router(data_dir: Path, require_admin: Callable, media_lookup: Callable[[str], Optional[dict]],
                       register_media: Callable, add_to_playlists: Callable):
    root = data_dir / "editor"
    pdir, adir, wdir = root / "projects", root / "audio", root / "render"
    for d in (pdir, adir, wdir):
        d.mkdir(parents=True, exist_ok=True)
    probe_cache: dict = {}
    renders: dict = {}  # project_id -> Status
    lock = threading.Lock()
    r = APIRouter()

    def probe(path: Path) -> dict:
        key = (str(path), path.stat().st_mtime)
        if key in probe_cache:
            return probe_cache[key]
        try:
            res = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
                                  "-of", "json", str(path)], capture_output=True, text=True, timeout=30)
            j = json.loads(res.stdout or "{}")
        except (OSError, ValueError, subprocess.SubprocessError):
            j = {}
        streams = j.get("streams") or []
        v = next((s for s in streams if s.get("codec_type") == "video"), {})
        info = {"duration": float((j.get("format") or {}).get("duration") or 0), "width": v.get("width"), "height": v.get("height"),
                "has_audio": any(s.get("codec_type") == "audio" for s in streams)}
        probe_cache[key] = info
        return info

    def media_info(media_id: str) -> Optional[dict]:
        m = media_lookup(media_id)
        if not m:
            return None
        info = probe(Path(m["path"])) if m["type"] == "video" else {"duration": 0, "has_audio": False}
        return {**m, **info}

    def audio_file(fid: str) -> Optional[Path]:
        if not re.fullmatch(r"[0-9a-f]{32}", fid or ""):
            return None
        hits = [p for p in adir.glob(fid + ".*") if p.suffix != ".json"]
        return hits[0] if hits else None

    def load(pid: str) -> dict:
        if not re.fullmatch(r"[0-9a-f]{32}", pid or ""):
            raise HTTPException(404, "Projekt unbekannt")
        try:
            return json.loads((pdir / f"{pid}.json").read_text())
        except (OSError, ValueError):
            raise HTTPException(404, "Projekt unbekannt")

    def save(p: dict):
        tmp = pdir / f"{p['id']}.tmp"
        tmp.write_text(json.dumps(p))
        tmp.replace(pdir / f"{p['id']}.json")

    # ------------------------------------------------ Projekte
    @r.get("/api/admin/editor/projects", dependencies=[Depends(require_admin)])
    def list_projects():
        out = []
        for f in pdir.glob("*.json"):
            try:
                p = json.loads(f.read_text())
            except ValueError:
                continue
            out.append({"id": p["id"], "name": p["name"], "format": p["format"], "updated": p.get("updated", 0),
                        "clips": len(p["clips"]), "duration": timeline(p["clips"])[1] if p["clips"] else 0,
                        "render": renders.get(p["id"])})
        return sorted(out, key=lambda x: x["updated"], reverse=True)

    @r.post("/api/admin/editor/projects", dependencies=[Depends(require_admin)])
    def create_project(body: ProjectIn):
        p = clean_project(body.project, media_info, lambda f: audio_file(f) is not None)
        p.update(id=uuid.uuid4().hex, created=time.time(), updated=time.time())
        save(p)
        return p

    @r.get("/api/admin/editor/projects/{pid}", dependencies=[Depends(require_admin)])
    def get_project(pid: str):
        return {**load(pid), "render": renders.get(pid)}

    @r.put("/api/admin/editor/projects/{pid}", dependencies=[Depends(require_admin)])
    def update_project(pid: str, body: ProjectIn):
        old = load(pid)
        p = clean_project(body.project, media_info, lambda f: audio_file(f) is not None)
        p.update(id=pid, created=old.get("created", time.time()), updated=time.time())
        save(p)
        return p

    @r.delete("/api/admin/editor/projects/{pid}", dependencies=[Depends(require_admin)])
    def delete_project(pid: str):
        load(pid)
        (pdir / f"{pid}.json").unlink(missing_ok=True)
        return {"ok": True}

    # ------------------------------------------------ Medien-Infos (Länge, Ton) für die Zeitleiste
    @r.get("/api/admin/editor/media/{media_id}", dependencies=[Depends(require_admin)])
    def editor_media(media_id: str):
        m = media_info(media_id)
        if not m:
            raise HTTPException(404, "Nicht gefunden")
        return {k: v for k, v in m.items() if k != "path"}

    # ------------------------------------------------ Musik / Ton
    @r.get("/api/admin/editor/audio", dependencies=[Depends(require_admin)])
    def list_audio():
        out = []
        for meta in adir.glob("*.json"):
            try:
                a = json.loads(meta.read_text())
            except ValueError:
                continue
            if audio_file(a["id"]):
                out.append(a)
        return sorted(out, key=lambda a: a.get("created", 0), reverse=True)

    def register_audio(tmp: Path, filename: str) -> dict:
        ext = Path(filename).suffix.lower()
        if ext not in AUDIO_EXT:
            tmp.unlink(missing_ok=True)
            raise HTTPException(400, "Bitte eine Audiodatei (MP3, M4A, WAV, OGG, FLAC) hochladen")
        fid = uuid.uuid4().hex
        dest = adir / (fid + ext)
        shutil.move(str(tmp), dest)
        info = probe(dest)
        if not info["has_audio"] or info["duration"] <= 0:
            dest.unlink(missing_ok=True)
            raise HTTPException(400, "Die Datei enthält keinen lesbaren Ton")
        a = {"id": fid, "name": Path(filename).stem[:120], "duration": round(info["duration"], 3), "created": time.time()}
        (adir / f"{fid}.json").write_text(json.dumps(a))
        return a

    @r.get("/api/admin/editor/audio/{fid}/file", dependencies=[Depends(require_admin)])
    def audio_get(fid: str):
        f = audio_file(fid)
        if not f:
            raise HTTPException(404, "Nicht gefunden")
        return FileResponse(f)

    @r.delete("/api/admin/editor/audio/{fid}", dependencies=[Depends(require_admin)])
    def audio_delete(fid: str):
        f = audio_file(fid)
        if f:
            f.unlink(missing_ok=True)
        (adir / f"{fid}.json").unlink(missing_ok=True)
        return {"ok": True}

    # ------------------------------------------------ Rendern
    def run_render(pid: str, p: dict, title: str, playlist_ids: list[int]):
        work = wdir / pid
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        out = work / "video.mp4"
        st = renders[pid]
        try:
            args, total = build_ffmpeg(p, lambda mid: media_info(mid), lambda fid: audio_file(fid), work, out)
            proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            for line in proc.stdout:
                if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                    try:
                        st["progress"] = min(0.99, int(line.split("=")[1]) / 1e6 / max(total, 0.1))
                    except ValueError:
                        pass
            err = proc.stderr.read()
            if proc.wait() != 0 or not out.exists():
                raise RuntimeError((err.strip().splitlines() or ["ffmpeg-Fehler"])[-1][:300])
            st.update(state="saving", progress=1)
            m = register_media(out, f"{title or p['name']}.mp4", "video/mp4", title or p["name"])
            if playlist_ids:
                add_to_playlists(m["id"], playlist_ids)
            st.update(state="done", media_id=m["id"], finished=time.time())
        except HTTPException as e:
            st.update(state="error", error=e.detail)
        except Exception as e:  # noqa: BLE001 – Fehler dem Nutzer zeigen statt still abbrechen
            st.update(state="error", error=str(e))
        finally:
            shutil.rmtree(work, ignore_errors=True)

    @r.post("/api/admin/editor/projects/{pid}/render", dependencies=[Depends(require_admin)])
    def render(pid: str, body: RenderIn):
        p = load(pid)
        with lock:
            if any(s.get("state") in ("rendering", "saving") for s in renders.values()):
                raise HTTPException(409, "Es wird gerade schon ein Video erstellt – bitte kurz warten")
            renders[pid] = {"state": "rendering", "progress": 0, "started": time.time()}
        threading.Thread(target=run_render, args=(pid, p, body.title.strip()[:120], body.playlist_ids), daemon=True).start()
        return renders[pid]

    @r.get("/api/admin/editor/projects/{pid}/render", dependencies=[Depends(require_admin)])
    def render_status(pid: str):
        return renders.get(pid) or {"state": "none"}

    return r, register_audio
