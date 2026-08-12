"""Baily's beads from the Moon's real limb topography.

Beads are not a geometric artefact of two perfect circles — they are sunlight
shining through valleys on the Moon's limb while the ridges either side of them
have already covered the photosphere. Predicting *which* beads appear therefore
needs an actual limb profile, which this module builds from LOLA laser altimetry
plus the Moon's physical libration at the moment of contact:

  1. Put the observer in the Moon-fixed (mean-Earth/polar axis) frame, so we
     know exactly which lunar terrain is on the limb as seen from that spot.
  2. For every position angle around the limb, take the *maximum* apparent
     angular radius over the terrain near the tangent line — the limb we see is
     the silhouette of the highest ground along each line of sight.
  3. Slide that jagged limb across the Sun's edge and record where, and when,
     photosphere is still visible.

Resolution limit: the LOLA grid used here is 16 pixels/degree, about 1.9 km at
the limb, or ~1.1 arcsecond as seen from Earth. That resolves the major valleys
that produce the prominent beads, but not the finest structure — treat bead
timings as good to roughly a second, not to a video frame.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from functools import lru_cache
from pathlib import Path

import numpy as np

from .eclipse import (
    R_MOON_KM,
    _build_frame,
    _ephem,
    _loader,
    _observer,
    circumstances,
)

DATA = Path(__file__).resolve().parent.parent / "data"
DEM_PATH = DATA / "ldem_16.img"

# LOLA LDEM_16 grid: simple cylindrical, pixel registered, positive east.
DEM_ROWS, DEM_COLS = 2880, 5760
DEM_PPD = 16.0
DEM_SCALE_M = 0.5
DEM_OFFSET_M = 1737400.0

#: How far either side of the geometric limb to search for silhouette terrain.
#: Verified by convergence: the profile is identical at 5 and 8 degrees, while
#: 3 degrees still clips the occasional tall polar peak.
BAND_DEG = 5.0

#: Position-angle bins around the limb, matched to the data: the DEM offers
#: about 5761 distinct samples around the limb (2*pi*1737.4 km / 1.895 km), so
#: fewer bins than that would throw away real structure and more would only
#: interpolate. One bin is ~1.1 arcsec of arc, the same as the DEM's resolution.
PA_BINS = 5760

SETUP_HINT = (
    "Lunar limb data missing. Fetch it once with: "
    "uv run python -m backend.scripts.fetch_lunar"
)

RAD2ASEC = 180.0 * 3600.0 / math.pi


def available() -> bool:
    return DEM_PATH.exists() and (
        _loader.path_to("moon_pa_de421_1900-2050.bpc") and
        Path(_loader.path_to("moon_pa_de421_1900-2050.bpc")).exists()
    )


@lru_cache(maxsize=1)
def _dem() -> np.memmap:
    if not DEM_PATH.exists():
        raise FileNotFoundError(SETUP_HINT)
    return np.memmap(DEM_PATH, dtype="<i2", mode="r", shape=(DEM_ROWS, DEM_COLS))


@lru_cache(maxsize=1)
def _moon_frame():
    """The Moon-fixed frame, which is what carries the physical libration."""
    from skyfield.planetarylib import PlanetaryConstants

    pc = PlanetaryConstants()
    pc.read_text(_loader.open("moon_080317.tf"))
    pc.read_text(_loader.open("pck00011.tpc"))
    pc.read_binary(_loader.open("moon_pa_de421_1900-2050.bpc"))
    return pc.build_frame_named("MOON_ME_DE421")


def _row_lat(rows: np.ndarray) -> np.ndarray:
    return (1439.5 - rows) / DEM_PPD


def _col_lon(cols: np.ndarray) -> np.ndarray:
    return (cols + 0.5) / DEM_PPD


# --- observer geometry ------------------------------------------------------


@dataclass
class LimbGeometry:
    """Where the observer sits relative to the Moon's body-fixed frame."""

    s_hat: np.ndarray  # Moon centre -> observer, unit, Moon-fixed
    n_mf: np.ndarray  # sky "north" direction, expressed Moon-fixed
    e_mf: np.ndarray  # sky "east" direction, expressed Moon-fixed
    distance_km: float
    sub_lat: float  # selenographic latitude of the observer's zenith point
    sub_lon: float


def _geometry(lat: float, lon: float, elev_m: float, t) -> LimbGeometry:
    _, _, _, _, moon = _ephem()
    obs = _observer(lat, lon, elev_m)
    frame = _moon_frame()

    app = obs.at(t).observe(moon).apparent()
    u = app.position.km / np.linalg.norm(app.position.km)  # observer -> Moon
    d_km = float(app.distance().km)

    # Sky-plane basis: east = increasing right ascension, north completes it.
    z = np.array([0.0, 0.0, 1.0])
    e = np.cross(z, u)
    e /= np.linalg.norm(e)
    n = np.cross(u, e)

    # Rotate into the Moon-fixed frame. The Moon turns only 2e-4 degrees during
    # the 1.2 s of light travel, far below the DEM's resolution, so evaluating
    # the orientation at the observer's time is fine here.
    R = frame.rotation_at(t)
    s_hat = -(R @ u)
    n_mf = R @ n
    e_mf = R @ e

    sub_lat = math.degrees(math.asin(max(-1.0, min(1.0, s_hat[2]))))
    sub_lon = math.degrees(math.atan2(s_hat[1], s_hat[0]))
    return LimbGeometry(s_hat, n_mf, e_mf, d_km, sub_lat, sub_lon)


