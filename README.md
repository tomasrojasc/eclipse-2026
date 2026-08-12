---
title: Eclipse 2026 Planner
emoji: 🌒
colorFrom: indigo
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
short_description: Plan eclipse photography for the 12 Aug 2026 totality in Spain
---

# Ephemeris — eclipse photo planner for Spain, 12 August 2026

Pick a spot on the map, scrub through the eclipse, and build a shot pattern that
tells you the exact clock time for every frame you want to take.

The eclipse this plans for is the **total solar eclipse of 12 August 2026**,
whose path of totality crosses Spain from Galicia to the Balearics. Spain sits at
the *sunset end* of the track, so totality happens with the Sun only 2–12° above
the horizon. That single fact drives most of the app: every shot carries a Sun
altitude, and anything at or below the horizon is flagged rather than quietly
listed.

## Running it

Two processes. Backend first:

```bash
uv run uvicorn backend.app.main:app --reload --port 8000
```

Fetch the two data sets once:

```bash
uv run python -m backend.scripts.build_places   # town index, ~3 MB
uv run python -m backend.scripts.fetch_lunar    # lunar limb data, ~35 MB
```

Then the frontend:

```bash
cd frontend
npm install     # first time only
npm run dev
```

Open http://localhost:5173. Vite proxies `/api` to port 8000, so no CORS setup
is needed for local use.

The first backend start downloads the JPL DE421 ephemeris (~17 MB) into
`backend/ephem/` and computes the umbral path into `backend/app/path_2026.json`.
Both are cached, so later starts are immediate.

Or use the launcher, which starts both and waits for the API to answer:

```bash
./run.sh
```

## What it does

**Finding a site.** Type a town name — accents and leading articles are
optional, so "coruna" finds A Coruña and "ejido" finds El Ejido, and Basque,
Catalan and Galician names resolve too ("donostia" → Donostia / San Sebastián).
Each result is annotated with what the eclipse actually does there: *67 s
totality* for Santander, *99.98% partial* for Santiago de Compostela. That
distinction is the whole game, and it is invisible in an ordinary place list.

You can also paste coordinates straight from a maps app — `43.36, -5.85`,
`39.57N 2.65E` — and selecting a town fills in its elevation for you.

Search runs against a local index of all 30,895 populated places in Spain, so it
is instant, needs no API key, and still works with no signal in the field.

**Map.** Click anywhere or drag the pin. The violet band is where totality is
visible, computed by bisecting perpendicular to the shadow track; the dashed line
is the centreline, where totality lasts longest. Madrid and Barcelona fall just
outside it — by 0.02% and 0.15% of coverage respectively, which the app reports
precisely rather than rounding to "total".

**Timeline.** Scrub from first to last contact. The whole eclipse for your site
is fetched once (frames every 10 s, and every 1 s through totality), so dragging
is instant. Playback runs in eclipse-time at 1× to 300×. The C1/C2/MAX/C3/C4
buttons jump to each contact.

**Sky view.** The Sun and Moon drawn to true relative angular size, with the sky
darkening and reddening as coverage grows and the Sun sinks. Corona and
chromosphere appear during totality; the diamond ring appears in the seconds
either side of it. *Zenith up* matches a horizon-levelled camera; *North up*
matches an equatorial mount. Beside it, the gauge shows the Sun's altitude
against the terrain, with totality marked on its track.

**Baily's beads.** The beads are not a generic flourish — they are computed from
the Moon's actual shape. The app builds a limb profile from LOLA laser altimetry
for the Moon's libration at your contact time, then slides that jagged limb
across the Sun's edge to find where and when photosphere still shows. For each
bead you get the time it lights up, how long it lasts, its position angle and
clock position in a horizon-levelled frame, and the selenographic coordinates of
the lunar valley responsible.

It also reports the **limb correction**: real topography shifts second and third
contact by a second or two from the smooth-sphere prediction, which shortens
totality. At Oviedo that is −0.40 s at C2 and −1.75 s at C3; at Bilbao, near the
northern limit, it is +2.30 s and −2.25 s, cutting totality from 37.9 s to 33.3 s.
If you are near the edge of the path, this is the difference that matters.

