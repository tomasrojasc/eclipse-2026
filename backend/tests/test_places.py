"""Site search: index integrity, ranking, and coordinate parsing."""

from __future__ import annotations

import pytest

from backend.app.eclipse import circumstances, summary
from backend.app.places import _places, fold, parse_coords, search

pytestmark = pytest.mark.skipif(
    not __import__("backend.app.places", fromlist=["available"]).available(),
    reason="place index not built (uv run python -m backend.scripts.build_places)",
)


def test_index_is_populated():
    places = _places()
    assert len(places) > 20_000
    assert all({"n", "la", "lo", "k"} <= p.keys() for p in places[:200])


def test_every_place_can_be_found_by_its_own_name():
    """The invariant that actually broke: keys were truncated alphabetically,
    which silently dropped a town's own name when it had many alternates, so
    'oviedo' returned nothing at all."""
    missing = [p["n"] for p in _places() if fold(p["n"]) not in p["k"]]
    assert not missing, f"{len(missing)} places unsearchable by name, e.g. {missing[:5]}"


def first_name(q: str) -> str:
    r = search(q, 5)
    assert r, f"no results for {q!r}"
    return r[0]["name"]


@pytest.mark.parametrize(
    "query,expected",
    [
        ("burgos", "Burgos"),
        ("oviedo", "Oviedo"),
        ("zaragoza", "Zaragoza"),
        ("bilbao", "Bilbao"),
        ("valencia", "Valencia"),
        # Accent-folded.
        ("coruna", "A Coruña"),
        ("a coruna", "A Coruña"),
        ("aviles", "Avilés"),
        # Leading article stripped, as people actually type.
        ("ejido", "El Ejido"),
        # Alternate-language names.
        ("donostia", "Donostia / San Sebastián"),
        ("san sebastian", "Donostia / San Sebastián"),
    ],
)
def test_ranking_puts_the_obvious_answer_first(query, expected):
    assert first_name(query) == expected


def test_big_places_outrank_small_ones_on_a_prefix():
    """Typing 'bar' should offer Barcelona before any Barbate-sized village."""
    names = [r["name"] for r in search("bar", 5)]
    assert "Barcelona" in names[:2]


def test_short_queries_are_ignored():
    assert search("a") == []
    assert search("") == []


def test_results_carry_what_the_app_needs():
    r = search("oviedo", 1)[0]
    assert set(r) == {"name", "region", "lat", "lon", "elevation_m", "population"}
    assert r["region"] == "Asturias"
    assert 43.0 < r["lat"] < 43.7
    assert -6.2 < r["lon"] < -5.5
    assert r["elevation_m"] > 0


@pytest.mark.parametrize(
    "text,expected",
    [
        ("43.36, -5.85", (43.36, -5.85)),
        ("43.36,-5.85", (43.36, -5.85)),
        ("40.4168 -3.7038", (40.4168, -3.7038)),
        ("39.57N 2.65E", (39.57, 2.65)),
        ("39.57 N, 2.65 W", (39.57, -2.65)),
        ("43,36, -5,85", (43.36, -5.85)),  # comma decimals
        ("0, 0", (0.0, 0.0)),
    ],
)
def test_parse_coords_accepts_pasted_pairs(text, expected):
    got = parse_coords(text)
    assert got is not None
    assert got[0] == pytest.approx(expected[0])
    assert got[1] == pytest.approx(expected[1])


@pytest.mark.parametrize(
    "text", ["burgos", "", "99, 200", "120, 0", "one, two", "43.36"]
)
def test_parse_coords_rejects_non_coordinates(text):
    assert parse_coords(text) is None


def test_summary_agrees_with_full_circumstances():
    """Tolerances allow for summary() caching on coordinates rounded to ~100 m,
    which shifts totality by well under a second and never flips the verdict."""
    for lat, lon in [(43.3619, -5.8494), (40.4168, -3.7038), (39.5696, 2.6502)]:
        s = summary(lat, lon)
        c = circumstances(lat, lon)
        assert s["is_total"] is c["is_total"]
        assert s["max_obscuration"] == pytest.approx(c["max_obscuration"], abs=1e-4)
        if c["is_total"]:
            assert s["totality_seconds"] == pytest.approx(
                c["totality_seconds"], abs=0.5
            )


def test_summary_is_cached_by_rounded_coordinates():
    """Two spots 1 m apart must not each pay for a full computation."""
    a = summary(43.36190, -5.84940)
    b = summary(43.36191, -5.84941)
    assert a["max_t_unix"] == b["max_t_unix"]
