"""SQLite persistence so saved shots and patterns survive a reload."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any

# Overridable because a hosted container's application directory is often
# read-only, while /tmp is not.
DB_PATH = Path(
    os.environ.get("ECLIPSE_DB", Path(__file__).with_name("eclipse_plan.db"))
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS shots (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL DEFAULT 'local',
    lat       REAL NOT NULL,
    lon       REAL NOT NULL,
    elev_m    REAL NOT NULL DEFAULT 0,
    t_unix    REAL NOT NULL,
    label     TEXT NOT NULL DEFAULT '',
    note      TEXT NOT NULL DEFAULT '',
    payload   TEXT NOT NULL DEFAULT '{}',
    created   REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS patterns (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL DEFAULT 'local',
    name    TEXT NOT NULL,
    rules   TEXT NOT NULL,
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sites (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL,
    lat     REAL NOT NULL,
    lon     REAL NOT NULL,
    elev_m  REAL NOT NULL DEFAULT 0,
    created REAL NOT NULL
);
"""


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


#: Saved rows belong to one browser. Without this, a publicly hosted copy would
#: show every visitor the same shot list and let them delete each other's times.
DEFAULT_CLIENT = "local"


def init() -> None:
    with _conn() as c:
        c.executescript(_SCHEMA)
        # Bring an older database up to date rather than discarding it.
        for table in ("shots", "patterns"):
            cols = {r[1] for r in c.execute(f"PRAGMA table_info({table})")}
            if "client_id" not in cols:
                c.execute(
                    f"ALTER TABLE {table} ADD COLUMN client_id TEXT NOT NULL"
                    f" DEFAULT '{DEFAULT_CLIENT}'"
                )


def _now() -> float:
    import time

    return time.time()


# --- shots ------------------------------------------------------------------


def add_shot(
    lat: float, lon: float, elev_m: float, t_unix: float,
    label: str = "", note: str = "", payload: dict | None = None,
    client_id: str = DEFAULT_CLIENT,
) -> dict:
    with _conn() as c:
        cur = c.execute(
            "INSERT INTO shots (lat, lon, elev_m, t_unix, label, note, payload,"
            " created, client_id) VALUES (?,?,?,?,?,?,?,?,?)",
            (lat, lon, elev_m, t_unix, label, note,
             json.dumps(payload or {}), _now(), client_id),
        )
        # Read back on the same connection: the insert is not committed until
        # this block exits, so a fresh connection would not see the row.
        r = c.execute("SELECT * FROM shots WHERE id=?", (cur.lastrowid,)).fetchone()
        return _row_to_shot(r)


def add_shots(
    items: list[dict], client_id: str = DEFAULT_CLIENT
) -> list[dict]:
    return [
        add_shot(
            i["lat"], i["lon"], i.get("elev_m", 0.0), i["t_unix"],
            i.get("label", ""), i.get("note", ""), i.get("payload"),
            client_id,
        )
        for i in items
    ]


def _row_to_shot(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["payload"] = json.loads(d["payload"] or "{}")
    return d


def get_shot(shot_id: int) -> dict | None:
    with _conn() as c:
        r = c.execute("SELECT * FROM shots WHERE id=?", (shot_id,)).fetchone()
        return _row_to_shot(r) if r else None


def list_shots(client_id: str = DEFAULT_CLIENT) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM shots WHERE client_id=? ORDER BY t_unix", (client_id,)
        ).fetchall()
        return [_row_to_shot(r) for r in rows]


def update_shot(
    shot_id: int, client_id: str = DEFAULT_CLIENT, **fields: Any
) -> dict | None:
    allowed = {"label", "note", "t_unix"}
    sets = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if sets:
        with _conn() as c:
            c.execute(
                f"UPDATE shots SET {','.join(f'{k}=?' for k in sets)}"
                " WHERE id=? AND client_id=?",
                (*sets.values(), shot_id, client_id),
            )
    shot = get_shot(shot_id)
    return shot if shot and shot.get("client_id") == client_id else None


def delete_shot(shot_id: int, client_id: str = DEFAULT_CLIENT) -> bool:
    with _conn() as c:
        return c.execute(
            "DELETE FROM shots WHERE id=? AND client_id=?", (shot_id, client_id)
        ).rowcount > 0


def clear_shots(client_id: str = DEFAULT_CLIENT) -> int:
    with _conn() as c:
        return c.execute(
            "DELETE FROM shots WHERE client_id=?", (client_id,)
        ).rowcount


# --- patterns ---------------------------------------------------------------


def save_pattern(
    name: str, rules: list[dict], client_id: str = DEFAULT_CLIENT
) -> dict:
    with _conn() as c:
        cur = c.execute(
            "INSERT INTO patterns (name, rules, created, client_id)"
            " VALUES (?,?,?,?)",
            (name, json.dumps(rules), _now(), client_id),
        )
        r = c.execute("SELECT * FROM patterns WHERE id=?", (cur.lastrowid,)).fetchone()
        return {**dict(r), "rules": json.loads(r["rules"])}


def list_patterns(client_id: str = DEFAULT_CLIENT) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM patterns WHERE client_id=? ORDER BY created DESC",
            (client_id,),
        ).fetchall()
        return [{**dict(r), "rules": json.loads(r["rules"])} for r in rows]


def delete_pattern(
    pattern_id: int, client_id: str = DEFAULT_CLIENT
) -> bool:
    with _conn() as c:
        return c.execute(
            "DELETE FROM patterns WHERE id=? AND client_id=?",
            (pattern_id, client_id),
        ).rowcount > 0


# --- sites ------------------------------------------------------------------


def save_site(name: str, lat: float, lon: float, elev_m: float = 0.0) -> dict:
    with _conn() as c:
        cur = c.execute(
            "INSERT INTO sites (name, lat, lon, elev_m, created) VALUES (?,?,?,?,?)",
            (name, lat, lon, elev_m, _now()),
        )
        r = c.execute("SELECT * FROM sites WHERE id=?", (cur.lastrowid,)).fetchone()
        return dict(r)


def list_sites() -> list[dict]:
    with _conn() as c:
        return [dict(r) for r in
                c.execute("SELECT * FROM sites ORDER BY created DESC").fetchall()]


def delete_site(site_id: int) -> bool:
    with _conn() as c:
        return c.execute("DELETE FROM sites WHERE id=?", (site_id,)).rowcount > 0
