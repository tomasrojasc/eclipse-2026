"""Umbral path of the 2026-08-12 eclipse, for drawing on the map.

The centreline comes from intersecting the Sun->Moon shadow axis with the WGS84
ellipsoid. The northern and southern limits are found by stepping perpendicular
to the track and bisecting on "does totality occur here at all", which is slower
but avoids approximating the umbra as a circle on a sphere.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from skyfield.framelib import itrs

from .eclipse import (
    ECLIPSE_DATE,
    R_EARTH_EQ_KM,
    R_EARTH_POL_KM,
    _ephem,
    _observer,
    _state,
)

CACHE = Path(__file__).with_name("path_2026.json")

# The umbra is over the Atlantic and Europe during this window (UTC hours).
AXIS_START_H = 15.0
AXIS_END_H = 21.0


def _ecef_to_geodetic(x: float, y: float, z: float) -> tuple[float, float]:
    """WGS84 ECEF (km) -> (lat_deg, lon_deg), via Ferrari's closed form."""
    a, b = R_EARTH_EQ_KM, R_EARTH_POL_KM
    e2 = 1 - (b * b) / (a * a)
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - e2))
    for _ in range(6):
        n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
        h = p / math.cos(lat) - n
        lat = math.atan2(z, p * (1 - e2 * n / (n + h)))
    return math.degrees(lat), math.degrees(lon)


def _axis_hit(m: np.ndarray, s: np.ndarray) -> tuple[float, float] | None:
    """Where the shadow axis pierces the ellipsoid. Vectors are ITRS km."""
    d = m - s
    d = d / np.linalg.norm(d)
    # Scale z so the ellipsoid becomes a sphere of radius a.
    k = R_EARTH_EQ_KM / R_EARTH_POL_KM
    o = np.array([m[0], m[1], m[2] * k])
    dd = np.array([d[0], d[1], d[2] * k])
    dd_n = dd / np.linalg.norm(dd)

    b = 2 * o.dot(dd_n)
    c = o.dot(o) - R_EARTH_EQ_KM**2
    disc = b * b - 4 * c
    if disc < 0:
        return None  # axis misses the Earth
    t = (-b - math.sqrt(disc)) / 2  # near side
    hit = o + t * dd_n
    return _ecef_to_geodetic(hit[0], hit[1], hit[2] / k)


def centerline(step_s: float = 30.0) -> list[dict]:
    """Sub-shadow points along the whole visible track."""
    ts, eph, earth, sun, moon = _ephem()
    y, mo, d = ECLIPSE_DATE
    n = int((AXIS_END_H - AXIS_START_H) * 3600 / step_s) + 1
    hours = np.linspace(AXIS_START_H, AXIS_END_H, n)
    t = ts.utc(y, mo, d, hours)

    m_xyz = (moon - earth).at(t).frame_xyz(itrs).km
    s_xyz = (sun - earth).at(t).frame_xyz(itrs).km

    pts = []
    for i in range(n):
        hit = _axis_hit(m_xyz[:, i], s_xyz[:, i])
        if hit is None:
            continue
        lat, lon = hit
        pts.append(
            {"lat": round(lat, 4), "lon": round(lon, 4),
             "t_unix": t[i].utc_datetime().timestamp()}
        )
    return pts


# --- totality test (cheap: no contact refinement) ---------------------------


def is_total(lat: float, lon: float, t_center_unix: float, half_window_s: float = 1200.0) -> bool:
    """Does the Moon fully cover the Sun near t_center at this location?"""
    ts, *_ = _ephem()
    obs = _observer(lat, lon, 0.0)
    from datetime import datetime, timezone

    stamps = np.arange(
        t_center_unix - half_window_s, t_center_unix + half_window_s, 4.0
    )
    t = ts.from_datetimes(
        [datetime.fromtimestamp(float(s), tz=timezone.utc) for s in stamps]
    )
    _, _, sep, rs, rm = _state(obs, t)
    return bool(np.any(sep <= np.abs(rs - rm)))


