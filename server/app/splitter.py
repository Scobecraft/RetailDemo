"""Zu große Modelle sinnvoll zerteilen (3D-Konverter).

Vorgehen („nachdenken“):
  1. Passt ein Teil gedreht aufs Druckbett (hingelegt oder schräg/diagonal), wird nicht geschnitten.
  2. Sonst werden entlang jeder zu langen Achse viele Schnittebenen probiert und bewertet:
     kleine Schnittfläche (natürliche Engstellen), keine zerbrechlichen Mini-Inseln, genug Fläche für
     Steckstifte, möglichst ausgewogene Teile. Die beste Ebene gewinnt; das wiederholt sich, bis alles passt.
  3. Jede Schnittfläche bekommt passgenaue Löcher für Steckstifte (werden extra gedruckt). Die Stifte sitzen
     unsymmetrisch bzw. sind unterschiedlich dick – so lassen sich die Teile nur richtig herum zusammenstecken.
  4. Jedes Teil liegt mit einer glatten Schnittfläche auf dem Druckbett (sauberer Druck, flache Klebefläche).
"""
import math
from typing import Optional

import numpy as np
import trimesh

# manifold3d (für saubere Schnitte und Löcher) erst laden, wenn wirklich zerteilt wird
def _mf():
    from manifold3d import Manifold, Mesh
    return Manifold, Mesh

BED = 220.0
LIMIT = 212.0        # etwas Rand lassen
PIN_SETS = [(5.0, 6.0), (3.0, 4.5)]  # (Stift-Ø, Lochtiefe je Seite) – zuerst groß, sonst klein
HOLE_PLAY = 0.3      # Loch etwas größer als der Stift (Kleber, Drucktoleranz)
WALL = 2.0           # Material um ein Loch herum
MAX_PARTS = 24


def to_manifold(m: trimesh.Trimesh):
    Manifold, Mesh = _mf()
    return Manifold(Mesh(vert_properties=np.asarray(m.vertices, np.float32), tri_verts=np.asarray(m.faces, np.uint32)))


def to_trimesh(M) -> trimesh.Trimesh:
    mm = M.to_mesh()
    return trimesh.Trimesh(np.asarray(mm.vert_properties)[:, :3], np.asarray(mm.tri_verts), process=True)


