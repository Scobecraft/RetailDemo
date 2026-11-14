"""Alle Slicer-Einstellungen, die auf der Webseite einstellbar sind (Namen = PrusaSlicer-Konfigurationsschlüssel).

Die Webseite baut ihr Formular aus dieser Liste; der Server prüft damit jeden Wert und erzeugt die
Kommandozeile. Standardwerte kommen aus adventurer5m.ini bzw. aus der Materialvorlage (materials.json).
"""
from pathlib import Path

# (Schlüssel, Bereich, Bezeichnung, Typ, Einheit, Optionen)  Typ: int, float, percent, bool, select
# Optionen: min/max/step bzw. choices [(Wert, Text)] und hint
_F = []


def f(key, section, label, typ, unit="", **opt):
    _F.append({"key": key, "section": section, "label": label, "type": typ, "unit": unit, **opt})


S_QUAL, S_WALL, S_FILL, S_SUP, S_ADH, S_SPEED, S_TEMP, S_RETR, S_MAT, S_MODEL = (
    "Qualität", "Wände & Oberflächen", "Füllung", "Stützen", "Haftung", "Geschwindigkeit",
    "Temperatur & Kühlung", "Rückzug", "Material", "Modell")

# Qualität
f("layer_height", S_QUAL, "Schichthöhe", "float", "mm", min=0.05, max=0.32, step=0.01)
f("first_layer_height", S_QUAL, "Erste Schicht", "float", "mm", min=0.1, max=0.35, step=0.01)
f("extrusion_width", S_QUAL, "Linienbreite", "float", "mm", min=0, max=1.0, step=0.01, hint="0 = automatisch")
f("gap_fill_enabled", S_QUAL, "Lücken füllen", "bool")
f("thin_walls", S_QUAL, "Dünne Wände erkennen", "bool")
# Wände & Oberflächen
f("perimeters", S_WALL, "Wandlinien", "int", "", min=1, max=10)
f("top_solid_layers", S_WALL, "Deckschichten oben", "int", "", min=0, max=20)
f("bottom_solid_layers", S_WALL, "Bodenschichten", "int", "", min=0, max=20)
f("seam_position", S_WALL, "Naht", "select", choices=[("aligned", "Ausgerichtet"), ("nearest", "Am nächsten"), ("rear", "Hinten"), ("random", "Zufällig")])
f("external_perimeters_first", S_WALL, "Außenwand zuerst", "bool")
f("extra_perimeters", S_WALL, "Zusätzliche Wände bei Bedarf", "bool")
f("ironing", S_WALL, "Bügeln (glatte Oberseite)", "bool")
f("ironing_type", S_WALL, "Bügeln auf", "select", choices=[("top", "Allen Oberseiten"), ("topmost", "Nur oberster Fläche"), ("solid", "Allen massiven Flächen")])
f("ironing_flowrate", S_WALL, "Bügeln: Fluss", "percent", "%", min=1, max=50, step=1)
f("ironing_spacing", S_WALL, "Bügeln: Abstand", "float", "mm", min=0.05, max=1, step=0.01)
# Füllung
f("fill_density", S_FILL, "Fülldichte", "percent", "%", min=0, max=100, step=1)
f("fill_pattern", S_FILL, "Füllmuster", "select", choices=[
    ("grid", "Gitter"), ("rectilinear", "Geradlinig"), ("triangles", "Dreiecke"), ("stars", "Sterne"), ("cubic", "Kubisch"),
    ("line", "Linien"), ("concentric", "Konzentrisch"), ("honeycomb", "Waben"), ("3dhoneycomb", "3D-Waben"), ("gyroid", "Gyroid"),
    ("hilbertcurve", "Hilbert-Kurve"), ("adaptivecubic", "Adaptiv kubisch"), ("supportcubic", "Stützend kubisch"), ("lightning", "Blitz")])