# --- the limb profile ------------------------------------------------------


def _limb_band_columns(lat_deg: float, g: LimbGeometry, c: float, eps: float):
    """Longitude window, in DEM columns, where this row can touch the limb.

    Solved analytically per row rather than by scanning all 16.6 million DEM
    pixels: p_hat . s_hat = A + B cos(lon - lon0), so the band is a pair of
    symmetric arcs about the sub-observer longitude.
    """
    lat = math.radians(lat_deg)
    lat0 = math.radians(g.sub_lat)
    A = math.sin(lat) * math.sin(lat0)
    B = math.cos(lat) * math.cos(lat0)

    if B < 1e-9:
        # Within a whisker of the sub-observer pole: either the whole row is in
        # the band or none of it is.
        return [(0, DEM_COLS)] if abs(A - c) < eps else []

    lo = (c - eps - A) / B
    hi = (c + eps - A) / B
    if lo > 1.0 or hi < -1.0:
        return []
    d_hi = math.acos(max(-1.0, min(1.0, lo)))  # larger |delta|
    d_lo = math.acos(max(-1.0, min(1.0, hi)))  # smaller |delta|

    spans = []
    for sign in (1.0, -1.0):
        a = g.sub_lon + math.degrees(sign * d_lo)
        b = g.sub_lon + math.degrees(sign * d_hi)
        c0, c1 = sorted((a, b))
        i0 = int(math.floor(c0 * DEM_PPD))
        i1 = int(math.ceil(c1 * DEM_PPD)) + 1
        spans.append((i0, i1))
    return spans


@dataclass
class LimbProfile:
    pa_deg: np.ndarray  # position angle from celestial north, east-positive
    theta_rad: np.ndarray  # apparent angular radius of the limb at that PA
    sel_lat: np.ndarray  # selenographic latitude of the silhouette point
    sel_lon: np.ndarray
    mean_sphere_rad: float  # angular radius of a smooth 1737.4 km Moon
    distance_km: float
    sub_lat: float
    sub_lon: float

    def relief_km(self) -> np.ndarray:
        """Radial relief in km relative to the reference sphere."""
        d = self.distance_km
        # theta = r sin(psi) / (d - r cos(psi)); invert for r at small angles.
        return (self.theta_rad * d) / (1.0 + self.theta_rad**2) ** 0.5 - R_MOON_KM


@lru_cache(maxsize=64)
def _profile_cached(lat_r: float, lon_r: float, elev_m: float, t_unix_r: float):
    from datetime import datetime, timezone

    ts, *_ = _ephem()
    t = ts.from_datetime(datetime.fromtimestamp(t_unix_r, tz=timezone.utc))
    g = _geometry(lat_r, lon_r, elev_m, t)
    dem = _dem()

    d = g.distance_km
    c = R_MOON_KM / d  # p_hat . s_hat at tangency on the reference sphere
    eps = math.sin(math.radians(BAND_DEG))

    # Accumulate the maximum apparent radius per position-angle bin.
    best = np.full(PA_BINS, -1.0)
    best_lat = np.zeros(PA_BINS)
    best_lon = np.zeros(PA_BINS)

    rows = np.arange(DEM_ROWS)
    lats = _row_lat(rows)
    # Only rows that can reach the band are worth reading.
    lat0 = math.radians(g.sub_lat)
    A_all = np.sin(np.radians(lats)) * math.sin(lat0)
    B_all = np.cos(np.radians(lats)) * math.cos(lat0)
    reachable = np.abs(A_all - c) <= eps + np.abs(B_all)

    for row in rows[reachable]:
        lat_deg = float(lats[row])
        spans = _limb_band_columns(lat_deg, g, c, eps)
        if not spans:
            continue
        for i0, i1 in spans:
            idx = np.arange(i0, i1) % DEM_COLS
            r_km = dem[row, idx].astype(np.float64) * DEM_SCALE_M / 1000.0 + (
                DEM_OFFSET_M / 1000.0
            )
            lon_deg = _col_lon(np.arange(i0, i1).astype(np.float64))

            la = math.radians(lat_deg)
            lo = np.radians(lon_deg)
            px = math.cos(la) * np.cos(lo)
            py = math.cos(la) * np.sin(lo)
            pz = math.sin(la) * np.ones_like(px)

            cos_psi = px * g.s_hat[0] + py * g.s_hat[1] + pz * g.s_hat[2]
            sin_psi = np.sqrt(np.maximum(0.0, 1.0 - cos_psi**2))
            denom = d - r_km * cos_psi
            theta = r_km * sin_psi / denom

            # Position angle in the sky, from the components perpendicular to
            # the line of sight (the radius cancels out of the ratio).
            a_n = px * g.n_mf[0] + py * g.n_mf[1] + pz * g.n_mf[2]
            a_e = px * g.e_mf[0] + py * g.e_mf[1] + pz * g.e_mf[2]
            pa = np.degrees(np.arctan2(a_e, a_n)) % 360.0

            b = np.minimum((pa / 360.0 * PA_BINS).astype(int), PA_BINS - 1)
            # Keep the highest silhouette per bin.
            order = np.argsort(theta)
            b_s, th_s = b[order], theta[order]
            la_s = np.full(b_s.shape, lat_deg)
            lo_s = lon_deg[order]
            improved = th_s > best[b_s]
            bb = b_s[improved]
            best[bb] = th_s[improved]
            best_lat[bb] = la_s[improved]
            best_lon[bb] = lo_s[improved]

    if np.any(best < 0):
        # Fill any bin the band missed by interpolating its neighbours.
        good = best > 0
        idx = np.arange(PA_BINS)
        best[~good] = np.interp(idx[~good], idx[good], best[good], period=PA_BINS)
        best_lat[~good] = np.interp(
            idx[~good], idx[good], best_lat[good], period=PA_BINS
        )
        best_lon[~good] = np.interp(
            idx[~good], idx[good], best_lon[good], period=PA_BINS
        )

    pa_centers = (np.arange(PA_BINS) + 0.5) * 360.0 / PA_BINS
    mean_sphere = math.atan(R_MOON_KM / math.sqrt(d * d - R_MOON_KM**2))
    return LimbProfile(
        pa_deg=pa_centers,
        theta_rad=best,
        sel_lat=best_lat,
        sel_lon=((best_lon + 180.0) % 360.0) - 180.0,
        mean_sphere_rad=mean_sphere,
        distance_km=d,
        sub_lat=g.sub_lat,
        sub_lon=g.sub_lon,
    )


