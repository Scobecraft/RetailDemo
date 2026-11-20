"""Druckplatte: mehrere Modelle (je mit Anzahl Kopien) gemeinsam auf ein Druckbett packen.

Jedes Modell bekommt seine eigenen Einstellungen aus dem 3D-Slicer (Größe, Drehung), wird hingestellt und
mit Abstand platzsparend angeordnet (Reihen, längere Seite in X; bei Bedarf um 90° gedreht). PrusaSlicer
übernimmt die fertigen Positionen (--merge --dont-arrange).
"""
import math
from pathlib import Path

import numpy as np

USABLE = 208.0   # nutzbare Fläche (220 mm Bett, Platz für Skirt/Rand)
MAX_H = 220.0


class PlateError(Exception):
    pass


def load_model(path: Path, opts: dict):
    import trimesh
    m = trimesh.load(str(path), force="mesh")
    if not len(getattr(m, "faces", [])):
        raise PlateError(f"{path.name}: keine Flächen")
    s = float(opts.get("scale") or 100) / 100
    if abs(s - 1) > 1e-6:
        m.apply_scale(s)
    for key, axis in (("rotate_x", [1, 0, 0]), ("rotate_y", [0, 1, 0]), ("rotate", [0, 0, 1])):
        a = float(opts.get(key) or 0)
        if a:
            m.apply_transform(trimesh.transformations.rotation_matrix(math.radians(a), axis))
    return m


def pack(meshes: list, spacing: float = 6.0) -> list:
    """Anordnen in Reihen. meshes: Liste (name, mesh). Ergebnis: (name, platziertes mesh). Wirft PlateError."""
    import trimesh
    items = []
    for name, m in meshes:
        m = m.copy()
        lo, hi = m.bounds
        w, d = hi[0] - lo[0], hi[1] - lo[1]
        if hi[2] - lo[2] > MAX_H:
            raise PlateError(f"„{name}“ ist zu hoch fürs Druckbett ({hi[2] - lo[2]:.0f} mm)")
        if d > w:  # längere Seite in X legen
            m.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [0, 0, 1]))
            lo, hi = m.bounds
            w, d = hi[0] - lo[0], hi[1] - lo[1]
        if w > USABLE or d > USABLE:
            raise PlateError(f"„{name}“ ist allein schon zu groß fürs Druckbett ({w:.0f} × {d:.0f} mm)")
        items.append([name, m, w, d])
    items.sort(key=lambda it: (-it[3], -it[2]))  # hohe (tiefe) zuerst
    rows, x, y, row_d, placed = [], 0.0, 0.0, 0.0, []
    for it in items:
        name, m, w, d = it
        if x > 0 and x + w > USABLE:  # neue Reihe
            y += row_d + spacing
            x, row_d = 0.0, 0.0
        if y + d > USABLE:
            raise PlateError(f"Nicht alles passt auf ein Druckbett – {len(placed)} von {len(items)} Teilen passen. Bitte weniger Kopien oder eine zweite Druckplatte.")
        lo = m.bounds[0]
        m.apply_translation([x - lo[0], y - lo[1], -lo[2]])
        placed.append((name, m))
        x += w + spacing
        row_d = max(row_d, d)
    # alles zusammen mittig aufs Bett
    allb = np.array([p[1].bounds for p in placed])
    lo, hi = allb[:, 0].min(axis=0), allb[:, 1].max(axis=0)
    shift = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, 0]
    for _, m in placed:
        m.apply_translation(shift)
    return placed
