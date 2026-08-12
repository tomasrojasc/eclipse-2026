"""FastAPI backend for the 12 August 2026 eclipse photo planner."""

from __future__ import annotations

import csv
import io
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from pathlib import Path as _Path

from . import path as path_mod
from . import limb, places, planner, store
from .eclipse import ECLIPSE_DATE, circumstances, frame_at, series, summary

app = FastAPI(title="Eclipse 2026 Planner", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

LAT = Query(..., ge=-90, le=90, description="Latitude, degrees north")
LON = Query(..., ge=-180, le=180, description="Longitude, degrees east")
ELEV = Query(0.0, ge=-500, le=9000, description="Elevation, metres")


@app.on_event("startup")
def _startup() -> None:
    store.init()
    # Warm the ephemeris and the cached shadow path so the first click is fast.
    circumstances(43.36, -8.41)
    path_mod.build()


@app.get("/api/health")
def health() -> dict:
    y, m, d = ECLIPSE_DATE
    return {"ok": True, "eclipse_date": f"{y:04d}-{m:02d}-{d:02d}"}


@app.get("/api/eclipse/circumstances")
def api_circumstances(lat: float = LAT, lon: float = LON, elev_m: float = ELEV):
    """Contact times, sun altitude at each, and visibility caveats."""
    return circumstances(lat, lon, elev_m)


@app.get("/api/eclipse/series")
def api_series(
    lat: float = LAT,
    lon: float = LON,
    elev_m: float = ELEV,
    step_s: float = Query(10.0, ge=1.0, le=120.0),
):
    """Dense frames C1..C4 so the timeline scrubs locally with no round-trips."""
    return series(lat, lon, elev_m, step_s)


@app.get("/api/eclipse/frame")
def api_frame(
    t_unix: float, lat: float = LAT, lon: float = LON, elev_m: float = ELEV
):
    """Exact geometry at one instant — used when a shot time is fine-tuned."""
    return frame_at(lat, lon, elev_m, t_unix).as_dict()


@app.get("/api/eclipse/path")
def api_path():
    """Umbral centreline and north/south limits for the map overlay."""
    return path_mod.build()


# --- site search ------------------------------------------------------------


@app.get("/api/places/search")
def api_places(
    q: str = Query(..., min_length=1, max_length=80),
    limit: int = Query(8, ge=1, le=25),
):
    """Find a town by name, or accept pasted coordinates.

    Runs against a local index, so it is instant and works without a network.
    """
    coords = places.parse_coords(q)
    if coords:
        lat, lon = coords
        return {
            "kind": "coordinates",
            "results": [
                {
                    "name": f"{lat:.4f}°, {lon:.4f}°",
                    "region": "Pasted coordinates",
                    "lat": lat,
                    "lon": lon,
                    "elevation_m": 0,
                    "population": 0,
                }
            ],
        }

    if not places.available():
        raise HTTPException(503, places.BUILD_HINT)
    return {"kind": "places", "results": places.search(q, limit)}


class PointsIn(BaseModel):
    points: list[tuple[float, float]] = Field(..., max_length=25)


@app.post("/api/eclipse/summaries")
def api_summaries(body: PointsIn):
    """Totality verdict for several candidate spots at once."""
    return [
        summary(lat, lon)
        for lat, lon in body.points
        if -90 <= lat <= 90 and -180 <= lon <= 180
    ]


# --- Baily's beads ----------------------------------------------------------


@app.get("/api/eclipse/beads")
def api_beads(
    lat: float = LAT,
    lon: float = LON,
    elev_m: float = ELEV,
    contact: str = Query("c2", pattern="^(c2|c3)$"),
):
    """Individual Baily's beads at second or third contact.

    Computed from LOLA lunar topography and the Moon's libration, so these are
    the actual valleys that will let sunlight through, not a generic guess.
    """
    if not limb.available():
        raise HTTPException(503, limb.SETUP_HINT)
    return limb.beads_cached(lat, lon, elev_m, contact)


@app.get("/api/eclipse/limb")
def api_limb(
    t_unix: float, lat: float = LAT, lon: float = LON, elev_m: float = ELEV
):
    """The Moon's limb profile as seen from here — the jagged edge itself."""
    if not limb.available():
        raise HTTPException(503, limb.SETUP_HINT)
    return limb.profile_for_display(lat, lon, elev_m, t_unix)


@app.get("/api/eclipse/beadmap")
def api_bead_map(
    lat: float = LAT,
    lon: float = LON,
    elev_m: float = ELEV,
    contact: str = Query("c2", pattern="^(c2|c3)$"),
):
    """Position angle versus time: the field the individual beads come from."""
    if not limb.available():
        raise HTTPException(503, limb.SETUP_HINT)
    return limb.bead_map(lat, lon, elev_m, contact)


@app.get("/api/moon/dem")
def api_dem(width: int = Query(720, ge=180, le=1440)):
    """The LOLA shape model as a raw grayscale raster, for the terrain map."""
    if not limb.available():
        raise HTTPException(503, limb.SETUP_HINT)
    data, w, h, lo, hi = limb.dem_raster(width)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "X-Width": str(w),
            "X-Height": str(h),
            "X-Min-Radius-Km": f"{lo:.4f}",
            "X-Max-Radius-Km": f"{hi:.4f}",
            "Access-Control-Expose-Headers":
                "X-Width, X-Height, X-Min-Radius-Km, X-Max-Radius-Km",
            "Cache-Control": "public, max-age=86400",
        },
    )