def limb_profile(lat: float, lon: float, elev_m: float, t_unix: float) -> LimbProfile:
    """Limb profile for one spot and moment. Cached: libration barely moves."""
    return _profile_cached(round(lat, 3), round(lon, 3), round(elev_m), round(t_unix))


# --- beads -----------------------------------------------------------------


@dataclass
class Bead:
    """One gap in the lunar limb, tracked from first to last light."""

    pa_deg: float  # position angle on the limb, celestial north, east +
    pa_zenith_deg: float  # same, referenced to the zenith (camera-friendly)
    clock: str  # where to look in a horizon-levelled frame
    t_first: float
    t_last: float
    duration_s: float
    peak_depth_asec: float  # how far the photosphere pokes past the limb
    width_deg: float  # angular extent along the limb at its widest
    sel_lat: float  # selenographic latitude of the valley responsible
    sel_lon: float

    def as_dict(self) -> dict:
        return asdict(self)


def _clock_position(pa_zenith_deg: float) -> str:
    """PA measured from the zenith into a clock face, as photographers read it."""
    hour = int(round(pa_zenith_deg / 30.0)) % 12
    return f"{12 if hour == 0 else hour} o'clock"


#: A lit arc wider than this is still the crescent, not a bead. The beads phase
#: begins when the crescent breaks into separate points of light.
CRESCENT_MAX_DEG = 18.0

#: Lit arcs separated by a gap narrower than this are one bead, not two. Ridges
#: this thin are below what a 1.9 km DEM can honestly resolve, and no camera
#: would record them as separate points of light either.
CLOSE_GAP_DEG = 1.5

#: Ignore arcs narrower than this. The DEM resolves ~1.1 arcsec, which at the
#: limb is about 0.06 deg of position angle, so anything under a few tenths of a
#: degree is noise dressed up as a bead.
MIN_ARC_DEG = 0.3

#: How long a bead may vanish and still be treated as the same bead, rather than
#: being retired and re-discovered as a duplicate.
COAST_S = 0.4


def _sky_offsets(obs, ts, stamps: np.ndarray):
    """Moon centre relative to Sun centre, in the sky plane, for many times.

    Worked as (east, north) offsets rather than separation-and-position-angle:
    near internal contact the two centres are only ~15 arcsec apart, so the
    position angle swings through tens of degrees in seconds and cannot be
    interpolated, while these components stay smooth and near-linear.
    """
    from datetime import datetime, timezone
    from .eclipse import _state

    t_arr = ts.from_datetimes(
        [datetime.fromtimestamp(float(s), tz=timezone.utc) for s in stamps]
    )
    s, m, sep, rs, rm = _state(obs, t_arr)
    s_ra, s_dec, _ = s.radec()
    m_ra, m_dec, _ = m.radec()
    d_ra = (m_ra.radians - s_ra.radians + math.pi) % (2 * math.pi) - math.pi
    east = d_ra * np.cos(s_dec.radians)
    north = m_dec.radians - s_dec.radians
    return east, north, np.asarray(rs), np.asarray(rm)


def _close_gaps(lit: np.ndarray, gap_bins: int) -> np.ndarray:
    """Morphological closing around the limb: fill dark gaps up to gap_bins."""
    if gap_bins < 1 or not lit.any() or lit.all():
        return lit
    out = lit.copy()
    n = len(lit)
    # Work on the dark runs of the wrapped array and fill the short ones.
    dark = ~lit
    idx = np.arange(n)
    edges = np.diff(dark.astype(np.int8))
    starts = list(np.where(edges == 1)[0] + 1)
    ends = list(np.where(edges == -1)[0] + 1)
    if dark[0]:
        starts.insert(0, 0)
    if dark[-1]:
        ends.append(n)
    runs = list(zip(starts, ends))
    if len(runs) > 1 and dark[0] and dark[-1]:
        first, last = runs[0], runs[-1]
        runs = runs[1:-1] + [(last[0], last[1] + first[1])]
    for s0, e0 in runs:
        if (e0 - s0) <= gap_bins:
            out[idx[np.arange(s0, e0) % n]] = True
    return out


