"""Feierabend für den Druckmonitor-PC: Zeitplan zum Herunterfahren (auf der Webseite einstellbar).

Der Druckmonitor bekommt den Plan mit jeder Antwort auf seine Zustandsmeldung, speichert ihn lokal
(klappt also auch ohne Server) und fährt den PC zur eingestellten Uhrzeit herunter – läuft gerade ein
Druck, wartet er, bis der Druck fertig ist.
"""
import json
import re
import time
from datetime import date
from pathlib import Path
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

DAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]
DEFAULT_PLAN = {
    "enabled": True,
    "days": [{"on": True, "time": "19:00"}] * 5 + [{"on": True, "time": "16:00"}, {"on": False, "time": "16:00"}],
    "not_while_printing": True,
    "warn_min": 5,
    "skip_date": "",   # an diesem Tag nicht herunterfahren (von der Webseite)
    "force_date": "",  # an diesem Tag eine im Druckmonitor gedrückte Auslassung wieder aufheben
}


class Day(BaseModel):
    on: bool = False
    time: str = "19:00"


class PlanIn(BaseModel):
    enabled: bool = True
    days: list[Day]
    not_while_printing: bool = True
    warn_min: int = 5


class SkipIn(BaseModel):
    skip: bool = True


def make_shutdown_router(druck_dir: Path, require_admin: Callable, last_status: Callable[[], dict]):
    f = druck_dir / "shutdown.json"
    r = APIRouter()

    def plan() -> dict:
        p = json.loads(json.dumps(DEFAULT_PLAN))
        try:
            p.update(json.loads(f.read_text()))
        except (OSError, ValueError):
            pass
        return p

    def save(p: dict):
        p["rev"] = int(time.time() * 1000)
        f.write_text(json.dumps(p))

    @r.get("/api/admin/druck/shutdown", dependencies=[Depends(require_admin)])
    def get_plan():
        st = last_status()
        return {"plan": plan(), "days": DAYS, "status": st.get("shutdown"), "online": st.get("online"), "app_version": st.get("app_version")}

    @r.put("/api/admin/druck/shutdown", dependencies=[Depends(require_admin)])
    def put_plan(body: PlanIn):
        if len(body.days) != 7:
            raise HTTPException(400, "Bitte alle 7 Wochentage angeben")
        for d in body.days:
            if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", d.time):
                raise HTTPException(400, f"Uhrzeit bitte als HH:MM (nicht „{d.time}“)")
        p = plan()
        p.update(enabled=body.enabled, days=[d.model_dump() for d in body.days], not_while_printing=body.not_while_printing,
                 warn_min=max(0, min(30, body.warn_min)))
        save(p)
        return p

    @r.post("/api/admin/druck/shutdown/skip", dependencies=[Depends(require_admin)])
    def skip_today(body: SkipIn):
        p = plan()
        today = date.today().isoformat()
        if body.skip:
            p.update(skip_date=today)
        else:
            p.update(skip_date="", force_date=today)
        save(p)
        return p

    return r, plan
