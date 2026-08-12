"""Local circumstances for the total solar eclipse of 12 August 2026.

Contact times are found the standard way (cf. NASA's "Total Solar Eclipse Local
Circumstances"): iterate topocentric apparent positions of the Sun and Moon,
compare their angular separation against the sum / difference of their apparent
semidiameters, and refine each crossing by bisection.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from functools import lru_cache
from pathlib import Path

import numpy as np
from skyfield.api import Loader, wgs84
from skyfield.framelib import itrs

# --- constants ---------------------------------------------------------------

# Event date (UTC). The eclipse is entirely within this day for Spain.
ECLIPSE_DATE = (2026, 8, 12)

# Search window in UTC hours. Spain sees the eclipse ~17:30-19:30 UT.
SEARCH_START_H = 15.0
SEARCH_END_H = 21.5

R_SUN_KM = 695700.0  # IAU 2015 nominal solar radius
R_MOON_KM = 1737.4  # IAU mean lunar radius (k = 0.2725076 equivalent)
R_EARTH_EQ_KM = 6378.1366
R_EARTH_POL_KM = 6356.7519

# Anchored to this file, not the working directory: otherwise the 17 MB
# ephemeris gets re-downloaded whenever the app is started from elsewhere.
_EPHEM_DIR = Path(__file__).resolve().parent.parent / "ephem"
_loader = Loader(str(_EPHEM_DIR))


@lru_cache(maxsize=1)
def _ephem():
    ts = _loader.timescale()
    eph = _loader("de421.bsp")
    return ts, eph, eph["earth"], eph["sun"], eph["moon"]


# --- geometry helpers --------------------------------------------------------


def _overlap_fraction(sep: float, r_sun: float, r_moon: float) -> float:
    """Fraction of the Sun's *area* hidden by the Moon. All args in radians."""
    if sep >= r_sun + r_moon:
        return 0.0
    if sep <= abs(r_sun - r_moon):
        # One disk fully inside the other.
        return 1.0 if r_moon >= r_sun else (r_moon / r_sun) ** 2
    d, rs, rm = sep, r_sun, r_moon
    # Standard circular-segment (lune) area.
    a1 = math.acos(max(-1.0, min(1.0, (d * d + rs * rs - rm * rm) / (2 * d * rs))))
    a2 = math.acos(max(-1.0, min(1.0, (d * d + rm * rm - rs * rs) / (2 * d * rm))))
    area = (
        rs * rs * (a1 - math.sin(2 * a1) / 2) + rm * rm * (a2 - math.sin(2 * a2) / 2)
    )
    return area / (math.pi * rs * rs)


def _magnitude(sep: float, r_sun: float, r_moon: float) -> float:
    """Eclipse magnitude: fraction of the Sun's *diameter* covered."""
    return max(0.0, min((r_sun + r_moon - sep) / (2 * r_sun), r_moon / r_sun))


# --- per-instant state ------------------------------------------------------


@dataclass
class Frame:
    """Everything needed to draw and expose one instant of the eclipse."""

    t_unix: float
    iso_utc: str
    sep: float  # centre separation, radians
    r_sun: float  # apparent semidiameter, radians
    r_moon: float
    # Offset of the Moon's centre from the Sun's centre, in radians, in the
    # observer's frame: +x = toward the horizon-right, +y = toward the zenith.
    # This is what a horizon-levelled camera records.
    dx: float
    dy: float
    pa_north: float  # position angle of Moon from Sun, deg E of celestial N
    pa_zenith: float  # same, but measured from the zenith direction
    obscuration: float  # 0-1, area fraction
    magnitude: float  # 0-1+, diameter fraction
    sun_alt: float  # refracted (apparent) altitude, deg
    sun_alt_geometric: float
    sun_az: float
    moon_alt: float
    moon_az: float
    phase: str  # partial | total | annular | none

    def as_dict(self) -> dict:
        return asdict(self)


def _observer(lat: float, lon: float, elev_m: float):
    _, _, earth, _, _ = _ephem()
    return earth + wgs84.latlon(lat, lon, elevation_m=elev_m)