def _arcs(lit: np.ndarray) -> list[tuple[int, int]]:
    """Contiguous lit runs as (start, end_exclusive), joined across the seam."""
    if not lit.any():
        return []
    if lit.all():
        return [(0, len(lit))]
    edges = np.diff(lit.astype(np.int8))
    starts = list(np.where(edges == 1)[0] + 1)
    ends = list(np.where(edges == -1)[0] + 1)
    if lit[0]:
        starts.insert(0, 0)
    if lit[-1]:
        ends.append(len(lit))
    runs = list(zip(starts, ends))
    # Merge a run that wraps 0/360.
    if len(runs) > 1 and lit[0] and lit[-1]:
        first, last = runs[0], runs[-1]
        runs = runs[1:-1] + [(last[0], last[1] + first[1])]
    return runs


def beads_cached(lat: float, lon: float, elev_m: float, contact: str) -> dict:
    """Beads for a site, cached on ~100 m coordinates like the other summaries."""
    return _beads_cached(round(lat, 3), round(lon, 3), round(elev_m), contact)


@lru_cache(maxsize=256)
def _beads_cached(lat: float, lon: float, elev_m: float, contact: str) -> dict:
    return beads(lat, lon, elev_m, contact)


def _no_totality(contact: str) -> dict:
    return {
        "available": True,
        "is_total": False,
        "contact": contact,
        "beads": [],
        "note": (
            "There is no totality here, so there are no Baily's beads — the "
            "Moon never fully covers the Sun. Move inside the path of totality."
        ),
    }


def depth_field(
    lat: float,
    lon: float,
    elev_m: float,
    contact: str,
    window_s: float = 25.0,
    step_s: float = 0.05,
):
    """How far the photosphere pokes past the lunar limb, over time and angle.

    This is the raw quantity everything else is derived from: positive means
    sunlight is visible at that position angle at that instant. Returns
    (stamps, depth[n_times, PA_BINS], profile, reference frame).
    """
    if contact not in ("c2", "c3"):
        raise ValueError("contact must be 'c2' or 'c3'")

    t_contact = circumstances(lat, lon, elev_m)["events"][contact]["t_unix"]
    prof = limb_profile(lat, lon, elev_m, t_contact)

    ts, *_ = _ephem()
    obs = _observer(lat, lon, elev_m)
    from datetime import datetime, timezone

    pa_rad = np.radians(prof.pa_deg)
    sin_pa, cos_pa = np.sin(pa_rad), np.cos(pa_rad)

    stamps = np.arange(t_contact - window_s, t_contact + window_s + step_s, step_s)
    east, north, r_sun, r_moon = _sky_offsets(obs, ts, stamps)

    ref = _build_frame(
        obs,
        ts.from_datetime(datetime.fromtimestamp(t_contact, tz=timezone.utc)),
        t_contact,
    )

    # Rescale the profile for the Moon's changing distance across the window.
    # Multiplicative, since apparent size goes as r/d: this preserves the relief
    # in proportion, where an additive shift would flatten out the upper-envelope
    # bias that makes the silhouette sit above the reference sphere.
    r_moon_ref = prof.mean_sphere_rad
    depth = np.empty((len(stamps), PA_BINS), dtype=np.float32)
    for i in range(len(stamps)):
        theta = prof.theta_rad * (r_moon[i] / r_moon_ref)
        lx = east[i] + theta * sin_pa
        ly = north[i] + theta * cos_pa
        depth[i] = r_sun[i] - np.hypot(lx, ly)
    return stamps, depth, prof, ref