@app.get("/api/moon/scene")
def api_scene(
    lat: float = LAT,
    lon: float = LON,
    elev_m: float = ELEV,
    contact: str = Query("c2", pattern="^(c2|c3)$"),
    n: int = Query(200, ge=2, le=600),
):
    """Body-fixed positions for the 3D reconstruction of the eclipse."""
    if not limb.available():
        raise HTTPException(503, limb.SETUP_HINT)
    return limb.scene(lat, lon, elev_m, contact, n)


@app.get("/api/moon/dem16")
def api_dem16(width: int = Query(1440, ge=360, le=2880)):
    """Elevation as native int16, for displacing the 3D lunar surface."""
    if not limb.available():
        raise HTTPException(503, limb.SETUP_HINT)
    data, w, h = limb.dem_raw16(width)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "X-Width": str(w),
            "X-Height": str(h),
            "X-Scale-M": str(limb.DEM_SCALE_M),
            "X-Offset-M": str(limb.DEM_OFFSET_M),
            "Access-Control-Expose-Headers":
                "X-Width, X-Height, X-Scale-M, X-Offset-M",
            "Cache-Control": "public, max-age=86400",
        },
    )


@app.get("/api/eclipse/limbflat")
def api_limb_flat(
    lat: float = LAT,
    lon: float = LON,
    elev_m: float = ELEV,
    contact: str = Query("c2", pattern="^(c2|c3)$"),
    n_times: int = Query(240, ge=2, le=600),
):
    """Rectified limb profile plus the Sun's edge, for the flat bead view."""
    if not limb.available():
        raise HTTPException(503, limb.SETUP_HINT)
    return limb.flat_limb(lat, lon, elev_m, contact, n_times)


@app.get("/api/moon/dempatch")
def api_dem_patch(
    lat0: float = Query(..., ge=-90, le=90),
    lat1: float = Query(..., ge=-90, le=90),
    lon0: float = Query(..., ge=-360, le=720),
    lon1: float = Query(..., ge=-360, le=720),
):
    """Native-resolution DEM crop, for meshing the bead region in full detail."""
    if not limb.available():
        raise HTTPException(503, limb.SETUP_HINT)
    if lat1 <= lat0 or lon1 <= lon0:
        raise HTTPException(400, "lat1 must exceed lat0 and lon1 must exceed lon0")
    data, w, h, la1, la0, lo0, lo1 = limb.dem_patch(lat0, lat1, lon0, lon1)
    if w * h > 4_000_000:
        raise HTTPException(413, "Patch too large; narrow the bounds")
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "X-Width": str(w),
            "X-Height": str(h),
            "X-Lat-Top": f"{la1:.6f}",
            "X-Lat-Bottom": f"{la0:.6f}",
            "X-Lon-Left": f"{lo0:.6f}",
            "X-Lon-Right": f"{lo1:.6f}",
            "X-Scale-M": str(limb.DEM_SCALE_M),
            "X-Offset-M": str(limb.DEM_OFFSET_M),
            "Access-Control-Expose-Headers":
                "X-Width, X-Height, X-Lat-Top, X-Lat-Bottom, X-Lon-Left, "
                "X-Lon-Right, X-Scale-M, X-Offset-M",
            "Cache-Control": "public, max-age=86400",
        },
    )


# --- pattern planning -------------------------------------------------------


