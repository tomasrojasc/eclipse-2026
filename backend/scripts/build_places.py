"""Build the offline town index used by site search.

Source: the GeoNames Spain dump (CC BY 4.0). Run this once:

    uv run python -m backend.scripts.build_places

It writes backend/data/places_es.json — every populated place in Spain with its
coordinates, elevation and searchable name variants. Keeping this local means
site search is instant, needs no API key, and still works from a hillside with
no signal, which is where this app actually gets used.
"""

from __future__ import annotations

import io
import json
import sys
import unicodedata
import urllib.request
import zipfile
from pathlib import Path

DUMP_URL = "https://download.geonames.org/export/dump/ES.zip"
ADMIN1_URL = "https://download.geonames.org/export/dump/admin1CodesASCII.txt"
OUT = Path(__file__).resolve().parent.parent / "data" / "places_es.json"

UA = {"User-Agent": "eclipse-2026-planner/1.0 (offline place index builder)"}

# Rank capitals and administrative seats above ordinary villages of equal size.
FEATURE_RANK = {
    "PPLC": 4,   # national capital
    "PPLA": 3,   # first-order admin capital (province)
    "PPLA2": 2,
    "PPLA3": 1,
    "PPLA4": 1,
}


def fold(s: str) -> str:
    """Lowercase and strip accents, so 'Coruna' finds 'A Coruña'."""
    nfkd = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


#: Spanish, Galician, Catalan and Basque leading articles. People search for
#: "Coruña" and "Ejido", not "A Coruña" and "El Ejido".
_ARTICLES = ("a ", "o ", "as ", "os ", "el ", "la ", "los ", "las ", "es ",
             "sa ", "l'", "s'")


def _without_article(k: str) -> tuple[str, ...]:
    for art in _ARTICLES:
        if k.startswith(art) and len(k) > len(art) + 2:
            return (k[len(art):],)
    return ()


def latin_ish(s: str) -> bool:
    """Keep Latin-script variants (Donostia, Girona); drop Cyrillic/CJK/etc."""
    return bool(s) and all(ord(c) < 0x250 for c in s)


def main() -> int:
    print(f"fetching {ADMIN1_URL} …")
    regions: dict[str, str] = {}
    for line in _get(ADMIN1_URL).decode("utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[0].startswith("ES."):
            regions[parts[0].split(".", 1)[1]] = parts[1]
    print(f"  {len(regions)} regions")

    print(f"fetching {DUMP_URL} …")
    blob = _get(DUMP_URL)
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        raw = z.read("ES.txt").decode("utf-8")
    print(f"  {len(raw) / 1e6:.1f} MB")

    places = []
    for line in raw.splitlines():
        f = line.split("\t")
        if len(f) < 19 or f[6] != "P":
            continue
        name = f[1]
        lat, lon = float(f[4]), float(f[5])
        admin1 = f[10]
        population = int(f[14] or 0)
        # Prefer the surveyed elevation, fall back to the DEM value.
        elev = int(f[15]) if f[15] else (int(f[16]) if f[16] else 0)

        # Searchable variants, in priority order: the place's own name first,
        # then its ASCII form, then Latin-script alternates so Basque, Catalan
        # and Galician spellings resolve too (Donostia -> San Sebastián).
        # Order matters — truncating this list alphabetically would drop the
        # town's own name whenever it has many alternates.
        variants: list[str] = [name, f[2]]
        for alt in (f[3] or "").split(","):
            alt = alt.strip()
            if latin_ish(alt) and 2 < len(alt) <= 40:
                variants.append(alt)

        keys: list[str] = []
        for v in variants:
            for k in (fold(v), *_without_article(fold(v))):
                if k and k not in keys:
                    keys.append(k)
            if len(keys) >= 10:
                break
        keys = keys[:10]

        places.append(
            {
                "n": name,
                "r": regions.get(admin1, ""),
                "la": round(lat, 5),
                "lo": round(lon, 5),
                "e": elev,
                "p": population,
                "k": keys,
                "f": FEATURE_RANK.get(f[7], 0),
            }
        )

    # Biggest first: a prefix search for "bar" should surface Barcelona.
    places.sort(key=lambda p: (-p["p"], p["n"]))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps({"source": "GeoNames (CC BY 4.0)", "places": places},
                   ensure_ascii=False, separators=(",", ":"))
    )
    mb = OUT.stat().st_size / 1e6
    print(f"wrote {OUT} — {len(places)} places, {mb:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