f("top_fill_pattern", S_FILL, "Muster Oberseite", "select", choices=[
    ("monotonic", "Monoton"), ("monotoniclines", "Monotone Linien"), ("rectilinear", "Geradlinig"), ("alignedrectilinear", "Ausgerichtet geradlinig"),
    ("concentric", "Konzentrisch"), ("hilbertcurve", "Hilbert-Kurve")])
f("bottom_fill_pattern", S_FILL, "Muster Unterseite", "select", choices=[
    ("monotonic", "Monoton"), ("monotoniclines", "Monotone Linien"), ("rectilinear", "Geradlinig"), ("alignedrectilinear", "Ausgerichtet geradlinig"),
    ("concentric", "Konzentrisch"), ("hilbertcurve", "Hilbert-Kurve")])
f("fill_angle", S_FILL, "Füllwinkel", "int", "°", min=0, max=359)
f("infill_every_layers", S_FILL, "Füllung alle … Schichten", "int", "", min=1, max=10)
f("infill_overlap", S_FILL, "Überlappung Füllung/Wand", "percent", "%", min=0, max=100, step=1)
# Stützen
f("support_material", S_SUP, "Stützstrukturen erzeugen", "bool")
f("support_material_auto", S_SUP, "Automatisch platzieren", "bool")
f("support_material_threshold", S_SUP, "Überhangwinkel", "int", "°", min=0, max=90, hint="0 = automatisch")
f("support_material_style", S_SUP, "Art", "select", choices=[("snug", "Eng anliegend"), ("grid", "Gitter"), ("organic", "Organisch (Baum)")])
f("support_material_buildplate_only", S_SUP, "Nur auf dem Druckbett", "bool")
f("support_material_pattern", S_SUP, "Muster", "select", choices=[("rectilinear", "Geradlinig"), ("rectilinear-grid", "Gitter"), ("honeycomb", "Waben")])
f("support_material_spacing", S_SUP, "Linienabstand", "float", "mm", min=0.5, max=10, step=0.1)
f("support_material_contact_distance", S_SUP, "Abstand oben (Z)", "float", "mm", min=0, max=1, step=0.01, hint="0 = lösliche Stützen")
f("support_material_bottom_contact_distance", S_SUP, "Abstand unten (Z)", "float", "mm", min=0, max=1, step=0.01, hint="0 = wie oben")
f("support_material_interface_layers", S_SUP, "Kontaktschichten", "int", "", min=0, max=10)
f("support_material_interface_spacing", S_SUP, "Abstand Kontaktlinien", "float", "mm", min=0, max=5, step=0.1)
f("support_material_enforce_layers", S_SUP, "Stützen erzwingen für erste … Schichten", "int", "", min=0, max=50)
f("raft_layers", S_SUP, "Raft-Schichten", "int", "", min=0, max=10)
# Haftung
f("brim_type", S_ADH, "Rand (Brim)", "select", choices=[("no_brim", "Kein Rand"), ("outer_only", "Außen"), ("inner_only", "Innen"), ("outer_and_inner", "Außen und innen")])
f("brim_width", S_ADH, "Randbreite", "float", "mm", min=0, max=30, step=0.5)
f("brim_separation", S_ADH, "Abstand Rand zum Modell", "float", "mm", min=0, max=2, step=0.05)
f("skirts", S_ADH, "Skirt-Linien", "int", "", min=0, max=10)
f("skirt_distance", S_ADH, "Skirt-Abstand", "float", "mm", min=0, max=20, step=0.5)
f("elefant_foot_compensation", S_ADH, "Elefantenfuß-Ausgleich", "float", "mm", min=0, max=1, step=0.05)
# Geschwindigkeit
for key, label in [("first_layer_speed", "Erste Schicht"), ("perimeter_speed", "Wände"), ("external_perimeter_speed", "Außenwand"),
                   ("infill_speed", "Füllung"), ("solid_infill_speed", "Massive Füllung"), ("top_solid_infill_speed", "Oberseite"),
                   ("support_material_speed", "Stützen"), ("bridge_speed", "Brücken"), ("gap_fill_speed", "Lücken"),
                   ("ironing_speed", "Bügeln"), ("travel_speed", "Leerfahrt")]:
    f(key, S_SPEED, label, "float", "mm/s", min=5, max=600, step=5)