class PlanRequest(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    elev_m: float = 0.0
    rules: list[dict]


@app.post("/api/plan")
def api_plan(req: PlanRequest):
    """Expand pattern rules into absolute shot times with exposure guidance."""
    return planner.generate(req.lat, req.lon, req.elev_m, req.rules)


@app.get("/api/plan/presets")
def api_presets():
    return planner.PRESETS


# --- saved shots ------------------------------------------------------------
# Every saved row is scoped to the browser that made it, via a header the client
# generates and keeps. A shared deployment must not be one shared shot list.


def _client(x_client_id: str | None) -> str:
    if not x_client_id:
        return store.DEFAULT_CLIENT
    cleaned = "".join(ch for ch in x_client_id if ch.isalnum() or ch in "-_")[:64]
    return cleaned or store.DEFAULT_CLIENT


class ShotIn(BaseModel):
    lat: float
    lon: float
    elev_m: float = 0.0
    t_unix: float
    label: str = ""
    note: str = ""
    payload: dict | None = None


class ShotPatch(BaseModel):
    label: str | None = None
    note: str | None = None
    t_unix: float | None = None


@app.get("/api/shots")
def api_shots(x_client_id: str | None = Header(default=None)):
    return store.list_shots(_client(x_client_id))


@app.post("/api/shots")
def api_add_shot(shot: ShotIn, x_client_id: str | None = Header(default=None)):
    return store.add_shot(
        shot.lat, shot.lon, shot.elev_m, shot.t_unix,
        shot.label, shot.note, shot.payload, _client(x_client_id),
    )


@app.post("/api/shots/bulk")
def api_add_shots(
    shots: list[ShotIn], x_client_id: str | None = Header(default=None)
):
    return store.add_shots(
        [s.model_dump() for s in shots], _client(x_client_id)
    )


@app.patch("/api/shots/{shot_id}")
def api_update_shot(
    shot_id: int, patch: ShotPatch,
    x_client_id: str | None = Header(default=None),
):
    out = store.update_shot(shot_id, _client(x_client_id), **patch.model_dump())
    if out is None:
        raise HTTPException(404, "No shot with that id")
    return out


@app.delete("/api/shots/{shot_id}")
def api_delete_shot(
    shot_id: int, x_client_id: str | None = Header(default=None)
):
    if not store.delete_shot(shot_id, _client(x_client_id)):
        raise HTTPException(404, "No shot with that id")
    return {"deleted": shot_id}


@app.delete("/api/shots")
def api_clear_shots(x_client_id: str | None = Header(default=None)):
    return {"deleted": store.clear_shots(_client(x_client_id))}


@app.get("/api/shots/export.csv")
def api_export_csv(client: str | None = Query(default=None)):
    """A field-ready shot list: local time, UTC, altitude, exposure."""
    rows = store.list_shots(_client(client))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "local_time_CEST", "utc_time", "label", "phase", "obscuration_pct",
        "sun_altitude_deg", "sun_azimuth_deg", "filter", "exposure_start",
        "note", "lat", "lon",
    ])
    for s in rows:
        p = s["payload"] or {}
        exp = p.get("exposure") or {}
        w.writerow([
            _fmt_local(s["t_unix"]),
            datetime.fromtimestamp(s["t_unix"], tz=timezone.utc)
            .strftime("%Y-%m-%d %H:%M:%S"),
            s["label"],
            p.get("phase", ""),
            f"{p.get('obscuration', 0) * 100:.2f}" if p.get("obscuration") is not None else "",
            f"{p.get('sun_alt', ''):.2f}" if isinstance(p.get("sun_alt"), (int, float)) else "",
            f"{p.get('sun_az', ''):.1f}" if isinstance(p.get("sun_az"), (int, float)) else "",
            "ON" if exp.get("filter") else "OFF",
            exp.get("hint", ""),
            s["note"],
            s["lat"], s["lon"],
        ])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition":
                 'attachment; filename="eclipse-2026-shotlist.csv"'},
    )


def _fmt_local(t_unix: float) -> str:
    """Spanish peninsular local time on eclipse day is CEST (UTC+2)."""
    from datetime import timedelta

    tz = timezone(timedelta(hours=2))
    return datetime.fromtimestamp(t_unix, tz=tz).strftime("%Y-%m-%d %H:%M:%S")


# --- saved patterns & sites -------------------------------------------------


class PatternIn(BaseModel):
    name: str
    rules: list[dict]


@app.get("/api/patterns")
def api_patterns(x_client_id: str | None = Header(default=None)):
    return store.list_patterns(_client(x_client_id))


@app.post("/api/patterns")
def api_save_pattern(
    p: PatternIn, x_client_id: str | None = Header(default=None)
):
    return store.save_pattern(p.name, p.rules, _client(x_client_id))


@app.delete("/api/patterns/{pattern_id}")
def api_delete_pattern(
    pattern_id: int, x_client_id: str | None = Header(default=None)
):
    if not store.delete_pattern(pattern_id, _client(x_client_id)):
        raise HTTPException(404, "No pattern with that id")
    return {"deleted": pattern_id}


class SiteIn(BaseModel):
    name: str
    lat: float
    lon: float
    elev_m: float = 0.0


@app.get("/api/sites")
def api_sites():
    return store.list_sites()


@app.post("/api/sites")
def api_save_site(s: SiteIn):
    return store.save_site(s.name, s.lat, s.lon, s.elev_m)


@app.delete("/api/sites/{site_id}")
def api_delete_site(site_id: int):
    if not store.delete_site(site_id):
        raise HTTPException(404, "No site with that id")
    return {"deleted": site_id}


# --- serving the built frontend ---------------------------------------------
# Mounted last so it never shadows an /api route. When the Vite build exists,
# one process serves both the API and the app, which is what makes this
# deployable as a single unit instead of two.

_DIST = _Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

if _DIST.is_dir():
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        """Serve the SPA, falling back to index.html for client-side routes."""
        candidate = (_DIST / full_path).resolve()
        if (
            full_path
            and _DIST in candidate.parents
            and candidate.is_file()
        ):
            return FileResponse(candidate)
        return FileResponse(_DIST / "index.html")
