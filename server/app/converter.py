"""3D-Konverter (Reiter "3D-Konverter"): fast jede 3D-Datei → druckbares Modell für den Adventurer 5M.

Werkzeugkette (je Format das beste zuerst, bei Fehlern das nächste):
  - trimesh      STL, OBJ, PLY, OFF, GLB/GLTF, 3MF, DAE … und 2D-Zeichnungen (SVG, DXF) zum Herausziehen
  - gmsh (OCC)   CAD: STEP/STP, IGES/IGS, BREP – und FreeCAD-Dateien (FCStd enthalten BREP-Körper)
  - OpenSCAD     .scad
  - Blender      .blend, USD/USDZ, Alembic, FBX, X3D, glTF … (läuft ohne Bildschirm)
  - Assimp       ca. 70 Formate (FBX, 3DS, DAE, X, LWO, MS3D, MD2/3/5, B3D, AC, ASE, IFC, OGEX …)
  - PyMeshLab    VRML (WRL), CTM, GTS, PDB … und Punktwolken (XYZ, PTS, ASC, PCD) per Flächen-Rekonstruktion
  - PrusaSlicer  am Ende: G-Code für den Drucker (über den 3D-Slicer)
Danach repariert trimesh das Netz, rechnet Einheiten um, legt das Teil stabil aufs Bett und prüft die Größe.
"""
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

BED = (220.0, 220.0, 220.0)
MAX_INPUT = 500 * 1024 * 1024
TOOL_TIMEOUT = 600

# Format → Werkzeuge in Reihenfolge
CAD = {".step", ".stp", ".iges", ".igs", ".brep", ".brp"}
TRIMESH = {".stl", ".obj", ".ply", ".off", ".glb", ".gltf", ".3mf", ".dae", ".stl_ascii"}
PLANAR = {".svg", ".dxf"}
BLENDER = {".blend", ".usd", ".usda", ".usdc", ".usdz", ".abc", ".fbx", ".x3d", ".wrl", ".glb", ".gltf", ".obj", ".ply", ".stl", ".dae"}
ASSIMP = {".3d", ".3ds", ".3mf", ".ac", ".ac3d", ".acc", ".amf", ".ase", ".ask", ".assbin", ".b3d", ".blend", ".bsp", ".bvh", ".cob", ".csm",
          ".dae", ".dxf", ".enff", ".fbx", ".glb", ".gltf", ".hmp", ".ifc", ".ifczip", ".iqm", ".irr", ".irrmesh", ".lwo", ".lws", ".lxo",
          ".md2", ".md3", ".md5mesh", ".mdc", ".mdl", ".mesh", ".ms3d", ".ndo", ".nff", ".obj", ".off", ".ogex", ".pk3", ".ply", ".pmx",
          ".prj", ".q3o", ".q3s", ".raw", ".scn", ".sib", ".smd", ".stl", ".ter", ".uc", ".vta", ".x", ".x3d", ".x3db", ".xgl", ".zae", ".zgl"}
MESHLAB = {".wrl", ".ctm", ".gts", ".tri", ".pdb", ".x3dv", ".ptx", ".bre", ".apts", ".qobj", ".vmi", ".es", ".xyz", ".pts", ".asc", ".pcd", ".e57"}
POINTS = {".xyz", ".pts", ".asc", ".pcd", ".ptx", ".e57", ".apts"}
GCODE = {".gcode", ".gco", ".g", ".gx", ".bgcode"}
ARCHIVES = {".zip", ".gz", ".fcstd"}
# Formate in Metern (Blender, glTF, USD): kleine Werte → in mm umrechnen
METER_FORMATS = {".glb", ".gltf", ".usd", ".usda", ".usdc", ".usdz", ".abc", ".blend", ".fbx", ".x3d", ".wrl"}


def tools() -> dict:
    """Welche Werkzeuge sind installiert?"""
    def has_py(mod):  # nur nachsehen, nicht laden (große Bibliotheken bleiben aus dem Server-Prozess)
        import importlib.util
        try:
            return importlib.util.find_spec(mod) is not None
        except Exception:  # noqa: BLE001
            return False
    return {"trimesh": has_py("trimesh"), "gmsh": has_py("gmsh"), "pymeshlab": has_py("pymeshlab"), "shapely": has_py("shapely"),
            "openscad": bool(shutil.which("openscad")), "blender": bool(shutil.which("blender")), "assimp": bool(shutil.which("assimp")),
            "prusa": bool(shutil.which("prusa-slicer"))}