The limb chart draws the profile with its relief exaggerated about 40×; at true
scale the entire range is 0.25% of the Moon's radius. Beads glow at their real
position angles, and the timeline samples the contacts at 0.1 s so you can
actually scrub onto an individual bead.

Resolution honesty: the LOLA grid used is 16 pixels/degree, ~1.9 km at the limb
or ~1.1 arcsecond from Earth. That resolves the valleys producing the prominent
beads, but not the finest structure. Treat timings as good to roughly a second,
expect the faintest beads to be missed, and do not plan a video frame around
them.

**Limb data tab.** The bead prediction is not a black box — the second tab walks
the data from source to result:

1. **The Moon's measured shape** — the LOLA raster as a browsable map. The pale
   line is the limb as seen from your site, the orange cross is the centre of the
   face turned toward you, and amber blooms mark the valleys producing your
   beads. Hover anywhere to read the measured lunar radius.
2. **The limb profile from your site** — the Moon's edge unrolled: relief in km
   against position angle, with zero being a perfect 1737.4 km sphere. Shaded
   bands show the stretches of limb that C2 and C3 actually use, which are on
   opposite sides. Hover to read the relief and the selenographic position.
3. **Visible photosphere, angle versus time** — the field the bead list is picked
   out of. Each bright streak is one valley letting light through; vertical
   position is its place on the limb, horizontal extent is how long it lasts.
   You can watch the crescent narrow to a band and shatter into separate
   streaks — that break-up *is* Baily's beads. The dashed line is contact for a
   smooth Moon, and the real light ends before it, which is the limb correction
   made visible.

A fourth panel lists exactly where every data set comes from.

**3D tab.** The eclipse reconstructed in three dimensions from the same data. The
Moon is a sphere displaced by LOLA altimetry, the Sun is a sphere at its true
distance and radius, and the camera starts exactly where you will be standing.
The backend hands over observer and Sun positions in the Moon's body-fixed frame
in kilometres, so the renderer only places objects — the eclipse geometry is not
reconstructed client-side, and the beads emerge from the silhouette on their own.

Drag to orbit, scroll to change distance, **My view** snaps back to your site.
The lens slider changes field of view only, and reports the focal length that
would frame what you see — from about 500 mm for the whole disc to 27,500 mm for
the close-up.

**Beads close-up** aims at the stretch of limb where your beads break through and
zooms to 0.05°. This is necessary rather than decorative: a 1-arcsecond bead is
less than a pixel when the whole disc is in frame. In that mode the limb is meshed
at *native DEM resolution* (one vertex per LOLA pixel) — the global sphere is
meshed at 1024×512, about 10.6 km per vertex, which is coarser than the altimetry
and would show a smoothed edge and invent beads that are not there. The global
sphere is sunk half a kilometre so the high-resolution patch alone defines the
silhouette; the disc interior is unlit at totality, so that shift is invisible.

Scrub through the window and you can watch the sunlight thread go from continuous
to broken — at Oviedo it is unbroken at 20:27:00.5 and split into segments one
second later. That is the crescent becoming Baily's beads, arrived at by pure 3D
occlusion, independently of the algorithm used on the other tabs, and the two
agree on when it happens.

The Moon looks black from your side because it is: at totality you are looking at
the new Moon's unlit face, lit only by earthshine (there is a slider for it).
Orbit around and the sunlit far side comes into view. Relief exaggeration up to
×40 makes the valleys legible, but it changes the silhouette — the bead *times*
elsewhere in the app always come from the unexaggerated shape.

**Shot patterns.** Build a pattern from four rule types, mix as many as you like:

| Rule | What it generates |
| --- | --- |
| Coverage steps | Shots at exact obscuration percentages, waxing and/or waning — for evenly spaced composites |
| Offsets from a contact | Shots at ± seconds from C1/C2/MAX/C3/C4 — for diamond rings and beads |
| Fixed cadence | Every *N* seconds between two contacts — for time-lapses |
| Spread across totality | *N* frames evenly across totality — for an HDR corona stack |

Every generated shot gets its exact local and UTC time, coverage, Sun altitude
and azimuth, and a starting exposure with an explicit **FILTER / NO FILTER**
flag. Filter state is decided by proximity to totality, not by phase, because the
diamond ring happens while the eclipse is still technically partial — following
the phase there would tell you to shoot it through an ND5 filter and you would
get nothing.