# ------------------------------------------------------------------ passt es (gedreht) aufs Bett?
def _rot_to(v_from, v_to) -> np.ndarray:
    v_from, v_to = np.asarray(v_from, float), np.asarray(v_to, float)
    v_from /= np.linalg.norm(v_from); v_to /= np.linalg.norm(v_to)
    c = float(np.dot(v_from, v_to))
    if c > 1 - 1e-9:
        return np.eye(4)
    if c < -1 + 1e-9:
        axis = np.cross(v_from, [1, 0, 0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(v_from, [0, 1, 0])
        return trimesh.transformations.rotation_matrix(math.pi, axis)
    return trimesh.transformations.rotation_matrix(math.acos(c), np.cross(v_from, v_to))


def fit_transform(mesh: trimesh.Trimesh, downs: Optional[list] = None) -> Optional[np.ndarray]:
    """Drehung, mit der das Teil aufs Bett passt (zuerst die gewünschten Unterseiten, dann die 6 Achsrichtungen,
    jeweils auch schräg in der Ebene). None = passt nicht."""
    cands = list(downs or []) + [d for d in ([0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0])]
    for down in cands:
        R = _rot_to(down, [0, 0, -1])
        v = trimesh.transform_points(mesh.vertices, R)
        if np.ptp(v[:, 2]) > LIMIT:
            continue
        hull = v[:, :2]
        try:
            from scipy.spatial import ConvexHull
            hull = hull[ConvexHull(hull).vertices]
        except Exception:  # noqa: BLE001
            pass
        for deg in range(0, 90, 3):
            a = math.radians(deg)
            rot = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
            p = hull @ rot.T
            if np.ptp(p[:, 0]) <= LIMIT and np.ptp(p[:, 1]) <= LIMIT:
                return trimesh.transformations.rotation_matrix(a, [0, 0, 1]) @ R
    return None


# ------------------------------------------------------------------ Schnittebenen bewerten
def _section(mesh: trimesh.Trimesh, axis: int, pos: float):
    """Querschnitt als (shapely-Geometrie, Matrix 2D→3D) oder (None, None)."""
    from shapely.ops import unary_union
    n = np.zeros(3); n[axis] = 1
    o = np.zeros(3); o[axis] = pos
    try:
        sec3 = mesh.section(plane_origin=o, plane_normal=n)
        if sec3 is None:
            return None, None
        planar, to3d = sec3.to_2D()
        polys = list(planar.polygons_full)
    except Exception:  # noqa: BLE001
        return None, None
    if not polys:
        return None, None
    return unary_union([p.buffer(0) for p in polys]), to3d


def _score(sec, ref_area: float, balance: float) -> float:
    if sec is None or sec.is_empty:
        return 1e9
    geoms = list(getattr(sec, "geoms", [sec]))
    area = sec.area
    s = area / max(ref_area, 1e-6)
    s += 0.5 * (len(geoms) - 1)
    small = min(g.area for g in geoms)
    if small < 120:  # zerbrechliche Mini-Insel (z. B. durch einen dünnen Stab)
        s += 2.0
    if area < 300:   # kaum Klebefläche
        s += 1.5
    s += 0.35 * balance
    return s


def _hits_hole(axis: int, pos: float, holes: list) -> bool:
    """Würde die Ebene ein schon gebohrtes Stiftloch anschneiden?"""
    for c, n, r, depth in holes:
        if abs(n[axis]) > 0.5:      # Loch entlang derselben Achse: Ebene müsste genau durchs Loch gehen
            if abs(pos - c[axis]) < depth + 1.0:
                return True
        elif abs(pos - c[axis]) < r + 1.5:
            return True
    return False


def _best_cut(mesh: trimesh.Trimesh, holes: Optional[list] = None):
    lo, hi = mesh.bounds
    best = None
    ref = None
    for axis in range(3):
        E = hi[axis] - lo[axis]
        if E <= LIMIT:
            continue
        if E <= 2 * LIMIT:
            # jede Ebene hier ergibt zwei Teile, die entlang dieser Achse passen; ganz außen nicht (zu kleine Reste)
            a, b = hi[axis] - LIMIT, lo[axis] + LIMIT
            a2, b2 = max(a, lo[axis] + 0.15 * E), min(b, hi[axis] - 0.15 * E)
            if b2 > a2:
                a, b = a2, b2
        else:
            a, b = lo[axis] + 0.45 * LIMIT, lo[axis] + LIMIT
        if b <= a:
            a = b = (lo[axis] + hi[axis]) / 2
        centre = (a + b) / 2
        for pos in np.linspace(a, b, 36):
            if holes and _hits_hole(axis, float(pos), holes):
                continue
            sec, to3d = _section(mesh, axis, float(pos))
            if sec is None:
                continue
            if ref is None:
                ref = max(sec.area, 1)
            bal = abs(pos - centre) / max((b - a) / 2, 1e-6)
            sc = _score(sec, ref, bal) - 0.15 * (E / LIMIT)  # längste Achse leicht bevorzugen
            if best is None or sc < best[0]:
                best = (sc, axis, float(pos), sec, to3d)
    return best


# ------------------------------------------------------------------ Steckstifte
def _pins(sec, to3d_m, mesh: trimesh.Trimesh, axis: int, pos: float):
    """Positionen der Stifte auf der Schnittfläche (Ebenen-Koordinaten → 3D) mit genug Material dahinter."""
    from shapely.geometry import Point
    from shapely.ops import polylabel
    n = np.zeros(3); n[axis] = 1

    def to3d(p):
        q = trimesh.transform_points([[p[0], p[1], 0.0]], to3d_m)[0]
        q[axis] = pos  # exakt auf der Ebene
        return q

    for d, depth in PIN_SETS:
        r_hole = (d + HOLE_PLAY) / 2
        out = []
        for g in getattr(sec, "geoms", [sec]):
            region = g.buffer(-(r_hole + WALL))
            if region.is_empty:
                continue
            # Platz für mehrere Stifte je Insel: 1 bis 3 je nach Fläche
            want = 1 if g.area < 450 else (2 if g.area < 4000 else 3)
            pts = []
            first = polylabel(region if region.geom_type == "Polygon" else max(region.geoms, key=lambda q: q.area), 0.5)
            pts.append((first.x, first.y))
            minx, miny, maxx, maxy = region.bounds
            grid = [(x, y) for x in np.linspace(minx, maxx, 14) for y in np.linspace(miny, maxy, 14) if region.contains(Point(x, y))]
            while len(pts) < want and grid:
                cand = max(grid, key=lambda q: min(math.dist(q, p) for p in pts))
                if min(math.dist(cand, p) for p in pts) < 2.2 * d:
                    break
                pts.append(cand)
            for p in pts:
                c = to3d(p)
                # genug Material auf beiden Seiten?
                ok = True
                for sgn in (1, -1):
                    hits = mesh.ray.intersects_location([c + sgn * n * 0.05], [sgn * n])[0]
                    if len(hits) == 0 or np.min(np.linalg.norm(hits - c, axis=1)) < depth + 1.2:
                        ok = False
                if ok:
                    out.append(c)
        if out:
            # nur zwei Stifte (und symmetrisch)? → zweiten dünner machen, damit nichts verdreht passt
            sizes = [d] * len(out)
            if len(out) == 2 and d > 3:
                sizes[1] = 3.0
            return [(c, s, depth if s == d else 4.5) for c, s in zip(out, sizes)], n
    return [], n


def _cylinder(c, n, d, length):
    Manifold, _ = _mf()
    cyl = Manifold.cylinder(length, d / 2, d / 2, 48, True)  # entlang Z, zentriert
    T = _rot_to([0, 0, 1], n)
    T[:3, 3] = c
    return cyl.transform(T[:3, :4])


# ------------------------------------------------------------------ zerteilen
def make_solid(mesh: trimesh.Trimesh) -> tuple[trimesh.Trimesh, str]:
    """Für das Zerteilen braucht es einen geschlossenen Körper: reparieren, notfalls Oberfläche neu aufbauen."""
    if to_manifold(mesh).is_empty() is False and mesh.is_watertight:
        return mesh, ""
    try:  # 1. MeshLab: Löcher schließen, kaputte Kanten reparieren
        import pymeshlab
        ms = pymeshlab.MeshSet()
        ms.add_mesh(pymeshlab.Mesh(mesh.vertices, mesh.faces))
        ms.meshing_remove_duplicate_vertices()
        ms.meshing_repair_non_manifold_edges()
        ms.meshing_close_holes(maxholesize=100000)
        cm = ms.current_mesh()
        m2 = trimesh.Trimesh(cm.vertex_matrix(), cm.face_matrix(), process=True)
        trimesh.repair.fix_normals(m2)
        if m2.is_watertight and not to_manifold(m2).is_empty():
            return m2, "Löcher im Modell geschlossen"
    except Exception:  # noqa: BLE001
        pass
    # 2. Oberfläche neu aufbauen (Voxel, ca. 1 mm fein)
    pitch = max(0.6, float(max(mesh.extents)) / 380)
    vox = mesh.voxelized(pitch).fill()
    m3 = vox.marching_cubes
    m3.apply_transform(vox.transform)
    m3 = m3.simplify_quadric_decimation(face_count=min(len(m3.faces), 400_000)) if len(m3.faces) > 400_000 else m3
    trimesh.repair.fix_normals(m3)
    if not to_manifold(m3).is_empty():
        return m3, f"Oberfläche neu aufgebaut (Genauigkeit ca. {pitch:.1f} mm), damit sich das Modell sauber zerteilen lässt"
    raise ValueError("Das Modell ist nicht geschlossen und ließ sich nicht reparieren")


def split_model(mesh: trimesh.Trimesh) -> dict:
    """Zerteilt ein zu großes, geschlossenes Modell. Ergebnis: Teile (in Original-Lage), Schnitte, Stifte."""
    mesh, repair_note = make_solid(mesh)
    M = to_manifold(mesh)
    if M.is_empty():
        raise ValueError("Das Modell ist nicht geschlossen genug zum Zerteilen")
    pieces = [{"M": M, "cut_faces": []}]
    done, cuts, pins_all, holes = [], [], [], []
    guard = 0
    while pieces:
        guard += 1
        if guard > 60 or len(done) + len(pieces) > MAX_PARTS:
            raise ValueError(f"Das Modell müsste in mehr als {MAX_PARTS} Teile zerteilt werden – bitte etwas verkleinern")
        p = pieces.pop()
        tm = to_trimesh(p["M"])
        if fit_transform(tm) is not None:
            done.append(p)
            continue
        best = _best_cut(tm, holes)
        if best is None:
            raise ValueError("Keine sinnvolle Schnittstelle gefunden")
        _, axis, pos, sec, to3d = best
        pins, n = _pins(sec, to3d, tm, axis, pos)
        Mh = p["M"]
        for c, d, depth in pins:
            Mh = Mh - _cylinder(c, n, d + HOLE_PLAY, 2 * depth)
            pins_all.append({"d": d, "len": 2 * depth - 0.6, "c": [float(v) for v in c], "cut": len(cuts)})
            holes.append((c, n, (d + HOLE_PLAY) / 2, depth))
        normal = tuple(float(v) for v in n)
        above, below = Mh.split_by_plane(normal, pos)
        cut_id = len(cuts)
        cuts.append({"axis": "XYZ"[axis], "pos": round(pos, 1), "area_cm2": round(sec.area / 100, 1), "pins": [d for _, d, _ in pins]})
        # Schnittfläche je Teil merken (Außenrichtung, Fläche) – liegt später unten
        for part, outward in ((above, -n), (below, n)):
            if part.is_empty() or part.volume() < 1:
                continue
            pieces.append({"M": part, "cut_faces": p["cut_faces"] + [{"cut": cut_id, "out": outward.tolist(), "area": sec.area}]})
    parts = []
    for i, p in enumerate(done):
        tm = to_trimesh(p["M"])
        parts.append({"mesh": tm, "cut_faces": p["cut_faces"], "center": tm.bounds.mean(axis=0).tolist()})
    # Teile → Schnitte zuordnen
    for c_id, c in enumerate(cuts):
        c["parts"] = [i + 1 for i, p in enumerate(parts) if any(f["cut"] == c_id for f in p["cut_faces"])]
    return {"parts": parts, "cuts": cuts, "pins": pins_all, "note": repair_note}


def _contact(tm: trimesh.Trimesh, down) -> tuple[float, float]:
    """Auflagefläche und Höhe, wenn das Teil mit Richtung `down` nach unten liegt."""
    R = _rot_to(down, [0, 0, -1])
    v = trimesh.transform_points(tm.vertices, R)
    zmin = v[:, 2].min()
    fn = tm.face_normals @ R[:3, :3].T
    tri_z = v[tm.faces][:, :, 2].max(axis=1)
    mask = (fn[:, 2] < -0.995) & (tri_z < zmin + 0.2)
    return float(tm.area_faces[mask].sum()), float(np.ptp(v[:, 2]))


def print_pose(part: dict) -> tuple[trimesh.Trimesh, np.ndarray, bool, bool]:
    """Teil für den Druck hinlegen: die Lage mit großer Auflagefläche und geringer Höhe – glatte Schnittflächen
    bekommen einen Bonus (perfekt flach). Auf dem Bett zentrieren.
    Liefert (Netz, Matrix Druck-Lage → Original-Lage, passt)."""
    tm = part["mesh"].copy()
    cut_downs = [f["out"] for f in part["cut_faces"]]
    cands = [(d, True) for d in cut_downs] + [(d, False) for d in ([0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0])]
    scored = []
    for d, is_cut in cands:
        area, h = _contact(tm, d)
        if area < 1:
            continue
        score = area * (1.25 if is_cut else 1.0) / (1 + h / 40)
        scored.append((score, d, is_cut))
    ranked = sorted(scored, key=lambda x: -x[0])
    downs = [d for _, d, _ in ranked] or cut_downs
    T = fit_transform(tm, downs)
    fits = T is not None
    if T is None:
        T = _rot_to(downs[0], [0, 0, -1]) if downs else np.eye(4)
    tm.apply_transform(T)
    lo, hi = tm.bounds
    move = np.eye(4)
    move[:3, 3] = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]]
    tm.apply_transform(move)
    full = move @ T
    # liegt eine Schnittfläche unten?
    down_world = np.linalg.inv(T)[:3, :3] @ np.array([0, 0, -1.0])
    cut_down = any(np.dot(down_world, np.asarray(d) / np.linalg.norm(d)) > 0.99 for d in cut_downs)
    return tm, np.linalg.inv(full), fits, bool(cut_down)