def _state(obs, t):
    """Topocentric apparent Sun/Moon geometry at Time t (may be an array)."""
    _, _, _, sun, moon = _ephem()
    s = obs.at(t).observe(sun).apparent()
    m = obs.at(t).observe(moon).apparent()

    sep = s.separation_from(m).radians
    r_sun = np.arcsin(R_SUN_KM / (s.distance().km))
    r_moon = np.arcsin(R_MOON_KM / (m.distance().km))
    return s, m, sep, r_sun, r_moon


def _f_outer(obs, t):
    """Zero at C1 / C4 (external contact)."""
    _, _, sep, rs, rm = _state(obs, t)
    return sep - (rs + rm)


def _f_inner(obs, t):
    """Zero at C2 / C3 (internal contact)."""
    _, _, sep, rs, rm = _state(obs, t)
    return sep - abs(rs - rm)


def _bisect(fn, obs, ts, t_lo: float, t_hi: float, tol_s: float = 0.005) -> float:
    """Refine a sign change on [t_lo, t_hi] (both in TT Julian days)."""
    f_lo = float(fn(obs, ts.tt_jd(t_lo)))
    tol = tol_s / 86400.0
    while t_hi - t_lo > tol:
        mid = (t_lo + t_hi) / 2
        f_mid = float(fn(obs, ts.tt_jd(mid)))
        if (f_lo < 0) == (f_mid < 0):
            t_lo, f_lo = mid, f_mid
        else:
            t_hi = mid
    return (t_lo + t_hi) / 2


def _crossings(fn, obs, ts, jd: np.ndarray, vals: np.ndarray) -> list[float]:
    out = []
    sign = np.sign(vals)
    for i in np.nonzero(np.diff(sign) != 0)[0]:
        out.append(_bisect(fn, obs, ts, float(jd[i]), float(jd[i + 1])))
    return out


def frame_at(lat: float, lon: float, elev_m: float, t_unix: float) -> Frame:
    ts, *_ = _ephem()
    obs = _observer(lat, lon, elev_m)
    t = ts.from_datetime(_utc_from_unix(t_unix))
    return _build_frame(obs, t, t_unix)


def _utc_from_unix(t_unix: float):
    from datetime import datetime, timezone

    return datetime.fromtimestamp(t_unix, tz=timezone.utc)


def _build_frame(obs, t, t_unix: float) -> Frame:
    s, m, sep, rs, rm = _state(obs, t)
    sep, rs, rm = float(sep), float(rs), float(rm)

    s_alt, s_az, _ = s.altaz(temperature_C=15.0, pressure_mbar=1013.25)
    s_alt_geo, _, _ = s.altaz()
    m_alt, m_az, _ = m.altaz(temperature_C=15.0, pressure_mbar=1013.25)

    # Position angle of the Moon relative to the Sun, from celestial north.
    s_ra, s_dec, _ = s.radec()
    m_ra, m_dec, _ = m.radec()
    d_ra = m_ra.radians - s_ra.radians
    pa_north = math.degrees(
        math.atan2(
            math.cos(m_dec.radians) * math.sin(d_ra),
            math.sin(m_dec.radians) * math.cos(s_dec.radians)
            - math.cos(m_dec.radians) * math.sin(s_dec.radians) * math.cos(d_ra),
        )
    ) % 360.0

    # Parallactic angle converts celestial PA to a zenith-referenced PA, which
    # is what matters for a camera levelled to the horizon.
    q = _parallactic_angle(s_alt_geo.radians, s_az.radians, s_dec.radians, obs, t)
    pa_zenith = (pa_north - math.degrees(q)) % 360.0

    # Offsets in the observer frame: y toward zenith, x toward horizon-right.
    dx = sep * math.sin(math.radians(pa_zenith))
    dy = sep * math.cos(math.radians(pa_zenith))

    obsc = _overlap_fraction(sep, rs, rm)
    mag = _magnitude(sep, rs, rm)

    if sep >= rs + rm:
        phase = "none"
    elif sep <= abs(rs - rm):
        phase = "total" if rm >= rs else "annular"
    else:
        phase = "partial"

    return Frame(
        t_unix=t_unix,
        iso_utc=t.utc_iso(places=0),
        sep=sep,
        r_sun=rs,
        r_moon=rm,
        dx=dx,
        dy=dy,
        pa_north=pa_north,
        pa_zenith=pa_zenith,
        obscuration=obsc,
        magnitude=mag,
        sun_alt=float(s_alt.degrees),
        sun_alt_geometric=float(s_alt_geo.degrees),
        sun_az=float(s_az.degrees),
        moon_alt=float(m_alt.degrees),
        moon_az=float(m_az.degrees),
        phase=phase,
    )