def beads(
    lat: float,
    lon: float,
    elev_m: float,
    contact: str = "c2",
    window_s: float = 25.0,
    step_s: float = 0.05,
    min_duration_s: float = 0.1,
) -> dict:
    """Predict the individual Baily's beads around second or third contact."""
    if contact not in ("c2", "c3"):
        raise ValueError("contact must be 'c2' or 'c3'")

    circ = circumstances(lat, lon, elev_m)
    if not circ["is_total"]:
        return _no_totality(contact)

    t_contact = circ["events"][contact]["t_unix"]
    stamps, depth_all, prof, ref = depth_field(
        lat, lon, elev_m, contact, window_s, step_s
    )
    bin_deg = 360.0 / PA_BINS
    zen_offset = ref.pa_zenith - ref.pa_north

    # Walk time forward, find the lit arcs at each instant, and thread them into
    # beads. A bead is continued by the nearest lit arc in the next frame; an arc
    # with no predecessor starts a new bead, which is exactly what happens when
    # the crescent snaps into two.
    @dataclass
    class _Track:
        pa: float
        t_first: float
        t_last: float
        peak_depth: float
        peak_width: float
        peak_pa: float
        peak_bin: int
        n_frames: int
        misses: int = 0

    active: list[_Track] = []
    done: list[_Track] = []
    n_arcs_by_time = np.zeros(len(stamps), dtype=int)
    widest_by_time = np.zeros(len(stamps))
    any_lit = np.zeros(len(stamps), dtype=bool)
    gap_bins = int(round(CLOSE_GAP_DEG / bin_deg))
    min_arc_bins = max(1, int(round(MIN_ARC_DEG / bin_deg)))
    coast_frames = max(1, int(round(COAST_S / step_s)))

    for i in range(len(stamps)):
        depth = depth_all[i]
        lit = _close_gaps(depth > 0, gap_bins)
        any_lit[i] = lit.any()
        runs = [(s, e) for s, e in _arcs(lit) if (e - s) >= min_arc_bins]
        n_arcs_by_time[i] = len(runs)
        widest_by_time[i] = max(
            ((e - s) * bin_deg for s, e in runs), default=0.0
        )

        seen: list[_Track] = []
        for s0, e0 in runs:
            idx = np.arange(s0, e0) % PA_BINS
            sub = depth[idx]
            k = int(np.argmax(sub))
            j_abs = int(idx[k])
            pa_c = float(prof.pa_deg[j_abs])
            width = (e0 - s0) * bin_deg
            # Nearest active bead, by angular distance around the limb. The
            # tolerance scales with the arc so a widening bead keeps its identity.
            best, best_d = None, 1e9
            for tr in active:
                if tr in seen:
                    continue
                d = abs(((pa_c - tr.pa + 180.0) % 360.0) - 180.0)
                if d < best_d:
                    best, best_d = tr, d
            if best is not None and best_d <= 5.0 + 0.5 * width:
                best.pa = pa_c
                best.t_last = float(stamps[i])
                best.n_frames += 1
                best.misses = 0
                if sub[k] > best.peak_depth:
                    best.peak_depth = float(sub[k])
                    best.peak_width = width
                    best.peak_pa = pa_c
                    best.peak_bin = j_abs
                seen.append(best)
            else:
                tr = _Track(
                    pa=pa_c,
                    t_first=float(stamps[i]),
                    t_last=float(stamps[i]),
                    peak_depth=float(sub[k]),
                    peak_width=width,
                    peak_pa=pa_c,
                    peak_bin=j_abs,
                    n_frames=1,
                )
                active.append(tr)
                seen.append(tr)

        # Let an unmatched bead coast for a moment: a single frame dipping below
        # the threshold would otherwise retire it and it would be rediscovered as
        # a duplicate at the same position angle.
        for tr in [t for t in active if t not in seen]:
            tr.misses += 1
            if tr.misses > coast_frames:
                active.remove(tr)
                done.append(tr)

    done.extend(active)

    # Merge any residual duplicates: same place on the limb, overlapping in time.
    done.sort(key=lambda t: (t.peak_pa, t.t_first))
    merged: list[_Track] = []
    for tr in done:
        hit = None
        for m in merged:
            near = abs(((tr.peak_pa - m.peak_pa + 180.0) % 360.0) - 180.0) < 1.5
            overlap = tr.t_first <= m.t_last + COAST_S and m.t_first <= tr.t_last + COAST_S
            if near and overlap:
                hit = m
                break
        if hit is None:
            merged.append(tr)
            continue
        hit.t_first = min(hit.t_first, tr.t_first)
        hit.t_last = max(hit.t_last, tr.t_last)
        hit.n_frames += tr.n_frames
        if tr.peak_depth > hit.peak_depth:
            hit.peak_depth = tr.peak_depth
            hit.peak_width = tr.peak_width
            hit.peak_pa = tr.peak_pa
            hit.peak_bin = tr.peak_bin
    done = merged

    # The beads phase proper: some light remains but no continuous crescent does.
    # Defining it by "two or more arcs" would start it far too early, since a
    # single bead often detaches at a cusp while most of the crescent is intact.
    is_bead_phase = any_lit & (widest_by_time <= CRESCENT_MAX_DEG)
    phase_idx = np.where(is_bead_phase)[0]
    lit_idx = np.where(any_lit)[0]

    # True contact from the real limb, versus the smooth-sphere prediction.
    if contact == "c2":
        true_contact = float(stamps[lit_idx[-1]]) + step_s if len(lit_idx) else None
    else:
        true_contact = float(stamps[lit_idx[0]]) if len(lit_idx) else None

    out: list[Bead] = []
    for tr in done:
        dur = tr.t_last - tr.t_first + step_s
        if dur < min_duration_s:
            continue
        # Only count tracks that were beads rather than the crescent itself.
        if tr.peak_width > CRESCENT_MAX_DEG:
            continue
        paz = (tr.peak_pa + zen_offset) % 360.0
        out.append(
            Bead(
                pa_deg=round(tr.peak_pa, 2),
                pa_zenith_deg=round(paz, 2),
                clock=_clock_position(paz),
                t_first=tr.t_first,
                t_last=tr.t_last,
                duration_s=round(dur, 2),
                peak_depth_asec=round(tr.peak_depth * RAD2ASEC, 3),
                width_deg=round(tr.peak_width, 2),
                sel_lat=round(float(prof.sel_lat[tr.peak_bin]), 2),
                sel_lon=round(float(prof.sel_lon[tr.peak_bin]), 2),
            )
        )
    out.sort(key=lambda b: b.t_first)

    relief = prof.relief_km()
    result = {
        "available": True,
        "is_total": True,
        "contact": contact,
        "contact_t_unix": t_contact,
        "true_contact_t_unix": true_contact,
        "limb_correction_s": (
            round(true_contact - t_contact, 2) if true_contact else None
        ),
        "beads": [b.as_dict() for b in out],
        "max_simultaneous": int(n_arcs_by_time.max()),
        "profile": {
            "relief_min_km": round(float(relief.min()), 3),
            "relief_max_km": round(float(relief.max()), 3),
            "relief_rms_km": round(float(relief.std()), 3),
            "sub_lat": round(prof.sub_lat, 4),
            "sub_lon": round(prof.sub_lon, 4),
            "distance_km": round(prof.distance_km, 1),
            "resolution_asec": round(
                math.degrees(1.895 / prof.distance_km) * 3600.0, 3
            ),
        },
    }
    if len(phase_idx):
        result["phase_start"] = float(stamps[phase_idx[0]])
        result["phase_end"] = float(stamps[phase_idx[-1]])
        result["phase_duration_s"] = round(
            float(stamps[phase_idx[-1]] - stamps[phase_idx[0]]) + step_s, 2
        )
    n = len(out)
    result["note"] = (
        f"{n} bead{'' if n == 1 else 's'} resolved, up to "
        f"{int(n_arcs_by_time.max())} visible at once. From LOLA topography at "
        "16 pixels/degree (~1.1 arcsec), so timings are good to roughly a "
        "second and the faintest beads may be missed."
    )
    return result