for key, label in [("default_acceleration", "Beschleunigung allgemein"), ("perimeter_acceleration", "Beschleunigung Wände"),
                   ("infill_acceleration", "Beschleunigung Füllung"), ("first_layer_acceleration", "Beschleunigung erste Schicht"),
                   ("travel_acceleration", "Beschleunigung Leerfahrt")]:
    f(key, S_SPEED, label, "int", "mm/s²", min=0, max=20000, step=100, hint="0 = Firmware")
f("slowdown_below_layer_time", S_SPEED, "Langsamer, wenn Schicht kürzer als", "int", "s", min=0, max=60)
f("min_print_speed", S_SPEED, "Mindestgeschwindigkeit", "float", "mm/s", min=1, max=100, step=1)
# Temperatur & Kühlung
f("first_layer_temperature", S_TEMP, "Düse erste Schicht", "int", "°C", min=150, max=300)
f("temperature", S_TEMP, "Düse", "int", "°C", min=150, max=300)
f("first_layer_bed_temperature", S_TEMP, "Druckbett erste Schicht", "int", "°C", min=0, max=110)
f("bed_temperature", S_TEMP, "Druckbett", "int", "°C", min=0, max=110)
f("fan_always_on", S_TEMP, "Lüfter immer an", "bool")
f("min_fan_speed", S_TEMP, "Lüfter mindestens", "int", "%", min=0, max=100)
f("max_fan_speed", S_TEMP, "Lüfter höchstens", "int", "%", min=0, max=100)
f("bridge_fan_speed", S_TEMP, "Lüfter bei Brücken", "int", "%", min=0, max=100)
f("disable_fan_first_layers", S_TEMP, "Lüfter aus für erste … Schichten", "int", "", min=0, max=10)
# Rückzug
f("retract_length", S_RETR, "Länge", "float", "mm", min=0, max=10, step=0.1)
f("retract_speed", S_RETR, "Geschwindigkeit", "float", "mm/s", min=5, max=100, step=1)
f("deretract_speed", S_RETR, "Wiedereinfahren", "float", "mm/s", min=0, max=100, step=1, hint="0 = wie Rückzug")
f("retract_lift", S_RETR, "Z-Hub (Z-Hop)", "float", "mm", min=0, max=2, step=0.05)
f("retract_before_travel", S_RETR, "Rückzug ab Leerfahrt", "float", "mm", min=0, max=20, step=0.5)
f("retract_layer_change", S_RETR, "Rückzug beim Schichtwechsel", "bool")
f("wipe", S_RETR, "Abwischen beim Rückzug", "bool")
f("avoid_crossing_perimeters", S_RETR, "Wände nicht überqueren", "bool")
# Material
f("filament_type", S_MAT, "Materialart", "select", choices=[("PLA", "PLA"), ("PETG", "PETG"), ("ABS", "ABS"), ("ASA", "ASA"), ("TPU", "TPU"), ("PA", "PA (Nylon)"), ("PC", "PC")])
f("extrusion_multiplier", S_MAT, "Fluss", "float", "×", min=0.8, max=1.2, step=0.01)
f("filament_density", S_MAT, "Dichte", "float", "g/cm³", min=0.8, max=2.5, step=0.01)
f("filament_max_volumetric_speed", S_MAT, "Max. Volumenstrom", "float", "mm³/s", min=1, max=40, step=0.5)
f("filament_diameter", S_MAT, "Filamentdurchmesser", "float", "mm", min=1.6, max=1.9, step=0.01)
# Modell (keine PrusaSlicer-Konfiguration, sondern Transformationen)
f("scale", S_MODEL, "Skalierung", "int", "%", min=5, max=1000, step=5, transform=True)
f("rotate", S_MODEL, "Drehen um Z", "int", "°", min=-180, max=180, step=5, transform=True)
f("rotate_x", S_MODEL, "Drehen um X", "int", "°", min=-180, max=180, step=5, transform=True)
f("rotate_y", S_MODEL, "Drehen um Y", "int", "°", min=-180, max=180, step=5, transform=True)
f("duplicate", S_MODEL, "Anzahl Kopien", "int", "", min=1, max=25, transform=True)
f("duplicate_distance", S_MODEL, "Abstand zwischen Kopien", "float", "mm", min=6, max=50, step=1)
f("spiral_vase", S_MODEL, "Vasenmodus (Spirale)", "bool", hint="eine Wand, ohne Deckel und Füllung")

