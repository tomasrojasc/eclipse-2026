"""Lunar limb profile and Baily's bead prediction.

There is no published bead list to check against, so these tests pin the physics
instead: the profile must reproduce the Moon's known limb relief, the silhouette
must come from terrain actually on the limb, the two contacts must involve
opposite lunar limbs, and the limb correction to contact times must land in the
range real eclipse predictions show (a second or two).
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from backend.app import limb as LB
from backend.app.eclipse import R_MOON_KM, circumstances

pytestmark = pytest.mark.skipif(
    not LB.available(),
    reason="lunar data not fetched (uv run python -m backend.scripts.fetch_lunar)",
)

OVIEDO = (43.3619, -5.8494)  # near the centreline
BILBAO = (43.2630, -2.9350)  # near the northern limit
MADRID = (40.4168, -3.7038)  # outside the path entirely


def _t(contact: str, lat: float, lon: float) -> float:
    return circumstances(lat, lon)["events"][contact]["t_unix"]


# --- the DEM ---------------------------------------------------------------


def test_dem_matches_its_label():
    dem = LB._dem()
    assert dem.shape == (LB.DEM_ROWS, LB.DEM_COLS)
    r = dem[::64, ::64].astype(np.float64) * LB.DEM_SCALE_M + LB.DEM_OFFSET_M
    # The Moon's radius spans roughly 1728-1748 km.
    assert 1_725_000 < r.min() < 1_735_000
    assert 1_740_000 < r.max() < 1_752_000


def test_dem_orientation_is_right_way_round():
    """South Pole-Aitken is the Moon's deepest basin and the farside sits high;
    both break if the longitude convention is flipped."""
    dem = LB._dem()

    def radius_km(lat: float, lon: float) -> float:
        row = int(round(1439.5 - lat * LB.DEM_PPD))
        col = int(round(lon * LB.DEM_PPD - 0.5)) % LB.DEM_COLS
        return (dem[row, col] * LB.DEM_SCALE_M + LB.DEM_OFFSET_M) / 1000.0

    assert radius_km(-53, 169) < 1735.0  # SPA basin, deep
    near = np.mean([radius_km(la, lo) for la in (-20, 0, 20) for lo in (340, 0, 20)])
    far = np.mean([radius_km(la, lo) for la in (-20, 0, 20) for lo in (160, 180, 200)])
    assert far - near > 1.0  # farside highlands stand above the nearside maria


# --- the limb profile ------------------------------------------------------


def test_profile_reproduces_known_lunar_limb_relief():
    prof = LB.limb_profile(*OVIEDO, 0.0, _t("c2", *OVIEDO))
    relief = prof.relief_km()
    assert len(relief) == LB.PA_BINS
    # The Moon's limb relief is a couple of km rms, with peaks of several km.
    assert 0.8 < relief.std() < 3.0
    assert -6.0 < relief.min() < -1.0
    assert 2.0 < relief.max() < 9.0


def test_profile_is_continuous_around_the_limb():
    """A jump between neighbouring bins would mean a gap in the search band."""
    prof = LB.limb_profile(*OVIEDO, 0.0, _t("c2", *OVIEDO))
    relief = prof.relief_km()
    step = np.diff(np.concatenate([relief, relief[:1]]))
    assert np.abs(step).max() < 4.0  # km
    assert (prof.theta_rad > 0).all()


def test_silhouette_comes_from_terrain_on_the_limb():
    prof = LB.limb_profile(*OVIEDO, 0.0, _t("c2", *OVIEDO))
    la, lo = np.radians(prof.sel_lat), np.radians(prof.sel_lon)
    la0, lo0 = math.radians(prof.sub_lat), math.radians(prof.sub_lon)
    cos_psi = np.sin(la) * math.sin(la0) + np.cos(la) * math.cos(la0) * np.cos(lo - lo0)
    psi = np.degrees(np.arccos(np.clip(cos_psi, -1, 1)))
    # Everything silhouetted must sit within the search band of the limb.
    assert np.abs(psi - 90.0).max() <= LB.BAND_DEG + 0.5


def test_profile_is_converged_in_the_search_band():
    """The answer must not depend on how far we look either side of the limb."""
    t2 = _t("c2", *OVIEDO)
    original = LB.BAND_DEG
    try:
        LB.BAND_DEG = 5.0
        LB._profile_cached.cache_clear()
        a = LB.limb_profile(*OVIEDO, 0.0, t2).theta_rad.copy()
        LB.BAND_DEG = 8.0
        LB._profile_cached.cache_clear()
        b = LB.limb_profile(*OVIEDO, 0.0, t2).theta_rad.copy()
    finally:
        LB.BAND_DEG = original
        LB._profile_cached.cache_clear()
    assert np.abs(a - b).max() * LB.RAD2ASEC < 0.01  # arcsec


def test_libration_is_physically_plausible():
    prof = LB.limb_profile(*OVIEDO, 0.0, _t("c2", *OVIEDO))
    # Optical libration stays within about 8 degrees either way.
    assert abs(prof.sub_lat) < 8.0
    assert abs(prof.sub_lon) < 9.0
    assert 350_000 < prof.distance_km < 380_000


def test_mean_silhouette_sits_above_the_reference_sphere():
    """Taking the maximum along each line of sight must bias the limb outward;
    a profile centred on the reference sphere would mean the max was lost."""
    prof = LB.limb_profile(*OVIEDO, 0.0, _t("c2", *OVIEDO))
    mean_r = prof.relief_km().mean() + R_MOON_KM
    assert R_MOON_KM < mean_r < R_MOON_KM + 3.0


# --- beads -----------------------------------------------------------------


def test_no_beads_where_there_is_no_totality():
    r = LB.beads(*MADRID, 0.0, "c2")
    assert r["is_total"] is False
    assert r["beads"] == []
    assert "no totality" in r["note"].lower()


@pytest.mark.parametrize("site", [OVIEDO, BILBAO])
@pytest.mark.parametrize("contact", ["c2", "c3"])
def test_beads_are_found_at_both_contacts(site, contact):
    r = LB.beads(*site, 0.0, contact)
    assert r["is_total"]
    assert r["beads"], "no beads resolved"
    assert r["max_simultaneous"] >= 1
    for b in r["beads"]:
        assert b["t_last"] >= b["t_first"]
        assert 0.05 <= b["duration_s"] <= 15.0
        assert 0.0 <= b["pa_deg"] < 360.0
        assert b["width_deg"] <= LB.CRESCENT_MAX_DEG
        assert b["peak_depth_asec"] > 0


def test_beads_bracket_the_contact_they_belong_to():
    """C2 beads precede totality; C3 beads follow it."""
    t2 = _t("c2", *OVIEDO)
    t3 = _t("c3", *OVIEDO)
    c2 = LB.beads(*OVIEDO, 0.0, "c2")
    c3 = LB.beads(*OVIEDO, 0.0, "c3")
    assert all(b["t_first"] < t2 + 1.0 for b in c2["beads"])
    assert all(b["t_last"] > t3 - 3.0 for b in c3["beads"])
    assert c2["phase_end"] <= t3
    assert c3["phase_start"] >= t2


def test_the_two_contacts_use_opposite_lunar_limbs():
    """Second and third contact happen on opposite edges of the Moon, so the
    valleys responsible must sit on opposite selenographic longitudes."""
    c2 = LB.beads(*OVIEDO, 0.0, "c2")
    c3 = LB.beads(*OVIEDO, 0.0, "c3")
    lon2 = np.mean([b["sel_lon"] for b in c2["beads"]])
    lon3 = np.mean([b["sel_lon"] for b in c3["beads"]])
    assert lon2 < -60.0, lon2
    assert lon3 > 60.0, lon3


def test_limb_correction_is_the_size_real_predictions_show():
    for site in (OVIEDO, BILBAO):
        for contact in ("c2", "c3"):
            r = LB.beads(*site, 0.0, contact)
            assert r["limb_correction_s"] is not None
            assert abs(r["limb_correction_s"]) < 6.0


def test_limb_topography_shortens_totality_here():
    """Real limbs eat into totality: ridges cover the Sun before the mean limb
    would, so the corrected duration comes out shorter than the smooth-sphere
    figure at both of these sites."""
    for site in (OVIEDO, BILBAO):
        c = circumstances(*site)
        c2 = LB.beads(*site, 0.0, "c2")
        c3 = LB.beads(*site, 0.0, "c3")
        corrected = c3["true_contact_t_unix"] - c2["true_contact_t_unix"]
        assert corrected < c["totality_seconds"]
        assert corrected > c["totality_seconds"] - 8.0


def test_beads_phase_is_brief_and_inside_the_lit_window():
    r = LB.beads(*OVIEDO, 0.0, "c2")
    assert 0.2 < r["phase_duration_s"] < 12.0
    assert r["phase_start"] <= r["phase_end"]


def test_bead_positions_are_not_duplicated():
    """The tracker used to lose a bead on one flickering frame and rediscover it,
    reporting the same valley several times over."""
    for contact in ("c2", "c3"):
        bs = LB.beads(*OVIEDO, 0.0, contact)["beads"]
        for i, a in enumerate(bs):
            for b in bs[i + 1:]:
                same_place = abs(((a["pa_deg"] - b["pa_deg"] + 180) % 360) - 180) < 1.5
                overlap = (
                    a["t_first"] <= b["t_last"] + LB.COAST_S
                    and b["t_first"] <= a["t_last"] + LB.COAST_S
                )
                assert not (same_place and overlap), (a, b)


def test_display_profile_is_downsampled_consistently():
    d = LB.profile_for_display(*OVIEDO, 0.0, _t("c2", *OVIEDO), points=360)
    assert len(d["pa_deg"]) == len(d["theta_rad"]) == len(d["relief_km"])
    assert 300 <= len(d["pa_deg"]) <= 800
    assert d["pa_deg"][0] < d["pa_deg"][-1]


def test_beads_are_cached_by_rounded_position():
    a = LB.beads_cached(43.36190, -5.84940, 0.0, "c2")
    b = LB.beads_cached(43.36191, -5.84941, 0.0, "c2")
    assert a is b