def all_extensions() -> list[str]:
    return sorted(CAD | TRIMESH | PLANAR | BLENDER | ASSIMP | MESHLAB | GCODE | ARCHIVES | {".scad"} - {".stl_ascii"})


def ext_of(name: str) -> str:
    n = name.lower()
    for e in (".mesh.xml", ".stl.gz"):
        if n.endswith(e):
            return e
    return Path(n).suffix


class ConvError(Exception):
    pass


def _run(cmd: list[str], timeout: int = TOOL_TIMEOUT, cwd: Optional[Path] = None) -> str:
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd,
                             env={**os.environ, "HOME": str(cwd or tempfile.gettempdir())})
    except subprocess.TimeoutExpired:
        raise ConvError(f"{Path(cmd[0]).name}: dauert zu lange (über {timeout // 60} Minuten)")
    if res.returncode != 0:
        lines = [l for l in (res.stderr + res.stdout).splitlines() if l.strip()]
        raise ConvError(f"{Path(cmd[0]).name}: " + (lines[-1][:200] if lines else f"Fehler {res.returncode}"))
    return res.stdout


# ------------------------------------------------------------------ einzelne Werkzeuge (Ergebnis: STL-Datei)
def via_trimesh(src: Path, out: Path, opts: dict):
    import trimesh
    m = trimesh.load(str(src), force="mesh", process=False)
    if m is None or not len(getattr(m, "faces", [])):
        raise ConvError("trimesh: keine Flächen gefunden")
    m.export(str(out))


def via_planar(src: Path, out: Path, opts: dict):
    """2D-Zeichnung (SVG/DXF) als Platte herausziehen."""
    import trimesh
    path = trimesh.load_path(str(src))
    h = float(opts.get("extrude_mm") or 3)
    polys = path.polygons_full
    if not len(polys):
        raise ConvError("Die Zeichnung enthält keine geschlossenen Flächen zum Herausziehen")
    meshes = [trimesh.creation.extrude_polygon(p, h) for p in polys]
    m = trimesh.util.concatenate(meshes)
    if ext_of(src.name) == ".svg":  # SVG: y zeigt nach unten → spiegeln
        m.apply_transform(trimesh.transformations.reflection_matrix([0, 0, 0], [0, 1, 0]))
        m.invert()
    m.export(str(out))


def via_gmsh(src: Path, out: Path, opts: dict, extra: Optional[list[Path]] = None):
    """CAD-Körper (STEP/IGES/BREP) vernetzen. Läuft in eigenem Prozess (gmsh ist nicht threadsicher)."""
    files = [str(p) for p in (extra or [src])]
    quality = {"fein": 0.15, "normal": 0.5, "grob": 1.5}.get(opts.get("quality") or "normal", 0.5)
    script = f"""
import gmsh, sys
gmsh.initialize(["-noenv"])
gmsh.option.setNumber("General.Terminal", 0)
if any(f.lower().endswith((".iges", ".igs")) for f in {files!r}):
    gmsh.option.setNumber("Geometry.OCCSewFaces", 1)  # IGES: einzelne Flächen zu einem Körper vernähen
if any(f.lower().endswith((".step", ".stp")) for f in {files!r}):
    gmsh.option.setString("Geometry.OCCTargetUnit", "MM")  # STEP: in Millimetern einlesen
for f in {files!r}:
    gmsh.merge(f)
xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.getBoundingBox(-1, -1)
size = max(xmax - xmin, ymax - ymin, zmax - zmin) or 1
gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 24)
gmsh.option.setNumber("Mesh.MeshSizeMax", size * {quality} / 10)
gmsh.option.setNumber("Mesh.MeshSizeMin", size / 2000)
gmsh.option.setNumber("Mesh.Algorithm", 6)
gmsh.model.mesh.generate(2)
gmsh.option.setNumber("Mesh.Binary", 1)
gmsh.write({str(out)!r})
gmsh.finalize()
"""
    _run([sys.executable, "-c", script], cwd=out.parent)
    if not out.exists() or out.stat().st_size < 100:
        raise ConvError("gmsh: kein Ergebnis (leerer CAD-Körper?)")