def profile_for_display(
    lat: float, lon: float, elev_m: float, t_unix: float, points: int = 720
) -> dict:
    """Down-sampled limb profile for drawing the jagged limb in the UI."""
    prof = limb_profile(lat, lon, elev_m, t_unix)
    step = max(1, PA_BINS // points)
    return {
        "pa_deg": prof.pa_deg[::step].round(3).tolist(),
        "theta_rad": prof.theta_rad[::step].tolist(),
        "relief_km": prof.relief_km()[::step].round(4).tolist(),
        # Where on the Moon each point of the limb actually is, so the terrain
        # map can draw the limb track and label what you are looking at.
        "sel_lat": prof.sel_lat[::step].round(3).tolist(),
        "sel_lon": prof.sel_lon[::step].round(3).tolist(),
        "mean_sphere_rad": prof.mean_sphere_rad,
        "sub_lat": round(prof.sub_lat, 4),
        "sub_lon": round(prof.sub_lon, 4),
        "distance_km": round(prof.distance_km, 1),
    }


def bead_map(
    lat: float,
    lon: float,
    elev_m: float,
    contact: str,
    n_times: int = 240,
    n_pa: int = 480,
) -> dict:
    """The depth field itself, downsampled for plotting.

    A position-angle-versus-time map is the honest picture of what happens at
    contact: the crescent narrows, snaps into separate beads, and each one winks
    out at its own moment. Restricted to the arc and interval that actually carry
    light, so the plot is not mostly empty.
    """
    circ = circumstances(lat, lon, elev_m)
    if not circ["is_total"]:
        return _no_totality(contact)

    stamps, depth, prof, ref = depth_field(lat, lon, elev_m, contact)
    lit = depth > 0
    if not lit.any():
        return {**_no_totality(contact), "is_total": True}

    # Crop the time axis to where the lit arc has already narrowed. Showing the
    # full window would devote most of the plot to a fat, featureless crescent
    # and squeeze the break-up — the part worth looking at — into a sliver.
    bin_deg = 360.0 / PA_BINS
    arc_deg = lit.sum(axis=1) * bin_deg
    narrow = np.where(lit.any(axis=1) & (arc_deg <= 45.0))[0]
    t_idx = np.where(lit.any(axis=1))[0]
    if len(narrow):
        pad = int(round(1.5 / 0.05))
        t0 = max(0, narrow[0] - pad)
        t1 = min(len(stamps), narrow[-1] + pad + 1)
    else:
        t0 = max(0, t_idx[0] - 20)
        t1 = min(len(stamps), t_idx[-1] + 21)

    # Position angle wraps, so find the lit arc by rolling to the widest gap.
    ever = lit.any(axis=0)
    pa_idx = np.where(ever)[0]
    roll = 0
    if len(pa_idx) > 1:
        gaps = np.diff(np.concatenate([pa_idx, pa_idx[:1] + PA_BINS]))
        biggest = int(np.argmax(gaps))
        roll = -int(pa_idx[(biggest + 1) % len(pa_idx)])
    rolled = np.roll(depth[t0:t1], roll, axis=1)
    rolled_ever = np.roll(ever, roll)
    j = np.where(rolled_ever)[0]
    j0 = max(0, j[0] - 8)
    j1 = min(PA_BINS, j[-1] + 9)
    crop = rolled[:, j0:j1]

    # Downsample by taking the maximum, so a thin bead is never averaged away.
    def shrink(a: np.ndarray, rows: int, cols: int) -> np.ndarray:
        r = max(1, a.shape[0] // rows)
        c = max(1, a.shape[1] // cols)
        h = (a.shape[0] // r) * r
        w = (a.shape[1] // c) * c
        return a[:h, :w].reshape(h // r, r, w // c, c).max(axis=(1, 3))

    grid = shrink(crop, n_times, n_pa)
    pa_axis = ((np.arange(j0, j1) - roll) % PA_BINS) * bin_deg
    step_pa = max(1, (j1 - j0) // n_pa)
    step_t = max(1, (t1 - t0) // n_times)

    return {
        "available": True,
        "is_total": True,
        "contact": contact,
        "contact_t_unix": circ["events"][contact]["t_unix"],
        "t_unix": stamps[t0:t1:step_t][: grid.shape[0]].tolist(),
        "pa_deg": pa_axis[::step_pa][: grid.shape[1]].round(3).tolist(),
        "zenith_offset_deg": round(ref.pa_zenith - ref.pa_north, 3),
        # Arcseconds: positive is visible photosphere.
        "depth_asec": (grid * RAD2ASEC).round(4).tolist(),
        "sun_radius_asec": round(ref.r_sun * RAD2ASEC, 2),
    }


def dem_raster(width: int = 720) -> tuple[bytes, int, int, float, float]:
    """The LOLA shape model downsampled to a browsable grayscale raster.

    Rolled so the left edge is longitude -180 and the centre is longitude 0.
    The source grid starts at longitude 0, which would split the nearside — the
    face actually turned toward Earth — across both edges of the image.
    """
    dem = _dem()
    step = max(1, DEM_COLS // width)
    small = dem[::step, ::step].astype(np.float32) * DEM_SCALE_M / 1000.0 + (
        DEM_OFFSET_M / 1000.0
    )
    small = np.roll(small, small.shape[1] // 2, axis=1)
    lo, hi = float(small.min()), float(small.max())
    scaled = ((small - lo) / max(1e-6, hi - lo) * 255.0).clip(0, 255).astype(np.uint8)
    return scaled.tobytes(), scaled.shape[1], scaled.shape[0], lo, hi


def scene(
    lat: float,
    lon: float,
    elev_m: float,
    contact: str = "c2",
    n: int = 200,
    span_s: float | None = None,
) -> dict:
    """Positions for a 3D reconstruction, in the Moon's body-fixed frame.

    Everything is returned in kilometres with the Moon's centre at the origin and
    its selenographic axes aligned to the world axes, so a renderer can place
    spheres directly and get the eclipse geometry exactly right from any camera
    angle. No angular trigonometry is left for the client to get wrong.
    """
    circ = circumstances(lat, lon, elev_m)
    if not circ["is_total"]:
        return {"available": True, "is_total": False, "note": _no_totality(contact)["note"]}

    t_contact = circ["events"][contact]["t_unix"]
    # Default to the interval where beads actually happen, plus a little air.
    if span_s is None:
        b = beads_cached(lat, lon, elev_m, contact)
        if b.get("phase_start"):
            t0 = b["phase_start"] - 2.0
            t1 = b["phase_end"] + 2.0
        else:
            t0, t1 = t_contact - 6.0, t_contact + 6.0
    else:
        t0, t1 = t_contact - span_s / 2, t_contact + span_s / 2

    ts, _, _, sun, moon = _ephem()
    obs = _observer(lat, lon, elev_m)
    frame = _moon_frame()
    from datetime import datetime, timezone

    stamps = np.linspace(t0, t1, max(2, n))
    obs_xyz, sun_xyz = [], []
    for tu in stamps:
        t = ts.from_datetime(datetime.fromtimestamp(float(tu), tz=timezone.utc))
        R = frame.rotation_at(t)
        m = obs.at(t).observe(moon).apparent()
        s = obs.at(t).observe(sun).apparent()
        # Observer position relative to the Moon's centre, body-fixed.
        o = -(R @ m.position.km)
        # Sun position: out along the apparent direction to it from the observer.
        s_dir = s.position.km / np.linalg.norm(s.position.km)
        sp = o + (R @ s_dir) * float(s.distance().km)
        obs_xyz.append([round(float(v), 3) for v in o])
        sun_xyz.append([round(float(v), 1) for v in sp])

    mid = ts.from_datetime(
        datetime.fromtimestamp(float(stamps[len(stamps) // 2]), tz=timezone.utc)
    )
    g = _geometry(lat, lon, elev_m, mid)
    return {
        "available": True,
        "is_total": True,
        "contact": contact,
        "contact_t_unix": t_contact,
        "t_unix": [round(float(v), 3) for v in stamps],
        "observer_km": obs_xyz,
        "sun_km": sun_xyz,
        "moon_radius_km": R_MOON_KM,
        "sun_radius_km": 695700.0,
        # Sky north and east at the Moon, body-fixed: lets the camera match the
        # orientation used elsewhere in the app.
        "north_dir": [round(float(v), 6) for v in g.n_mf],
        "east_dir": [round(float(v), 6) for v in g.e_mf],
        "sub_lat": round(g.sub_lat, 4),
        "sub_lon": round(g.sub_lon, 4),
        "bead_region": bead_region(lat, lon, elev_m, contact),
        "dem": {
            "rows": DEM_ROWS,
            "cols": DEM_COLS,
            "ppd": DEM_PPD,
            "scale_m": DEM_SCALE_M,
            "offset_m": DEM_OFFSET_M,
        },
    }


def dem_raw16(width: int = 1440) -> tuple[bytes, int, int]:
    """Subsampled DEM as native int16 DN, centred on longitude 0.

    16-bit rather than the 8-bit browsing raster: quantising 20 km of relief into
    256 levels would put 78 m steps into the silhouette, which is the same scale
    as the features that make beads.
    """
    dem = _dem()
    step = max(1, DEM_COLS // width)
    small = np.ascontiguousarray(dem[::step, ::step])
    small = np.roll(small, small.shape[1] // 2, axis=1)
    return small.astype("<i2").tobytes(), small.shape[1], small.shape[0]


def bead_region(lat: float, lon: float, elev_m: float, contact: str) -> dict | None:
    """Selenographic bounds of the limb stretch that produces the beads.

    Used to mesh just that patch at full DEM resolution: the global 3D sphere is
    far coarser than the altimetry, so a close-up of the whole Moon would show a
    smoothed silhouette and invent beads that are not there.
    """
    b = beads_cached(lat, lon, elev_m, contact)
    if not b.get("is_total") or not b.get("beads"):
        return None
    t_contact = b["contact_t_unix"]
    prof = limb_profile(lat, lon, elev_m, t_contact)
    pas = [x["pa_deg"] for x in b["beads"]]

    # Take the profile bins spanning the beads, with margin, and read off which
    # terrain they correspond to.
    lo_pa, hi_pa = min(pas) - 10.0, max(pas) + 10.0
    sel = (prof.pa_deg >= lo_pa) & (prof.pa_deg <= hi_pa)
    if not sel.any():
        return None
    la = prof.sel_lat[sel]
    lo = prof.sel_lon[sel]
    return {
        "lat0": float(max(-90.0, la.min() - 3.0)),
        "lat1": float(min(90.0, la.max() + 3.0)),
        "lon0": float(lo.min() - 3.0),
        "lon1": float(lo.max() + 3.0),
        "pa0": float(lo_pa % 360.0),
        "pa1": float(hi_pa % 360.0),
    }


def dem_patch(
    lat0: float, lat1: float, lon0: float, lon1: float
) -> tuple[bytes, int, int, float, float, float, float]:
    """A crop of the DEM at native 16 pixels/degree, as int16 DN."""
    dem = _dem()
    r0 = int(math.floor((90.0 - lat1) * DEM_PPD))
    r1 = int(math.ceil((90.0 - lat0) * DEM_PPD)) + 1
    r0 = max(0, min(DEM_ROWS - 1, r0))
    r1 = max(r0 + 1, min(DEM_ROWS, r1))
    c0 = int(math.floor(lon0 * DEM_PPD))
    c1 = int(math.ceil(lon1 * DEM_PPD)) + 1
    cols = np.arange(c0, c1) % DEM_COLS
    crop = np.ascontiguousarray(dem[r0:r1][:, cols])
    return (
        crop.astype("<i2").tobytes(),
        crop.shape[1],
        crop.shape[0],
        90.0 - r0 / DEM_PPD,   # lat of the first row
        90.0 - (r1 - 1) / DEM_PPD,  # lat of the last row
        c0 / DEM_PPD,          # lon of the first column
        (c1 - 1) / DEM_PPD,
    )


def flat_limb(
    lat: float,
    lon: float,
    elev_m: float,
    contact: str,
    n_times: int = 240,
) -> dict:
    """The limb rectified: relief against position angle, with the Sun's edge.

    Straightening the limb removes the curvature, so the radial direction can be
    magnified on its own and a 2 km mountain becomes visible next to a 1700 km
    radius. Beads are simply wherever the Sun's edge lies outside the Moon's
    profile — the same condition the bead list uses, drawn instead of tabulated.
    """
    circ = circumstances(lat, lon, elev_m)
    if not circ["is_total"]:
        return {"available": True, "is_total": False, "note": _no_totality(contact)["note"]}

    t_contact = circ["events"][contact]["t_unix"]
    prof = limb_profile(lat, lon, elev_m, t_contact)
    b = beads_cached(lat, lon, elev_m, contact)

    # Sample time across the beads phase, with a little air either side.
    if b.get("phase_start"):
        t0, t1 = b["phase_start"] - 2.5, b["phase_end"] + 2.5
    else:
        t0, t1 = t_contact - 6.0, t_contact + 6.0

    ts, *_ = _ephem()
    obs = _observer(lat, lon, elev_m)
    stamps = np.linspace(t0, t1, n_times)
    east, north, r_sun, r_moon = _sky_offsets(obs, ts, stamps)

    # Sun centre relative to the Moon centre: _sky_offsets gives Moon minus Sun.
    return {
        "available": True,
        "is_total": True,
        "contact": contact,
        "contact_t_unix": t_contact,
        "pa_deg": prof.pa_deg.round(4).tolist(),
        "moon_asec": (prof.theta_rad * RAD2ASEC).round(4).tolist(),
        "sel_lat": prof.sel_lat.round(2).tolist(),
        "sel_lon": prof.sel_lon.round(2).tolist(),
        "mean_asec": round(prof.mean_sphere_rad * RAD2ASEC, 4),
        "t_unix": [round(float(v), 3) for v in stamps],
        "sun_east_asec": (-east * RAD2ASEC).round(4).tolist(),
        "sun_north_asec": (-north * RAD2ASEC).round(4).tolist(),
        "sun_radius_asec": (r_sun * RAD2ASEC).round(4).tolist(),
        "bead_pa": [x["pa_deg"] for x in b.get("beads", [])],
        "phase_start": b.get("phase_start"),
        "phase_end": b.get("phase_end"),
        "km_per_asec": round(prof.distance_km * math.pi / (180 * 3600), 4),
    }
