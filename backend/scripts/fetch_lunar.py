"""Fetch the data needed to predict Baily's beads.

    uv run python -m backend.scripts.fetch_lunar

Two things are needed beyond the solar-system ephemeris:

  * LOLA LDEM_16 (33 MB) — the Moon's shape, 16 pixels/degree. This is what
    makes bead prediction possible at all: beads are sunlight through lunar
    valleys, so you cannot get them from a smooth sphere.
  * NAIF lunar orientation kernels (~1.8 MB) — the Moon's physical libration,
    which decides *which* terrain is on the limb for a given observer.
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
EPHEM = ROOT / "ephem"

LOLA = (
    "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/"
    "data/lola_gdr/cylindrical/img/ldem_16.img"
)
NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels"
KERNELS = [
    (f"{NAIF}/fk/satellites/moon_080317.tf", EPHEM / "moon_080317.tf"),
    (f"{NAIF}/pck/pck00011.tpc", EPHEM / "pck00011.tpc"),
    (
        f"{NAIF}/pck/moon_pa_de421_1900-2050.bpc",
        EPHEM / "moon_pa_de421_1900-2050.bpc",
    ),
]

UA = {"User-Agent": "eclipse-2026-planner/1.0 (lunar limb data fetcher)"}


def fetch(url: str, dest: Path, min_bytes: int = 1024) -> None:
    if dest.exists() and dest.stat().st_size >= min_bytes:
        print(f"  have {dest.name} ({dest.stat().st_size / 1e6:.1f} MB)")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  fetching {dest.name} …", end="", flush=True)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=600) as r, open(dest, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    size = dest.stat().st_size
    if size < min_bytes:
        dest.unlink()
        raise RuntimeError(f"{dest.name} came back too small ({size} bytes)")
    print(f" {size / 1e6:.1f} MB")


def main() -> int:
    print("lunar orientation kernels:")
    for url, dest in KERNELS:
        fetch(url, dest, min_bytes=2048)
    print("LOLA lunar shape model:")
    fetch(LOLA, DATA / "ldem_16.img", min_bytes=33_000_000)

    # Prove the pieces actually work together before declaring success.
    print("verifying …")
    sys.path.insert(0, str(ROOT.parent))
    from backend.app.eclipse import circumstances
    from backend.app.limb import limb_profile, _moon_frame

    _moon_frame()
    # Verify at the real moment of second contact, so the libration reported
    # here is the one that actually matters for beads.
    lat, lon = 43.3619, -5.8494  # Oviedo, near the centreline
    t2 = circumstances(lat, lon)["events"]["c2"]["t_unix"]
    prof = limb_profile(lat, lon, 0.0, t2)
    relief = prof.relief_km()
    print(
        f"  limb profile ok: libration lat {prof.sub_lat:+.2f}° "
        f"lon {prof.sub_lon:+.2f}°, relief {relief.min():+.2f} .. "
        f"{relief.max():+.2f} km (rms {relief.std():.2f})"
    )
    if not (0.5 < relief.std() < 4.0):
        print("  WARNING: limb relief looks wrong; expected roughly 1-2 km rms")
        return 1
    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