def _limits(center: list[dict], every: int = 1, max_offset_deg: float = 7.0) -> dict:
    """Bisect perpendicular to the track for the north / south umbral limits."""
    north, south = [], []
    pts = center[::every]

    for i, p in enumerate(pts):
        # Local track heading, from neighbouring centreline points.
        nxt = pts[min(i + 1, len(pts) - 1)]
        prv = pts[max(i - 1, 0)]
        coslat = max(0.2, math.cos(math.radians(p["lat"])))
        hx = (nxt["lon"] - prv["lon"]) * coslat
        hy = nxt["lat"] - prv["lat"]
        norm = math.hypot(hx, hy)
        if norm == 0:
            continue
        # Perpendicular to the track (left of travel).
        px, py = -hy / norm, hx / norm

        if not is_total(p["lat"], p["lon"], p["t_unix"]):
            continue  # centre itself is not total; nothing to bound here

        def at(sign: float, off: float) -> tuple[float, float]:
            return (p["lat"] + sign * py * off,
                    p["lon"] + sign * px * off / coslat)

        # Resolve BOTH edges before storing either. A point that yields only one
        # edge would leave the two polylines different lengths, and the polygon
        # built from them would fold into a bowtie across half the map.
        pair: dict[str, dict] = {}
        for key, sign in (("north", 1.0), ("south", -1.0)):
            lo, hi = 0.0, max_offset_deg
            if is_total(*at(sign, hi), p["t_unix"]):
                break  # umbra wider than the search span; skip this point
            for _ in range(11):
                mid = (lo + hi) / 2
                if is_total(*at(sign, mid), p["t_unix"]):
                    lo = mid
                else:
                    hi = mid
            la, ln = at(sign, (lo + hi) / 2)
            pair[key] = {"lat": round(la, 4), "lon": round(ln, 4)}

        if len(pair) == 2:
            north.append(pair["north"])
            south.append(pair["south"])

    return {"north": north, "south": south}


def _resample(pts: list[dict], spacing_deg: float) -> list[dict]:
    """Thin a centreline to roughly uniform spatial spacing.

    The umbra crosses the ground far faster near sunset than at midday, so
    sampling uniformly in time would leave the Balearic end of the track with
    gaps wide enough for the drawn band to cut a corner across Mallorca.
    """
    if not pts:
        return pts
    out = [pts[0]]
    for p in pts[1:]:
        q = out[-1]
        dlat = p["lat"] - q["lat"]
        dlon = (p["lon"] - q["lon"]) * math.cos(math.radians(q["lat"]))
        if math.hypot(dlat, dlon) >= spacing_deg:
            out.append(p)
    if out[-1] is not pts[-1]:
        out.append(pts[-1])
    return out


def build(force: bool = False) -> dict:
    """Compute (or load) the path. Cached to JSON since limits take ~40 s."""
    if CACHE.exists() and not force:
        return json.loads(CACHE.read_text())

    center = centerline(step_s=5.0)
    # Restrict the drawn track to the Iberian / Balearic neighbourhood.
    iberia = [
        p for p in center if -14.0 <= p["lon"] <= 6.0 and 34.0 <= p["lat"] <= 46.0
    ]
    lim = _limits(_resample(iberia, 0.25))
    data = {
        "centerline": center,
        "centerline_iberia": iberia,
        "limits": lim,
    }
    CACHE.write_text(json.dumps(data))
    return data


if __name__ == "__main__":
    d = build(force=True)
    print(
        f"centerline {len(d['centerline'])} pts, iberia {len(d['centerline_iberia'])}, "
        f"north {len(d['limits']['north'])}, south {len(d['limits']['south'])}"
    )
    if d["centerline_iberia"]:
        a, b = d["centerline_iberia"][0], d["centerline_iberia"][-1]
        print(f"  enters {a['lat']:.2f},{a['lon']:.2f}  exits {b['lat']:.2f},{b['lon']:.2f}")
