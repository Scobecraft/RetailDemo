"""Liest Paketname und Version aus einer APK (binäres AndroidManifest.xml), ohne Zusatzbibliotheken."""
import struct
import zipfile

_ATTR_IDS = {0x0101021B: "version_code", 0x0101021C: "version_name"}


def _string_pool(data: bytes, off: int) -> list[str]:
    _, header_size, _ = struct.unpack_from("<HHI", data, off)
    count, _, flags, strings_start, _ = struct.unpack_from("<IIIII", data, off + 8)
    utf8 = bool(flags & 0x100)
    offsets = struct.unpack_from(f"<{count}I", data, off + header_size)
    base = off + strings_start
    out = []
    for o in offsets:
        p = base + o
        if utf8:
            n = data[p]; p += 2 if n & 0x80 else 1           # Länge in Zeichen
            n = data[p]
            if n & 0x80:
                n = ((n & 0x7F) << 8) | data[p + 1]; p += 2
            else:
                p += 1
            out.append(data[p:p + n].decode("utf-8", "replace"))
        else:
            n = struct.unpack_from("<H", data, p)[0]; p += 2
            if n & 0x8000:
                n = ((n & 0x7FFF) << 16) | struct.unpack_from("<H", data, p)[0]; p += 2
            out.append(data[p:p + n * 2].decode("utf-16-le", "replace"))
    return out


def read_apk_info(path) -> dict:
    with zipfile.ZipFile(path) as z:
        data = z.read("AndroidManifest.xml")
    strings: list[str] = []
    res_ids: list[int] = []
    pos = 8
    while pos < len(data):
        ctype, header_size, size = struct.unpack_from("<HHI", data, pos)
        if size == 0:
            break
        if ctype == 0x0001:                                    # String-Pool
            strings = _string_pool(data, pos)
        elif ctype == 0x0180:                                  # Ressourcen-IDs der Attribute
            res_ids = list(struct.unpack_from(f"<{(size - 8) // 4}I", data, pos + 8))
        elif ctype == 0x0102:                                  # Start-Element
            name_idx = struct.unpack_from("<i", data, pos + 20)[0]
            if strings[name_idx] == "manifest":
                attr_start, attr_size, attr_count = struct.unpack_from("<HHH", data, pos + 24)
                info = {}
                a = pos + 16 + attr_start
                for i in range(attr_count):
                    _, aname, raw, _, _, dtype, dval = struct.unpack_from("<iiiHBBI", data, a + i * attr_size)
                    key = _ATTR_IDS.get(res_ids[aname]) if aname < len(res_ids) else None
                    if key is None and 0 <= aname < len(strings) and strings[aname] == "package":
                        key = "package"
                    if key is None:
                        continue
                    if dtype == 0x10:                          # Ganzzahl
                        info[key] = dval
                    else:
                        info[key] = strings[raw] if raw >= 0 else strings[dval]
                return info
        pos += size
    raise ValueError("Kein <manifest> in der APK gefunden")