def _parallactic_angle(alt: float, az: float, dec: float, obs, t) -> float:
    """Angle between celestial north and the zenith direction at the Sun."""
    lat = math.radians(obs.target.latitude.degrees)
    # sin(q) = sin(az) * cos(lat) / cos(dec)
    num = math.sin(az) * math.cos(lat)
    den = math.cos(dec)
    sin_q = max(-1.0, min(1.0, num / den)) if den else 0.0
    cos_q = (math.sin(lat) - math.sin(alt) * math.sin(dec)) / (
        math.cos(alt) * math.cos(dec)
    )
    cos_q = max(-1.0, min(1.0, cos_q))
    return math.atan2(sin_q, cos_q)


# --- local circumstances ----------------------------------------------------


def circumstances(lat: float, lon: float, elev_m: float = 0.0) -> dict:
    """Contact times, max eclipse, and the visibility caveats that matter."""
    ts, *_ = _ephem()
    obs = _observer(lat, lon, elev_m)
    y, mo, d = ECLIPSE_DATE

    # Coarse scan at 20 s: the fastest contact geometry is far slower than that.
    n = int((SEARCH_END_H - SEARCH_START_H) * 3600 / 20) + 1
    hours = np.linspace(SEARCH_START_H, SEARCH_END_H, n)
    t_grid = ts.utc(y, mo, d, hours)
    jd = t_grid.tt

    _, _, sep, rs, rm = _state(obs, t_grid)
    outer = sep - (rs + rm)
    inner = sep - np.abs(rs - rm)

    events: dict[str, float | None] = {k: None for k in ("c1", "c2", "c3", "c4")}

    outer_x = _crossings(_f_outer, obs, ts, jd, outer)
    if outer_x:
        events["c1"] = outer_x[0]
        if len(outer_x) > 1:
            events["c4"] = outer_x[-1]

    inner_x = _crossings(_f_inner, obs, ts, jd, inner)
    if inner_x:
        events["c2"] = inner_x[0]
        if len(inner_x) > 1:
            events["c3"] = inner_x[-1]

    is_eclipsed = bool(outer_x) or bool(np.any(outer < 0))
    if not is_eclipsed:
        return {
            "lat": lat,
            "lon": lon,
            "elevation_m": elev_m,
            "has_eclipse": False,
            "is_total": False,
            "events": {},
            "max": None,
            "notes": ["No solar eclipse is visible from this location."],
        }

    # Maximum eclipse = minimum separation, refined by golden-section search.
    i_min = int(np.argmin(sep))
    lo = float(jd[max(0, i_min - 1)])
    hi = float(jd[min(len(jd) - 1, i_min + 1)])
    t_max = _golden_min(
        lambda tt: float(_state(obs, ts.tt_jd(tt))[2]), lo, hi, tol_s=0.005
    )

    frames = {}
    for key, tt in list(events.items()) + [("max", t_max)]:
        if tt is None:
            continue
        t = ts.tt_jd(tt)
        frames[key] = _build_frame(obs, t, _unix_of(t))

    is_total = events["c2"] is not None and events["c3"] is not None
    totality_s = (
        (events["c3"] - events["c2"]) * 86400.0 if is_total else 0.0
    )

    notes: list[str] = []
    max_frame = frames["max"]

    # Spain sits at the sunset end of the track, so the horizon is a real risk.
    for key, label in (
        ("c1", "first contact"),
        ("c2", "start of totality"),
        ("max", "maximum eclipse"),
        ("c3", "end of totality"),
        ("c4", "last contact"),
    ):
        f = frames.get(key)
        if f and f.sun_alt_geometric < 0:
            notes.append(f"The Sun is below the horizon at {label} — not observable.")
        elif f and f.sun_alt < 2:
            notes.append(
                f"At {label} the Sun is only {f.sun_alt:.1f}° up — you need a "
                "clear, unobstructed horizon."
            )

    if is_total:
        notes.append(
            f"Totality lasts {totality_s:.0f} s with the Sun at "
            f"{frames['max'].sun_alt:.1f}°."
        )
    else:
        notes.append(
            f"Partial eclipse only: {max_frame.obscuration * 100:.1f}% of the "
            "Sun's area is covered at maximum. Move into the path of totality "
            "for the total phase."
        )

    return {
        "lat": lat,
        "lon": lon,
        "elevation_m": elev_m,
        "has_eclipse": True,
        "is_total": is_total,
        "totality_seconds": totality_s,
        "events": {k: v.as_dict() for k, v in frames.items()},
        "max": max_frame.as_dict(),
        "max_obscuration": max_frame.obscuration,
        "max_magnitude": max_frame.magnitude,
        "notes": notes,
        "sun_set_unix": _sunset_unix(obs, lat, lon, elev_m),
    }


