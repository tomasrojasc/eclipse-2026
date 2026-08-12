"""Correctness checks for the eclipse engine.

The contact times are checked against independently published local
circumstances for the 12 August 2026 eclipse (IGN / BBC Sky at Night figures
for Spanish cities). Tolerances are loose enough to absorb the difference
between "the city" and whatever exact point a publisher used, but tight enough
to catch a real regression in the geometry.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.eclipse import circumstances, frame_at, series
from backend.app.path import build as build_path

CEST = timezone(timedelta(hours=2))


def local_hhmm(t_unix: float) -> str:
    return datetime.fromtimestamp(t_unix, tz=CEST).strftime("%H:%M")


# name, lat, lon, expect_total
CITIES = [
    ("A Coruña", 43.3623, -8.4115, True),
    ("Oviedo", 43.3619, -5.8494, True),
    ("Bilbao", 43.2630, -2.9350, True),
    ("Burgos", 42.3439, -3.6969, True),
    ("Zaragoza", 41.6488, -0.8891, True),
    ("Valencia", 39.4699, -0.3763, True),
    ("Palma", 39.5696, 2.6502, True),
    ("Madrid", 40.4168, -3.7038, False),
    ("Barcelona", 41.3874, 2.1686, False),
]


@pytest.mark.parametrize("name,lat,lon,expect_total", CITIES)
def test_totality_matches_published_path(name, lat, lon, expect_total):
    """Madrid and Barcelona famously fall just outside the path; the rest are in."""
    c = circumstances(lat, lon)
    assert c["has_eclipse"], name
    assert c["is_total"] is expect_total, (
        f"{name}: is_total={c['is_total']}, expected {expect_total} "
        f"(peak coverage {c['max_obscuration'] * 100:.2f}%)"
    )


def test_a_coruna_against_published_times():
    """Published: partial from 19:31, max 20:28 CEST, Sun ~12°, totality ~76 s."""
    c = circumstances(43.3623, -8.4115)
    assert local_hhmm(c["events"]["c1"]["t_unix"]) == "19:31"
    assert local_hhmm(c["events"]["max"]["t_unix"]) == "20:28"
    assert c["max"]["sun_alt"] == pytest.approx(12.0, abs=1.0)
    assert c["totality_seconds"] == pytest.approx(76, abs=8)


def test_greatest_eclipse_is_near_totality_midpoint():
    c = circumstances(41.6488, -0.8891)
    mid = (c["events"]["c2"]["t_unix"] + c["events"]["c3"]["t_unix"]) / 2
    assert abs(c["events"]["max"]["t_unix"] - mid) < 1.0


def test_contacts_are_ordered_and_bracket_totality():
    c = circumstances(43.3619, -5.8494)
    ev = c["events"]
    ts = [ev[k]["t_unix"] for k in ("c1", "c2", "max", "c3", "c4")]
    assert ts == sorted(ts)
    # Outside totality the disc is not fully covered; inside, it is.
    assert ev["c1"]["obscuration"] == pytest.approx(0.0, abs=1e-6)
    assert ev["c4"]["obscuration"] == pytest.approx(0.0, abs=1e-6)
    assert ev["max"]["obscuration"] == pytest.approx(1.0, abs=1e-9)


def test_madrid_is_a_near_miss_not_a_total():
    """Madrid reaches ~99.9% — the app must not round this up to a total."""
    c = circumstances(40.4168, -3.7038)
    assert not c["is_total"]
    assert 0.995 < c["max_obscuration"] < 1.0
    assert c["max_magnitude"] < 1.0


def test_obscuration_is_monotonic_either_side_of_maximum():
    d = series(41.6488, -0.8891, 0.0, step_s=20.0)
    frames = d["frames"]
    t_max = d["circumstances"]["max"]["t_unix"]
    rising = [f["obscuration"] for f in frames if f["t_unix"] <= t_max]
    falling = [f["obscuration"] for f in frames if f["t_unix"] >= t_max]
    # Allow a hair of numerical noise while the disc is fully covered.
    assert all(b - a > -1e-9 for a, b in zip(rising, rising[1:]))
    assert all(a - b > -1e-9 for a, b in zip(falling, falling[1:]))


def test_series_frames_carry_everything_the_renderer_needs():
    d = series(43.3619, -5.8494, 0.0, step_s=30.0)
    assert d["frames"], "no frames returned"
    needed = {
        "t_unix", "sep", "r_sun", "r_moon", "phase", "obscuration",
        "magnitude", "sun_alt", "sun_alt_geometric", "sun_az", "dx", "dy",
        "pa_zenith", "pa_north",
    }
    for f in d["frames"]:
        missing = needed - f.keys()
        assert not missing, f"frame missing {missing}"
    assert any(f["phase"] == "total" for f in d["frames"])


def test_series_offsets_agree_with_separation():
    """dx/dy are the zenith-frame decomposition of sep; they must be consistent."""
    d = series(41.6488, -0.8891, 0.0, step_s=30.0)
    for f in d["frames"][::7]:
        assert math.hypot(f["dx"], f["dy"]) == pytest.approx(f["sep"], rel=1e-6)


def test_spain_sees_this_eclipse_with_the_sun_very_low():
    """The defining constraint for photographers: it happens near sunset."""
    for _, lat, lon, is_total in CITIES:
        if not is_total:
            continue
        c = circumstances(lat, lon)
        assert 0 < c["max"]["sun_alt"] < 15, (lat, lon, c["max"]["sun_alt"])


def test_sun_is_below_horizon_at_last_contact_in_the_east():
    """At Zaragoza the eclipse is still running when the Sun sets."""
    c = circumstances(41.6488, -0.8891)
    assert c["events"]["c4"]["sun_alt_geometric"] < 0
    assert any("below the horizon" in n for n in c["notes"])


def test_frame_at_matches_the_series_sample():
    d = series(43.3619, -5.8494, 0.0, step_s=30.0)
    sample = d["frames"][len(d["frames"]) // 2]
    f = frame_at(43.3619, -5.8494, 0.0, sample["t_unix"])
    assert f.obscuration == pytest.approx(sample["obscuration"], abs=1e-9)
    assert f.sun_alt == pytest.approx(sample["sun_alt"], abs=1e-9)
    assert f.phase == sample["phase"]


def test_no_eclipse_far_from_the_path():
    """Well south of the track the Sun is untouched (and this must not crash)."""
    c = circumstances(-33.45, -70.67)  # Santiago de Chile
    assert c["has_eclipse"] is False
    assert c["events"] == {}


# --- the drawn path ---------------------------------------------------------


def _point_in_ring(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) / (y2 - y1) * (x2 - x1):
            inside = not inside
    return inside


@pytest.mark.parametrize(
    "name,lat,lon,expect_in",
    [
        ("A Coruña", 43.36, -8.41, True),
        ("Oviedo", 43.36, -5.85, True),
        ("Zaragoza", 41.65, -0.89, True),
        ("Valencia", 39.47, -0.38, True),
        ("Palma", 39.57, 2.65, True),
        ("Ibiza", 38.91, 1.43, True),
        ("Madrid", 40.42, -3.70, False),
        ("Barcelona", 41.39, 2.17, False),
        ("Lisbon", 38.72, -9.14, False),
        ("Sevilla", 37.39, -6.00, False),
        ("Toulouse", 43.60, 1.44, False),
    ],
)
def test_drawn_band_agrees_with_the_engine(name, lat, lon, expect_in):
    """The band on the map must not disagree with the computed circumstances."""
    p = build_path()
    ring = [(q["lon"], q["lat"]) for q in p["limits"]["north"]]
    ring += [(q["lon"], q["lat"]) for q in reversed(p["limits"]["south"])]
    assert _point_in_ring(lon, lat, ring) is expect_in, name


def test_centerline_crosses_spain_west_to_east():
    p = build_path()
    pts = p["centerline_iberia"]
    assert len(pts) > 20
    assert pts[0]["lon"] < pts[-1]["lon"], "track should run west to east"
    assert pts[0]["lat"] > pts[-1]["lat"], "and drift south"