def via_openscad(src: Path, out: Path, opts: dict):
    _run(["openscad", "-o", str(out), str(src)], cwd=src.parent)


BLENDER_SCRIPT = r"""
import bpy, sys, os
src, out = sys.argv[sys.argv.index("--") + 1:][:2]
ext = os.path.splitext(src)[1].lower()
if ext != ".blend":
    bpy.ops.wm.read_factory_settings(use_empty=True)
imp = {
    ".usd": lambda: bpy.ops.wm.usd_import(filepath=src), ".usda": lambda: bpy.ops.wm.usd_import(filepath=src),
    ".usdc": lambda: bpy.ops.wm.usd_import(filepath=src), ".usdz": lambda: bpy.ops.wm.usd_import(filepath=src),
    ".abc": lambda: bpy.ops.wm.alembic_import(filepath=src),
    ".fbx": lambda: bpy.ops.import_scene.fbx(filepath=src),
    ".glb": lambda: bpy.ops.import_scene.gltf(filepath=src), ".gltf": lambda: bpy.ops.import_scene.gltf(filepath=src),
    ".obj": lambda: bpy.ops.wm.obj_import(filepath=src), ".ply": lambda: bpy.ops.wm.ply_import(filepath=src),
    ".stl": lambda: bpy.ops.wm.stl_import(filepath=src),
    ".dae": lambda: bpy.ops.wm.collada_import(filepath=src),
    ".x3d": lambda: bpy.ops.import_scene.x3d(filepath=src), ".wrl": lambda: bpy.ops.import_scene.x3d(filepath=src),
}
if ext == ".blend":
    bpy.ops.wm.open_mainfile(filepath=src)
else:
    imp[ext]()
# alles Sichtbare (auch Kurven, Text, Modifikatoren) zu Netzen machen und gemeinsam exportieren
dg = bpy.context.evaluated_depsgraph_get()
import bmesh
bm = bmesh.new()
for ob in list(bpy.context.scene.objects):
    if ob.type not in {"MESH", "CURVE", "SURFACE", "META", "FONT"} or ob.hide_render or ob.hide_get():
        continue
    eo = ob.evaluated_get(dg)
    me = eo.to_mesh()
    if me is None:
        continue
    me.transform(ob.matrix_world)
    bm.from_mesh(me)
    eo.to_mesh_clear()
if not bm.faces:
    raise SystemExit("keine Flächen")
bmesh.ops.triangulate(bm, faces=bm.faces[:])
with open(out, "w") as f:
    f.write("solid blender\n")
    for face in bm.faces:
        n = face.normal
        f.write(f"facet normal {n.x} {n.y} {n.z}\nouter loop\n")
        for v in face.verts:
            f.write(f"vertex {v.co.x} {v.co.y} {v.co.z}\n")
        f.write("endloop\nendfacet\n")
    f.write("endsolid blender\n")
"""


def via_blender(src: Path, out: Path, opts: dict):
    script = out.parent / "blender_export.py"
    script.write_text(BLENDER_SCRIPT)
    _run(["blender", "-b", "--factory-startup", "-noaudio", "--python", str(script), "--", str(src), str(out)], cwd=out.parent)
    if not out.exists() or out.stat().st_size < 100:
        raise ConvError("Blender: kein Ergebnis")


def via_assimp(src: Path, out: Path, opts: dict):
    _run(["assimp", "export", str(src), str(out), "-fstlb", "-tri", "-jiv", "-fd"], cwd=out.parent)
    if not out.exists() or out.stat().st_size < 100:
        raise ConvError("Assimp: kein Ergebnis")


def via_meshlab(src: Path, out: Path, opts: dict):
    import pymeshlab
    ms = pymeshlab.MeshSet()
    ms.load_new_mesh(str(src))
    m = ms.current_mesh()
    if m.face_number() == 0:  # Punktwolke → Fläche rekonstruieren
        if m.vertex_number() < 20:
            raise ConvError("PyMeshLab: zu wenige Punkte")
        ms.compute_normal_for_point_clouds(k=10)
        ms.generate_surface_reconstruction_screened_poisson(depth=8)
    ms.save_current_mesh(str(out), binary=True)


