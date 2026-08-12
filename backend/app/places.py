"""Offline town search over the bundled GeoNames index."""

from __future__ import annotations

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

INDEX = Path(__file__).resolve().parent.parent / "data" / "places_es.json"

BUILD_HINT = (
    "Place index missing. Build it once with: "
    "uv run python -m backend.scripts.build_places"
)


def fold(s: str) -> str:
    """Same normalisation the index was built with: lowercase, accent-free."""
    nfkd = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in nfkd if not unicodedata.combining(c))


@lru_cache(maxsize=1)
def _places() -> list[dict]:
    if not INDEX.exists():
        raise FileNotFoundError(BUILD_HINT)
    return json.loads(INDEX.read_text())["places"]


def available() -> bool:
    return INDEX.exists()


# A pasted coordinate pair: "43.36, -5.85", "43.36 -5.85", "43.36N 5.85W".
_COORD = re.compile(
    r"^\s*(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([NSns])?\s*[,;\s]\s*"
    r"(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([EWew])?\s*$"
)


def parse_coords(q: str) -> tuple[float, float] | None:
    """Accept coordinates pasted straight from a maps app."""
    m = _COORD.match(q)
    if not m:
        return None
    lat = float(m.group(1).replace(",", "."))
    lon = float(m.group(3).replace(",", "."))
    if m.group(2) and m.group(2).upper() == "S":
        lat = -abs(lat)
    if m.group(4) and m.group(4).upper() == "W":
        lon = -abs(lon)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon


def search(q: str, limit: int = 8) -> list[dict]:
    """Rank matches: exact name, then prefix, then substring.

    Within a tier, bigger and more administratively important places win, so
    typing "bar" offers Barcelona before Barbate.
    """
    needle = fold(q.strip())
    if len(needle) < 2:
        return []

    scored: list[tuple[tuple, dict]] = []
    for p in _places():
        best = None
        for k in p["k"]:
            if k == needle:
                tier = 0
            elif k.startswith(needle):
                tier = 1
            elif needle in k:
                tier = 2
            else:
                continue
            # Shorter matches are tighter matches at the same tier.
            cand = (tier, len(k))
            if best is None or cand < best:
                best = cand
        if best is None:
            continue
        tier, klen = best
        scored.append(((tier, -p["f"], -p["p"], klen, p["n"]), p))
        # No early exit: a full scan costs a couple of milliseconds, and
        # stopping short would drop an exact match for a small village whose
        # name is a substring of many larger ones.

    scored.sort(key=lambda x: x[0])
    out = []
    for _, p in scored[:limit]:
        out.append(
            {
                "name": p["n"],
                "region": p["r"],
                "lat": p["la"],
                "lon": p["lo"],
                "elevation_m": p["e"],
                "population": p["p"],
            }
        )
    return out
