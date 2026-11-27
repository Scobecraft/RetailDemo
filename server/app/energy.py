"""Energieeffizienz-Label nachschlagen.

Quellen (nur vertrauenswürdig): EPREL (offizielle EU-Datenbank), Hersteller, Expert, MediaMarkt/Saturn.

Ohne Schlüssel: Die Weboberfläche scannt den QR-Code auf dem EU-Energielabel (der zeigt direkt auf den
offiziellen EPREL-Eintrag) bzw. baut Schnell-Links zu den vertrauenswürdigen Quellen.
Mit kostenlosem EPREL-API-Schlüssel (einmalig bei der EU registriert): Der Server holt zu einer
Registriernummer automatisch Energieklasse + Label vom offiziellen EPREL-Dienst.
"""
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

EPREL = "https://eprel.ec.europa.eu"
UA = "RetailDemo/1.0 (+energy-label lookup)"


def _get(url: str, headers: dict, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _get_json(url: str, headers: dict, timeout: int = 20):
    return json.loads(_get(url, headers, timeout).decode("utf-8", "replace"))


def trusted_links(q: str) -> list[dict]:
    """Schnell-Links nur zu vertrauenswürdigen Quellen für ein Modell / eine EAN."""
    qe = urllib.parse.quote(q.strip())
    if not qe:
        return []
    return [
        {"name": "EPREL (EU-Datenbank)", "url": f"{EPREL}/search?text={qe}"},
        {"name": "Expert", "url": f"https://www.expert.de/shop/search?q={qe}"},
        {"name": "MediaMarkt", "url": f"https://www.mediamarkt.de/de/search.html?query={qe}"},
        {"name": "Saturn", "url": f"https://www.saturn.de/de/search.html?query={qe}"},
    ]


def make_energy_router(db: Callable, require_admin: Callable):
    r = APIRouter()

    def get_key() -> str:
        with db() as c:
            row = c.execute("SELECT value FROM settings WHERE key='eprel_api_key'").fetchone()
        return (row["value"] if row else "") or ""

    def set_key(k: str):
        with db() as c:
            if c.execute("SELECT 1 FROM settings WHERE key='eprel_api_key'").fetchone():
                c.execute("UPDATE settings SET value=? WHERE key='eprel_api_key'", (k,))
            else:
                c.execute("INSERT INTO settings (key, value) VALUES ('eprel_api_key', ?)", (k,))

    def _api_headers() -> dict:
        key = get_key()
        if not key:
            raise HTTPException(400, "Kein EPREL-API-Schlüssel hinterlegt")
        return {"x-api-key": key, "Accept": "application/json"}

    def _simplify(p: dict) -> dict:
        """Ein EPREL-Produkt auf die wichtigen Felder reduzieren (Feldnamen variieren je Gruppe)."""
        def pick(*keys):
            for k in keys:
                if p.get(k):
                    return p[k]
            return None
        reg = pick("eprelRegistrationNumber", "registrationNumber", "registration_number")
        grp = pick("productGroup", "product_group", "productGroupUrlCode")
        q = urllib.parse.quote(str(reg)) if reg else ""
        return {
            "registrationNumber": reg,
            "energyClass": pick("energyClass", "energyEfficiencyClass", "energyClassVariant"),
            "energyClassRange": pick("energyClassRange"),
            "model": pick("modelIdentifier", "model", "supplierModelIdentifier"),
            "brand": pick("supplierOrTrademark", "trademarkOwner", "trademark", "supplier", "brand"),
            "group": grp,
            "page": f"{EPREL}/screen/product/{grp}/{reg}" if grp and reg else (f"{EPREL}/qr/{reg}" if reg else None),
            "labelProxy": f"/api/admin/eprel/label?reg={q}" + (f"&group={urllib.parse.quote(str(grp))}" if grp else "") if reg else None,
            "fichePdf": f"{EPREL}/fiches/{urllib.parse.quote(str(grp))}/Fiche_{q}.pdf" if grp and reg else None,
        }

    def _fetch_product(reg: str) -> dict:
        """Öffentliche Einzelabfrage per Registriernummer – KEIN Schlüssel nötig."""
        return _get_json(f"{EPREL}/api/product/{urllib.parse.quote(reg)}", {"Accept": "application/json"})

    # -------------------------------------------------- Schlüssel verwalten
    class KeyBody(BaseModel):
        key: str = ""

    @r.put("/api/admin/eprel/key", dependencies=[Depends(require_admin)])
    def put_key(body: KeyBody):
        set_key(body.key.strip())
        return {"has_key": bool(body.key.strip())}

    @r.get("/api/admin/eprel/config", dependencies=[Depends(require_admin)])
    def config():
        return {"has_key": bool(get_key()),
                "register_url": "https://eprel.ec.europa.eu/screen/api-registration"}

    # -------------------------------------------------- Produktgruppen (öffentlich, ohne Schlüssel)
    @r.get("/api/admin/eprel/groups", dependencies=[Depends(require_admin)])
    def groups():
        try:
            data = _get_json(f"{EPREL}/api/product-groups", {"Accept": "application/json"})
            return {"groups": [{"code": g.get("url_code") or g.get("code"), "name": g.get("name")}
                               for g in data if (g.get("url_code") or g.get("code"))]}
        except Exception as e:
            return {"groups": [], "error": str(e)[:200]}

    # -------------------------------------------------- Nachschlagen
    @r.get("/api/admin/eprel/lookup", dependencies=[Depends(require_admin)])
    def lookup(q: str = "", reg: str = "", group: str = ""):
        term = (q or reg).strip()
        out: dict = {"query": term, "links": trusted_links(term), "results": [], "has_key": bool(get_key())}
        # Registriernummer (vom QR-Code auf dem Label): öffentlich, OHNE Schlüssel – holt Klasse + Label.
        if reg:
            try:
                p = _fetch_product(reg)
                if isinstance(p, dict) and p.get("eprelRegistrationNumber"):
                    out["results"] = [_simplify(p)]
                else:
                    out["error"] = "Kein Produkt zu dieser Registriernummer gefunden."
            except urllib.error.HTTPError as e:
                out["error"] = f"EPREL {e.code}: {e.reason}"
            except Exception as e:
                out["error"] = str(e)[:200]
            return out
        # Freitextsuche (Modell/EAN): EPREL-Suche ist gesperrt -> nur mit Schlüssel möglich.
        if q and get_key():
            try:
                headers = _api_headers()
                url = f"{EPREL}/api/products?page=1&size=10&text={urllib.parse.quote(q)}"
                data = _get_json(url, headers)
                items = data if isinstance(data, list) else (data.get("hits") or data.get("products") or [])
                out["results"] = [_simplify(x) for x in (items or [])[:10] if isinstance(x, dict)]
            except urllib.error.HTTPError as e:
                out["error"] = f"EPREL {e.code}: {e.reason}"
            except Exception as e:
                out["error"] = str(e)[:200]
        return out

    # -------------------------------------------------- Label-Bild (öffentlich, über den Server geladen)
    @r.get("/api/admin/eprel/label", dependencies=[Depends(require_admin)])
    def label(reg: str, group: str = ""):
        # Produktgruppe ggf. öffentlich nachschlagen (für den Label-Pfad nötig)
        if not group:
            try:
                group = str(_fetch_product(reg).get("productGroup") or "")
            except Exception:
                group = ""
        if not group:
            raise HTTPException(404, "Produkt/Gruppe nicht gefunden")
        q = urllib.parse.quote(reg)
        g = urllib.parse.quote(group)
        # Direktes, öffentliches Label-Bild – kein Schlüssel nötig.
        for url, mt in ((f"{EPREL}/labels/{g}/Label_{q}.png", "image/png"),
                        (f"{EPREL}/labels/{g}/Label_{q}.pdf", "application/pdf")):
            try:
                raw = _get(url, {"Accept": "*/*"}, timeout=25)
                if raw[:4] in (b"\x89PNG", b"%PDF"):
                    return Response(content=raw, media_type=mt)
            except Exception:
                continue
        raise HTTPException(404, "Kein Label gefunden")

    return r