FIELDS = _F
BY_KEY = {x["key"]: x for x in FIELDS}
SECTIONS = [S_QUAL, S_WALL, S_FILL, S_SUP, S_ADH, S_SPEED, S_TEMP, S_RETR, S_MAT, S_MODEL]
TRANSFORM_DEFAULTS = {"scale": 100, "rotate": 0, "rotate_x": 0, "rotate_y": 0, "duplicate": 1}


def read_ini(path: Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def coerce(field: dict, value):
    """Wert prüfen und in den richtigen Typ bringen (ValueError bei Unsinn)."""
    t = field["type"]
    if t == "bool":
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "ja", "on")
        return bool(value)
    if t == "select":
        v = str(value)
        if v not in [c[0] for c in field["choices"]]:
            raise ValueError(f"{field['label']}: ungültige Auswahl")
        return v
    v = float(str(value).rstrip("%").replace(",", "."))
    if v != v:  # NaN
        raise ValueError(field["label"])
    v = max(field.get("min", v), min(field.get("max", v), v))
    return int(round(v)) if t in ("int",) else round(v, 4)


def defaults(profile: dict, material: dict) -> dict:
    """Standardwerte aller Felder: vollständiges Profil (inkl. PrusaSlicer-Standards), darüber die Materialvorlage.
    Felder, die die installierte PrusaSlicer-Version nicht kennt, fehlen im Ergebnis."""
    mat_map = {"temperature": "temperature", "first_layer_temperature": "first_layer_temperature",
               "bed_temperature": "bed_temperature", "first_layer_bed_temperature": "first_layer_bed_temperature",
               "filament_density": "filament_density", "filament_max_volumetric_speed": "max_volumetric_speed",
               "min_fan_speed": "fan", "max_fan_speed": "fan", "filament_type": "name"}
    out = {}
    for fld in FIELDS:
        k = fld["key"]
        if fld.get("transform"):
            out[k] = TRANSFORM_DEFAULTS[k]
            continue
        if k not in profile:
            continue
        raw = material.get(mat_map[k]) if k in mat_map and mat_map[k] in material else profile.get(k)
        try:
            out[k] = coerce(fld, raw)
        except ValueError:
            out[k] = fld.get("choices", [[raw]])[0][0] if fld["type"] == "select" else 0
    return out


def cli_args(values: dict, known: set) -> list[str]:
    """Kommandozeile für PrusaSlicer aus geprüften Werten. [known]: Schlüssel, die die installierte
    PrusaSlicer-Version kennt (andere werden ausgelassen statt das Slicen scheitern zu lassen)."""
    args = []
    for fld in FIELDS:
        k = fld["key"]
        if k not in values or fld.get("transform") or k not in known:
            continue
        v = values[k]
        opt = "--" + k.replace("_", "-")
        if fld["type"] == "bool":
            args.append(opt if v else "--no-" + k.replace("_", "-"))
        elif fld["type"] == "percent":
            args += [opt, f"{v:g}%"]
        else:
            args += [opt, f"{v:g}" if isinstance(v, (int, float)) else str(v)]
    # Modell-Transformationen
    if values.get("scale", 100) != 100:
        args += ["--scale", f"{values['scale']}%"]
    for k in ("rotate", "rotate_x", "rotate_y"):
        if values.get(k):
            args += ["--" + k.replace("_", "-"), str(values[k])]
    if values.get("duplicate", 1) > 1:
        args += ["--duplicate", str(values["duplicate"])]
    return args