Rules that cannot be satisfied are reported, not dropped: ask for 100% coverage
in Madrid, or a C2 offset outside the path, and it says so.

Save patterns by name to reuse them at another site. Three presets are built in.

**Shot list.** The sidebar persists to SQLite, survives restarts, and exports a
field-ready CSV. Each row is annotated with a note field, shows how far off it is
from now, and is clickable to scrub the timeline to that instant.

Exposure values are starting points to bracket around, not gospel — they assume
ISO 200, f/8 as a reference. The very low Sun means extra atmospheric extinction,
so expect to need more light than a high-altitude eclipse would want.

## Tests

```bash
uv run pytest                    # 84 astronomy, path, search and limb tests
cd frontend && npm run test:e2e  # 36 browser interaction checks (needs both servers up)
```

The backend tests check contact times against independently published local
circumstances (A Coruña: partial from 19:31, maximum 20:28 CEST, Sun ~12°,
totality ~76 s), confirm Madrid and Barcelona are *not* total, and assert the
drawn band never disagrees with the computed circumstances for 11 cities. One
test asserts every place in the index is findable by its own name — an earlier
version truncated each town's search keys alphabetically, which silently made
"oviedo" return nothing at all.

The bead tests pin physics rather than a published answer, since no bead list
exists to check against: the profile must reproduce the Moon's known limb relief
(1-2 km rms), be continuous around the limb, come from terrain genuinely on the
limb, be converged with respect to the search band, and put second and third
contact on opposite selenographic longitudes. The limb correction is asserted to
land in the range real eclipse predictions show.

## How the numbers are produced

`backend/app/eclipse.py` computes topocentric apparent positions of the Sun and
Moon from the DE421 ephemeris via Skyfield, then finds contacts by bisecting the
angular separation against the sum (C1/C4) and difference (C2/C3) of the apparent
semidiameters, refining to 5 ms. Greatest eclipse is a golden-section minimum of
the separation. This is the method NASA documents for local circumstances.

`backend/app/path.py` gets the centreline by intersecting the Sun→Moon shadow
axis with the WGS84 ellipsoid, then finds the northern and southern limits by
bisecting perpendicular to the track on "does totality occur here at all". The
centreline is resampled to uniform *spatial* spacing first, because near sunset
the shadow crosses the ground fast enough that uniform time sampling would let
the drawn band cut a corner across Mallorca.

`backend/app/limb.py` builds the lunar limb profile. It puts the observer in the
Moon-fixed frame via NAIF's lunar orientation kernels, which is what carries the
physical libration, then for each position angle takes the maximum apparent
angular radius over the LOLA terrain near the tangent line — the limb you see is
the silhouette of the highest ground along each line of sight, not the elevation
at one point. The search band either side of the limb was widened until the
profile stopped changing.

Town coordinates and elevations come from the GeoNames Spain dump (CC BY 4.0).
Lunar topography is LRO LOLA LDEM_16 (NASA PDS); lunar orientation is NAIF
`moon_pa_de421`.

Altitudes are given both refracted (what you will see and photograph, and what
the app displays) and geometric (used to decide whether the Sun is genuinely
above the horizon).

Accuracy is good to roughly a second for contact times, which is well inside the
uncertainty that matters in the field — local terrain and your exact position
along the limb affect beads timing more than the ephemeris does. Do not use it
for scientific limb-profile work.

## Layout

```
backend/app/eclipse.py   contacts, per-instant frames, dense series, summaries
backend/app/places.py    offline town search + coordinate parsing
backend/app/limb.py      lunar limb profile, bead prediction, 3D scene geometry
backend/scripts/         one-off builder for the town index
backend/app/path.py      umbral centreline + north/south limits (cached)
backend/app/planner.py   pattern rules -> absolute shot times + exposures
backend/app/store.py     SQLite: shots, patterns, sites
backend/app/main.py      FastAPI routes
frontend/src/components/ SkyView, MapPanel, SiteSearch, Timeline, BeadsPanel,
                         DataExplorer, MoonGlobe, PatternBuilder, ShotSidebar
```