def chain_for(ext: str, t: dict) -> list[tuple[str, Callable]]:
    c = []
    if ext in CAD and t["gmsh"]:
        c.append(("gmsh (CAD)", via_gmsh))
    if ext == ".scad" and t["openscad"]:
        c.append(("OpenSCAD", via_openscad))
    if ext in PLANAR and t["trimesh"] and t["shapely"]:
        c.append(("trimesh (2D → 3D)", via_planar))
    if ext in TRIMESH and t["trimesh"]:
        c.append(("trimesh", via_trimesh))
    if ext in {".blend", ".usd", ".usda", ".usdc", ".usdz", ".abc"} and t["blender"]:
        c.append(("Blender", via_blender))
    if ext in ASSIMP and t["assimp"]:
        c.append(("Assimp", via_assimp))
    if ext in MESHLAB and t["pymeshlab"]:
        c.append(("PyMeshLab", via_meshlab))
    if ext in BLENDER and t["blender"] and not any(n == "Blender" for n, _ in c):
        c.append(("Blender", via_blender))
    if ext in {".stl", ".obj", ".ply", ".off", ".gltf", ".glb", ".3mf"} and t["pymeshlab"] and not any(n == "PyMeshLab" for n, _ in c):
        c.append(("PyMeshLab", via_meshlab))
    return c


# ------------------------------------------------------------------ Nachbearbeitung
def finish(stl: Path, opts: dict, ext: str) -> dict:
    """Reparieren, Einheiten, Lage, Größe prüfen – überschreibt stl, liefert Infos."""
    import numpy as np
    import trimesh
    m = trimesh.load(str(stl), force="mesh")
    if not len(m.faces):
        raise ConvError("Das Modell hat keine Flächen")
    notes = []
    before = len(m.faces)
    m.merge_vertices()
    m.update_faces(m.nondegenerate_faces())
    m.update_faces(m.unique_faces())
    m.remove_unreferenced_vertices()
    trimesh.repair.fix_normals(m)
    trimesh.repair.fill_holes(m)
    if len(m.faces) != before:
        notes.append(f"{before - len(m.faces)} kaputte Dreiecke entfernt")
    # Einheiten
    unit = opts.get("unit") or "auto"
    ext_size = float(max(m.extents))
    factor = {"mm": 1, "cm": 10, "m": 1000, "in": 25.4}.get(unit, 1)
    if unit == "auto":
        if ext_size < 1.0 or (ext in METER_FORMATS and ext_size < 5):
            factor = 1000
            notes.append("Maße waren in Metern – in Millimeter umgerechnet")
        elif ext_size < 4:
            factor = 25.4
            notes.append("Sehr klein – als Zoll angenommen und umgerechnet")
    if factor != 1:
        m.apply_scale(factor)
    # Lage
    orient = opts.get("orient") or "stable"
    if orient == "stable" and len(m.faces) < 400_000:
        try:
            poses, probs = m.compute_stable_poses(n_samples=1, threshold=0.0)
            if len(poses):
                m.apply_transform(poses[int(np.argmax(probs))])
                notes.append("Stabil aufs Druckbett gelegt")
        except Exception:  # noqa: BLE001
            pass
    elif orient == "yup":
        m.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0]))
    # aufs Bett und in die Mitte
    lo, hi = m.bounds
    m.apply_translation([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]])
    ext3 = [float(v) for v in m.extents]
    fits = all(e <= b for e, b in zip(ext3, BED))
    if not fits and opts.get("fit"):
        s = min(b / e for e, b in zip(ext3, BED) if e > 0) * 0.98
        m.apply_scale(s)
        ext3 = [float(v) for v in m.extents]
        notes.append(f"Auf das Druckbett verkleinert ({s * 100:.0f} %)")
        fits = True
    scale_pct = float(opts.get("scale") or 100)
    if abs(scale_pct - 100) > 0.01:
        m.apply_scale(scale_pct / 100)
        ext3 = [float(v) for v in m.extents]
        fits = all(e <= b for e, b in zip(ext3, BED))
    m.export(str(stl))
    return {"size_mm": [round(v, 2) for v in ext3], "fits": fits, "triangles": int(len(m.faces)),
            "watertight": bool(m.is_watertight), "volume_cm3": round(float(abs(m.volume)) / 1000, 2) if m.is_watertight else None,
            "notes": notes}