def _unix_of(t) -> float:
    return t.utc_datetime().timestamp()


@lru_cache(maxsize=8192)
def _summary_at(lat: float, lon: float) -> dict:
    c = circumstances(lat, lon, 0.0)
    if not c["has_eclipse"]:
        return {"has_eclipse": False, "is_total": False}
    return {
        "has_eclipse": True,
        "is_total": c["is_total"],
        "totality_seconds": c.get("totality_seconds", 0.0),
        "max_obscuration": c["max_obscuration"],
        "max_t_unix": c["max"]["t_unix"],
        "sun_alt_at_max": c["max"]["sun_alt"],
        "sun_up_at_max": c["max"]["sun_alt_geometric"] > 0,
    }


def summary(lat: float, lon: float) -> dict:
    """A compact verdict for one spot, for annotating a list of candidates.

    Cached on coordinates rounded to ~100 m, which is far finer than anything
    that changes the answer, and lets a list of search results resolve without
    recomputing as the user retypes.
    """
    return {**_summary_at(round(lat, 3), round(lon, 3)), "lat": lat, "lon": lon}


def _golden_min(fn, lo: float, hi: float, tol_s: float = 0.01) -> float:
    """Golden-section minimisation on a unimodal function of TT Julian days."""
    inv = (math.sqrt(5) - 1) / 2
    tol = tol_s / 86400.0
    a, b = lo, hi
    c, d = b - inv * (b - a), a + inv * (b - a)
    fc, fd = fn(c), fn(d)
    while b - a > tol:
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - inv * (b - a)
            fc = fn(c)
        else:
            a, c, fc = c, d, fd
            d = a + inv * (b - a)
            fd = fn(d)
    return (a + b) / 2


def _sunset_unix(obs, lat: float, lon: float, elev_m: float) -> float | None:
    from skyfield import almanac

    ts, eph, *_ = _ephem()
    y, mo, d = ECLIPSE_DATE
    t0 = ts.utc(y, mo, d, 12)
    t1 = ts.utc(y, mo, d + 1, 6)
    topos = wgs84.latlon(lat, lon, elevation_m=elev_m)
    f = almanac.sunrise_sunset(eph, topos)
    times, events = almanac.find_discrete(t0, t1, f)
    for t, e in zip(times, events):
        if e == 0:  # sunset
            return _unix_of(t)
    return None


# --- dense series for the scrubber -----------------------------------------