def pins_mesh(pins: list) -> Optional[trimesh.Trimesh]:
    """Alle Steckstifte (+2 Ersatz) stehend nebeneinander auf einer Platte-freien Reihe."""
    if not pins:
        return None
    pins = pins + pins[:2]
    out = []
    cols = max(1, int(math.ceil(math.sqrt(len(pins)))))
    for i, p in enumerate(pins):
        c = trimesh.creation.cylinder(radius=p["d"] / 2, height=p["len"], sections=40)
        # leichte Fase oben/unten wäre schöner – Kanten werden beim Einstecken ohnehin entgratet
        c.apply_translation([(i % cols) * 12.0, (i // cols) * 12.0, p["len"] / 2])
        out.append(c)
    m = trimesh.util.concatenate(out)
    lo, hi = m.bounds
    m.apply_translation([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, 0])
    return m


def assembly_pairs(parts: list, cuts: list, pins: Optional[list] = None) -> list[dict]:
    """Welche Teile werden an welchem Schnitt direkt zusammengeklebt? (gegenüberliegende Seiten, die sich überlappen)"""
    out, pins = [], pins or []
    for c_id, c in enumerate(cuts):
        ax = "XYZ".index(c["axis"])
        others = [k for k in range(3) if k != ax]
        side = {1: [], -1: []}
        for i, p in enumerate(parts):
            for f in p["cut_faces"]:
                if f["cut"] == c_id:
                    side[1 if f["out"][ax] < 0 else -1].append(i)
        for a in side[1]:
            for b in side[-1]:
                la, ha = parts[a]["mesh"].bounds
                lb, hb = parts[b]["mesh"].bounds
                if all(min(ha[k], hb[k]) - max(la[k], lb[k]) > 1.0 for k in others):
                    # Stifte dieses Schnitts, die zwischen genau diesen beiden Teilen sitzen
                    n_pins = sum(1 for pin in pins if pin["cut"] == c_id and all(
                        max(la[k], lb[k]) - 0.5 <= pin["c"][k] <= min(ha[k], hb[k]) + 0.5 for k in others))
                    out.append({"a": min(a, b) + 1, "b": max(a, b) + 1, "cut": c_id, "pins": n_pins})
    return out