# ------------------------------------------------------------------ Aufträge
class ConvOptions(BaseModel):
    unit: str = "auto"        # auto | mm | cm | m | in
    orient: str = "stable"    # stable | file | yup
    fit: bool = False         # zu groß → aufs Druckbett verkleinern
    scale: float = 100
    quality: str = "normal"   # CAD/Punktwolken: fein | normal | grob
    extrude_mm: float = 3     # SVG/DXF: Höhe


class ToSlicer(BaseModel):
    print_after: bool = False


def make_converter_router(data_dir: Path, require_admin: Callable, register_druck_job: Callable):
    root = (data_dir / "converter").resolve()
    root.mkdir(parents=True, exist_ok=True)
    sem = threading.Semaphore(1)  # Blender & Co. brauchen viel Speicher: eins nach dem anderen
    r = APIRouter()

    def jdir(jid: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{32}", jid or ""):
            raise HTTPException(404, "Unbekannt")
        d = root / jid
        if not (d / "job.json").exists():
            raise HTTPException(404, "Unbekannt")
        return d

    def load(jid: str) -> dict:
        return json.loads((jdir(jid) / "job.json").read_text())

    def save(j: dict):
        p = root / j["id"] / "job.json"
        p.with_suffix(".tmp").write_text(json.dumps(j))
        p.with_suffix(".tmp").replace(p)

    def run(jid: str):
        """Umwandlung in eigenem Prozess (abstürzende Werkzeuge reißen den Server nicht mit)."""
        with sem:
            d = (root / jid).resolve()
            j = load(jid)
            j.update(state="converting", log=[])
            save(j)
            try:
                res = subprocess.run([sys.executable, "-c", "import sys; from app.converter import process_job; process_job(sys.argv[1])", str(d)],
                                     cwd=str(Path(__file__).resolve().parents[1]), capture_output=True, text=True, timeout=1800)
                j = load(jid)
                if j["state"] == "converting":
                    j.update(state="error", error="Umwandlung abgebrochen" + (f" ({res.stderr.strip().splitlines()[-1][:200]})" if res.stderr.strip() else ""))
                    save(j)
            except subprocess.TimeoutExpired:
                j = load(jid)
                j.update(state="error", error="Umwandlung hat zu lange gedauert (über 30 Minuten)")
                save(j)

    def register_upload(tmp: Path, filename: str, options: dict) -> dict:
        """Hochgeladene Datei übernehmen (vom Upload in Stücken) und Umwandlung starten."""
        jid = uuid.uuid4().hex
        d = root / jid
        d.mkdir(parents=True)
        safe = re.sub(r"[^\w.\-]+", "_", Path(filename).name)[-120:] or "modell"
        shutil.move(str(tmp), d / ("eingabe_" + safe))
        try:
            opts = ConvOptions(**(options or {})).model_dump()
        except Exception:  # noqa: BLE001
            opts = ConvOptions().model_dump()
        j = {"id": jid, "name": Path(filename).name, "input": "eingabe_" + safe, "ext": ext_of(filename), "state": "queued",
             "created": time.time(), "options": opts, "log": []}
        save(j)
        threading.Thread(target=run, args=(jid,), daemon=True).start()
        # alte Aufträge aufräumen (14 Tage)
        for old in root.iterdir():
            try:
                if time.time() - old.stat().st_mtime > 14 * 86400:
                    shutil.rmtree(old, ignore_errors=True)
            except OSError:
                pass
        return j

    @r.get("/api/admin/convert/formats", dependencies=[Depends(require_admin)])
    def formats():
        t = tools()
        groups = [
            ("Druckfertig / Slicer-Formate", [".stl", ".3mf", ".obj", ".amf"]),
            ("CAD (Konstruktion)", [".step", ".stp", ".iges", ".igs", ".brep", ".fcstd", ".scad"]),
            ("3D-Programme & Spiele", [".blend", ".fbx", ".3ds", ".dae", ".glb", ".gltf", ".usd", ".usdz", ".abc", ".x3d", ".wrl", ".x", ".lwo", ".ms3d", ".b3d", ".ifc", ".ply", ".off"]),
            ("Punktwolken / Scans", [".xyz", ".pts", ".asc", ".pcd", ".ptx", ".e57"]),
            ("2D-Zeichnungen (werden herausgezogen)", [".svg", ".dxf"]),
            ("Archive", [".zip", ".gz"]),
        ]
        return {"tools": t, "groups": [{"name": n, "ext": e} for n, e in groups], "all": all_extensions()}

    @r.get("/api/admin/convert/jobs", dependencies=[Depends(require_admin)])
    def list_jobs():
        out = []
        for d in root.iterdir():
            try:
                out.append(json.loads((d / "job.json").read_text()))
            except (OSError, ValueError):
                continue
        return sorted(out, key=lambda j: j["created"], reverse=True)[:30]

    @r.get("/api/admin/convert/jobs/{jid}", dependencies=[Depends(require_admin)])
    def get_job(jid: str):
        return load(jid)

    @r.get("/api/admin/convert/jobs/{jid}/file/{name}", dependencies=[Depends(require_admin)])
    def get_file(jid: str, name: str, fmt: str = "stl"):
        j = load(jid)
        part = next((p for p in j.get("parts") or [] if p["file"] == name), None)
        if not part:
            raise HTTPException(404, "Nicht gefunden")
        stl = jdir(jid) / name
        base = re.sub(r"[^\w\- ]+", "_", part["name"])[:80] or "modell"
        if fmt == "3mf":
            out = stl.with_suffix(".3mf")
            if not out.exists():
                import trimesh
                trimesh.load(str(stl), force="mesh").export(str(out))
            return FileResponse(out, media_type="model/3mf", filename=f"{base}.3mf")
        if fmt == "obj":
            out = stl.with_suffix(".obj")
            if not out.exists():
                import trimesh
                trimesh.load(str(stl), force="mesh").export(str(out))
            return FileResponse(out, media_type="text/plain", filename=f"{base}.obj")
        return FileResponse(stl, media_type="model/stl", filename=f"{base}.stl")

    @r.post("/api/admin/convert/jobs/{jid}/to-slicer/{name}", dependencies=[Depends(require_admin)])
    def to_slicer(jid: str, name: str):
        """Umgewandeltes Modell als Auftrag im 3D-Slicer anlegen (wird dort mit dem Drucker-Profil zu G-Code)."""
        j = load(jid)
        part = next((p for p in j.get("parts") or [] if p["file"] == name), None)
        if not part:
            raise HTTPException(404, "Nicht gefunden")
        tmp = Path(tempfile.mkstemp(suffix=".stl", dir=root)[1])
        shutil.copy2(jdir(jid) / name, tmp)
        job = register_druck_job(tmp, f"{part['name']}.stl", {})
        part["slicer_job"] = job.get("id") if isinstance(job, dict) else None
        save(j)
        return {"job": job}

    @r.delete("/api/admin/convert/jobs/{jid}", dependencies=[Depends(require_admin)])
    def delete_job(jid: str):
        shutil.rmtree(jdir(jid), ignore_errors=True)
        return {"ok": True}

    return r, register_upload


# ------------------------------------------------------------------ Umwandlung (läuft in eigenem Prozess)
def unpack(src: Path, work: Path) -> list[Path]:
    """ZIP/GZ/FCStd auspacken → Liste der Modelldateien."""
    ext = ext_of(src.name)
    if ext in (".gz", ".stl.gz"):
        inner = work / src.name[:-3]
        with gzip.open(src, "rb") as fi, open(inner, "wb") as fo:
            shutil.copyfileobj(fi, fo, 1024 * 1024)
        return [inner]
    if ext == ".fcstd":  # FreeCAD: die Körper liegen als BREP im ZIP
        out = work / "fcstd"
        out.mkdir()
        with zipfile.ZipFile(src) as z:
            breps = [n for n in z.namelist() if n.lower().endswith((".brp", ".brep")) and ".." not in n]
            for n in breps:
                (out / Path(n).name).write_bytes(z.read(n))
        files = sorted(out.iterdir())
        if not files:
            raise ConvError("In der FreeCAD-Datei sind keine Körper gespeichert")
        return [out / "_fcstd_"] + files  # Platzhalter: alle zusammen vernetzen
    if ext == ".zip":
        out = work / "zip"
        out.mkdir()
        models = []
        with zipfile.ZipFile(src) as z:
            for n in z.namelist():
                if ".." in n or n.endswith("/") or "__MACOSX" in n:
                    continue
                e = ext_of(n)
                if e in set(all_extensions()) - {".zip"} and z.getinfo(n).file_size < MAX_INPUT:
                    p = out / f"{len(models):03d}_{Path(n).name}"
                    p.write_bytes(z.read(n))
                    models.append(p)
        if not models:
            raise ConvError("Im ZIP ist keine bekannte 3D-Datei")
        return models[:20]
    return [src]

def convert_one(src: Path, work: Path, opts: dict, log: list) -> tuple[Path, str, str]:
    ext = ext_of(src.name)
    t = tools()
    if src.name == "_fcstd_":
        return None, ".fcstd", ""  # wird gesondert behandelt
    chain = chain_for(ext, t)
    if not chain:
        raise ConvError(f"Für „{ext}“ ist kein Werkzeug installiert")
    errors = []
    for name, fn in chain:
        out = work / f"{src.stem}.{uuid.uuid4().hex[:6]}.stl"
        try:
            fn(src, out, opts)
            log.append(f"{name}: ok")
            return out, ext, name
        except Exception as e:  # noqa: BLE001 – nächstes Werkzeug probieren
            msg = str(e)[:200]
            errors.append(f"{name}: {msg}")
            log.append(f"{name}: {msg}")
    raise ConvError("Kein Werkzeug konnte die Datei lesen – " + " · ".join(errors))



def process_job(dir_: str):
    d = Path(dir_).resolve()
    jf = d / "job.json"
    j = json.loads(jf.read_text())
    work = d / "work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()

    def save():
        jf.with_suffix(".tmp").write_text(json.dumps(j))
        jf.with_suffix(".tmp").replace(jf)

    try:
        src = d / j["input"]
        ext = ext_of(src.name)
        if ext in GCODE:
            raise ConvError("Das ist schon eine Druckdatei (G-Code) – einfach im 3D-Slicer hochladen und drucken.")
        files = unpack(src, work)
        results = []
        if files and files[0].name == "_fcstd_":
            out = work / "freecad.stl"
            via_gmsh(files[1], out, j["options"], extra=files[1:])
            j["log"].append(f"gmsh (FreeCAD, {len(files) - 1} Körper): ok")
            results.append((out, ".fcstd", "gmsh (FreeCAD)", src.name))
        else:
            for f in files:
                try:
                    out, e, tool = convert_one(f, work, j["options"], j["log"])
                    results.append((out, e, tool, f.name))
                except ConvError as err:
                    if len(files) == 1:
                        raise
                    j["log"].append(f"{f.name}: {err}")
        if not results:
            raise ConvError("Keine der Dateien ließ sich umwandeln")
        parts = []
        for i, (out, e, tool, name) in enumerate(results):
            info = finish(out, j["options"], e)
            final = d / (f"modell_{i + 1}.stl" if len(results) > 1 else "modell.stl")
            shutil.move(str(out), final)
            nm = re.sub(r"^\d{3}_", "", Path(name).name)
            nm = re.sub(r"(\.[a-z0-9]{1,6})+$", "", nm, flags=re.I) or "modell"
            if nm.startswith("eingabe_"):
                nm = nm[8:]
            parts.append({"file": final.name, "name": nm, "tool": tool, **info})
        j.update(state="done", parts=parts, finished=time.time())
    except ConvError as e:
        j.update(state="error", error=str(e))
    except Exception as e:  # noqa: BLE001
        j.update(state="error", error=f"Unerwarteter Fehler: {str(e)[:250]}")
    finally:
        shutil.rmtree(work, ignore_errors=True)
        save()