def series(
    lat: float, lon: float, elev_m: float, step_s: float = 10.0
) -> dict:
    """Sampled frames from C1 to C4 so the timeline scrubs without round-trips.

    Totality is resampled at 1 s because that is where every second counts.
    """
    circ = circumstances(lat, lon, elev_m)
    if not circ["has_eclipse"]:
        return {"circumstances": circ, "frames": []}

    ts, *_ = _ephem()
    obs = _observer(lat, lon, elev_m)
    ev = circ["events"]
    t_start = ev.get("c1", circ["max"])["t_unix"]
    t_end = ev.get("c4", circ["max"])["t_unix"]
    # Pad so the slider shows a little uneclipsed Sun at each end.
    t_start -= 120
    t_end += 120

    stamps = list(np.arange(t_start, t_end + step_s, step_s))
    if circ["is_total"]:
        stamps += list(
            np.arange(ev["c2"]["t_unix"] - 5, ev["c3"]["t_unix"] + 5, 1.0)
        )
        # Baily's beads live in a window of a couple of seconds and individual
        # beads last a fraction of one, so 1 s sampling cannot land on them.
        # Sample the contacts at 0.1 s so the scrubber can actually resolve them.
        for key in ("c2", "c3"):
            tc = ev[key]["t_unix"]
            stamps += list(np.arange(tc - 8.0, tc + 8.0, 0.1))
    stamps = sorted(set(round(float(s), 3) for s in stamps))

    from datetime import datetime, timezone

    t_arr = ts.from_datetimes(
        [datetime.fromtimestamp(s, tz=timezone.utc) for s in stamps]
    )
    s, m, sep, rs, rm = _state(obs, t_arr)
    s_alt, s_az, _ = s.altaz(temperature_C=15.0, pressure_mbar=1013.25)
    s_alt_geo, _, _ = s.altaz()

    frames = []
    for i, tu in enumerate(stamps):
        sep_i, rs_i, rm_i = float(sep[i]), float(rs[i]), float(rm[i])
        if sep_i >= rs_i + rm_i:
            phase = "none"
        elif sep_i <= abs(rs_i - rm_i):
            phase = "total" if rm_i >= rs_i else "annular"
        else:
            phase = "partial"
        frames.append(
            {
                "t_unix": tu,
                "sep": sep_i,
                "r_sun": rs_i,
                "r_moon": rm_i,
                "phase": phase,
                "obscuration": _overlap_fraction(sep_i, rs_i, rm_i),
                "magnitude": _magnitude(sep_i, rs_i, rm_i),
                "sun_alt": float(s_alt.degrees[i]),
                "sun_alt_geometric": float(s_alt_geo.degrees[i]),
                "sun_az": float(s_az.degrees[i]),
            }
        )

    # Position angles need per-instant scalar work; interpolate from the
    # contact frames instead of recomputing, then fill exactly at contacts.
    _attach_position_angles(obs, ts, frames)
    return {"circumstances": circ, "frames": frames}


def _attach_position_angles(obs, ts, frames: list[dict]) -> None:
    """Add dx/dy (zenith-referenced offsets) to each sampled frame.

    The parallactic angle drifts smoothly, so sampling it every ~30th frame and
    interpolating keeps this fast without visible error in the rendering.
    """
    from datetime import datetime, timezone

    idx = list(range(0, len(frames), 30))
    if idx[-1] != len(frames) - 1:
        idx.append(len(frames) - 1)

    sampled = []
    for i in idx:
        t = ts.from_datetime(
            datetime.fromtimestamp(frames[i]["t_unix"], tz=timezone.utc)
        )
        f = _build_frame(obs, t, frames[i]["t_unix"])
        sampled.append((i, f.pa_zenith, f.pa_north))

    for j in range(len(sampled) - 1):
        i0, pz0, pn0 = sampled[j]
        i1, pz1, pn1 = sampled[j + 1]
        # Unwrap so interpolation does not jump across 0/360.
        dz = ((pz1 - pz0 + 180) % 360) - 180
        dn = ((pn1 - pn0 + 180) % 360) - 180
        span = max(1, i1 - i0)
        for i in range(i0, min(i1 + 1, len(frames))):
            w = (i - i0) / span
            pz = (pz0 + dz * w) % 360
            pn = (pn0 + dn * w) % 360
            frames[i]["pa_zenith"] = pz
            frames[i]["pa_north"] = pn
            sep = frames[i]["sep"]
            frames[i]["dx"] = sep * math.sin(math.radians(pz))
            frames[i]["dy"] = sep * math.cos(math.radians(pz))
