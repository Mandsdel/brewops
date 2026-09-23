"""FastAPI app: JSON API + static frontend, one process, port 8123."""

import sqlite3
from contextlib import asynccontextmanager, closing
from datetime import datetime, timedelta
from pathlib import Path

import uvicorn
from fastapi import Depends, FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from brewops.db import queries
from brewops.db.connection import connect
from brewops.db.schema import init_db

HOST = "127.0.0.1"
PORT = 8123

TIMESTAMP_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M")


@asynccontextmanager
async def lifespan(app: FastAPI):
    with closing(connect()) as conn:
        init_db(conn)
    yield


app = FastAPI(title="BrewOps", lifespan=lifespan)


def get_db():
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


def parse_timestamp(value: str) -> str:
    """Accept form ('YYYY-MM-DDTHH:MM') and log ('YYYY-MM-DD HH:MM:SS') styles;
    normalize to the storage format. Rejects future timestamps."""
    for fmt in TIMESTAMP_FORMATS:
        try:
            ts = datetime.strptime(value.strip(), fmt)
            break
        except ValueError:
            continue
    else:
        raise HTTPException(400, f"unparsable timestamp {value!r}")
    if ts > datetime.now():
        raise HTTPException(400, "timestamp is in the future")
    return ts.strftime("%Y-%m-%d %H:%M:%S")


def parse_date(value: str) -> str:
    """Parse a 'YYYY-MM-DD' filter-range boundary. No future-date rejection."""
    try:
        datetime.strptime(value.strip(), "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, f"unparsable date {value!r}, expected YYYY-MM-DD")
    return value.strip()


class BrewIn(BaseModel):
    machine_id: int
    drink_type: str
    timestamp: str
    duration_s: float | None = None
    temp_c: float | None = None


class MaintenanceIn(BaseModel):
    machine_id: int
    type: str
    timestamp: str
    note: str | None = None
    error_code: str | None = None


@app.get("/api/stats")
def stats(
    start: str | None = None,
    end: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
):
    start_parsed = parse_date(start) if start is not None else None
    end_parsed = parse_date(end) if end is not None else None
    if start_parsed is not None and end_parsed is not None and start_parsed > end_parsed:
        raise HTTPException(400, "start must not be after end")
    end_exclusive = None
    if end_parsed is not None:
        end_exclusive = (datetime.strptime(end_parsed, "%Y-%m-%d") + timedelta(days=1)).strftime(
            "%Y-%m-%d"
        )
    return queries.get_stats(conn, start_parsed, end_exclusive)


@app.get("/api/machines")
def machines(conn: sqlite3.Connection = Depends(get_db)):
    return queries.get_machines(conn)


@app.get("/api/machines/{machine_id}")
def machine_health(
    machine_id: int,
    start: str | None = None,
    end: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
):
    start_parsed = parse_date(start) if start is not None else None
    end_parsed = parse_date(end) if end is not None else None
    if start_parsed is not None and end_parsed is not None and start_parsed > end_parsed:
        raise HTTPException(400, "start must not be after end")
    end_exclusive = None
    if end_parsed is not None:
        end_exclusive = (datetime.strptime(end_parsed, "%Y-%m-%d") + timedelta(days=1)).strftime(
            "%Y-%m-%d"
        )
    health = queries.get_machine_health(conn, machine_id, start_parsed, end_exclusive)
    if health is None:
        raise HTTPException(404, f"no machine with id {machine_id}")
    return health


@app.get("/api/drink-types")
def drink_types(conn: sqlite3.Connection = Depends(get_db)):
    return queries.get_drink_types(conn)


@app.post("/api/brews")
def log_brew(brew: BrewIn, conn: sqlite3.Connection = Depends(get_db)):
    if queries.get_machine(conn, brew.machine_id) is None:
        raise HTTPException(400, f"unknown machine_id {brew.machine_id}")
    if not queries.drink_type_exists(conn, brew.drink_type):
        raise HTTPException(400, f"unknown drink_type {brew.drink_type!r}")
    timestamp = parse_timestamp(brew.timestamp)
    brew_id = queries.insert_brew(
        conn, brew.machine_id, brew.drink_type, timestamp,
        brew.duration_s, brew.temp_c, source="manual",
    )
    conn.commit()
    return {"id": brew_id, "status": "logged"}


@app.post("/api/maintenance")
def log_maintenance(event: MaintenanceIn, conn: sqlite3.Connection = Depends(get_db)):
    if queries.get_machine(conn, event.machine_id) is None:
        raise HTTPException(400, f"unknown machine_id {event.machine_id}")
    if event.type not in ("descale", "refill", "repair", "error"):
        raise HTTPException(400, f"unknown maintenance type {event.type!r}")
    timestamp = parse_timestamp(event.timestamp)
    event_id = queries.insert_maintenance(
        conn, event.machine_id, event.type, timestamp, event.note, event.error_code
    )
    conn.commit()
    return {"id": event_id, "status": "logged"}


FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


def run() -> None:
    uvicorn.run(app, host=HOST, port=PORT)
