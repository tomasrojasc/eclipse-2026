"""Turn a user-defined shot pattern into concrete, absolute capture times."""

from __future__ import annotations

import math
from typing import Any

from .eclipse import _build_frame, _ephem, _observer, circumstances, frame_at

ANCHORS = ("c1", "c2", "max", "c3", "c4")

# Starting points only — real exposures depend on your optics, filter density
# and the sky. Bracket generously; these are the values to bracket *around*.
# Based on standard eclipse-photography practice (ISO 200, f/8 reference).
EXPOSURE_HINTS = [
    # (max_obscuration_for_rule, phase, label, hint)
    ("filtered", "Partial phase, solar filter ON",
     "ISO 100, f/8, ~1/125 s through an ND5 (visual-density 5.0) solar filter."),
    ("beads", "Baily's beads / diamond ring, filter OFF",
     "ISO 200, f/8, ~1/2000 s. Remove the filter only seconds before C2."),
    ("chromo", "Chromosphere & prominences",
     "ISO 200, f/8, ~1/1000 s."),
    ("inner", "Inner corona",
     "ISO 200, f/8, ~1/250 s."),
    ("mid", "Middle corona",
     "ISO 200, f/8, ~1/60 s."),
    ("outer", "Outer corona & earthshine",
     "ISO 200, f/8, ~1/8 s to 1 s — use a tripod and a remote release."),
]


#: How long before C2 / after C3 the solar filter must already be off. The
#: diamond ring happens while the eclipse is still technically partial, so
#: filter state cannot be decided from the phase alone.
FILTER_OFF_WINDOW_S = 20.0


def _exposure_for(phase: str, t_unix: float, t2: float | None,
                  t3: float | None) -> dict:
    """Pick a sensible starting exposure and filter state for one moment."""
    # Distance to the nearest totality boundary, whichever side we are on.
    edges = [abs(t_unix - t) for t in (t2, t3) if t is not None]
    edge = min(edges) if edges else None

    if phase in ("none", "partial"):
        if edge is not None and edge <= FILTER_OFF_WINDOW_S:
            # Diamond ring / beads: filter is already off, shooting unfiltered.
            return {"target": EXPOSURE_HINTS[1][1], "hint": EXPOSURE_HINTS[1][2],
                    "filter": False}
        return {"target": EXPOSURE_HINTS[0][1], "hint": EXPOSURE_HINTS[0][2],
                "filter": True}

    # Inside totality: distance from the nearest edge decides the target.
    if edge is None:
        i = 4
    elif edge <= 3:
        i = 1
    elif edge <= 8:
        i = 2
    elif edge <= 20:
        i = 3
    elif edge <= 45:
        i = 4
    else:
        i = 5
    return {"target": EXPOSURE_HINTS[i][1], "hint": EXPOSURE_HINTS[i][2],
            "filter": False}


def _obscuration_at(obs, ts, t_unix: float) -> float:
    from datetime import datetime, timezone

    t = ts.from_datetime(datetime.fromtimestamp(t_unix, tz=timezone.utc))
    return _build_frame(obs, t, t_unix).obscuration


def _time_for_obscuration(
    obs, ts, target: float, t_lo: float, t_hi: float
) -> float | None:
    """Bisect for the instant obscuration crosses `target` on [t_lo, t_hi]."""
    f_lo = _obscuration_at(obs, ts, t_lo) - target
    f_hi = _obscuration_at(obs, ts, t_hi) - target
    if (f_lo < 0) == (f_hi < 0):
        return None  # target never reached on this branch
    for _ in range(34):
        mid = (t_lo + t_hi) / 2
        f_mid = _obscuration_at(obs, ts, mid) - target
        if (f_lo < 0) == (f_mid < 0):
            t_lo, f_lo = mid, f_mid
        else:
            t_hi = mid
        if t_hi - t_lo < 0.05:
            break
    return (t_lo + t_hi) / 2


def generate(lat: float, lon: float, elev_m: float, rules: list[dict]) -> dict:
    """Expand pattern rules into shots. Unsatisfiable rules are reported, not
    silently dropped, so you never think a shot is planned when it is not."""
    circ = circumstances(lat, lon, elev_m)
    if not circ["has_eclipse"]:
        return {"circumstances": circ, "shots": [], "warnings":
                ["No eclipse at this location, so no shots can be planned."]}

    ts, *_ = _ephem()
    obs = _observer(lat, lon, elev_m)
    ev = circ["events"]
    warnings: list[str] = []
    raw: list[tuple[float, str, str]] = []  # (t_unix, label, rule_id)

    def anchor_t(name: str) -> float | None:
        f = ev.get(name)
        return f["t_unix"] if f else None

    for ri, rule in enumerate(rules):
        rid = rule.get("id") or f"rule{ri}"
        kind = rule.get("kind")

        if kind == "anchor_offsets":
            a = rule.get("anchor", "max")
            at = anchor_t(a)
            if at is None:
                warnings.append(
                    f"'{rule.get('label', rid)}': anchor {a.upper()} does not "
                    "exist here (no totality at this location)."
                )
                continue
            for off in rule.get("offsets_s", [0]):
                sign = "+" if off >= 0 else "-"
                raw.append((at + off,
                            f"{a.upper()} {sign} {abs(off):g}s", rid))

        elif kind == "interval":
            a, b = rule.get("from_anchor", "c1"), rule.get("to_anchor", "c4")
            ta, tb = anchor_t(a), anchor_t(b)
            if ta is None or tb is None:
                warnings.append(
                    f"'{rule.get('label', rid)}': needs {a.upper()}->{b.upper()}, "
                    "which do not both exist here."
                )
                continue
            every = max(1.0, float(rule.get("every_s", 300)))
            n = int(math.floor((tb - ta) / every))
            for k in range(n + 1):
                raw.append((ta + k * every, f"{a.upper()}+{k * every:g}s", rid))

        elif kind == "obscuration_steps":
            t_max = anchor_t("max")
            t1, t4 = anchor_t("c1"), anchor_t("c4")
            peak = circ["max_obscuration"]
            branch = rule.get("branch", "both")
            for pct in rule.get("percents", [25, 50, 75]):
                target = pct / 100.0
                if target > peak + 1e-9:
                    warnings.append(
                        f"'{rule.get('label', rid)}': {pct}% obscuration is never "
                        f"reached here (peak is {peak * 100:.2f}%)."
                    )
                    continue
                if branch in ("ingress", "both") and t1 is not None:
                    t = _time_for_obscuration(obs, ts, target, t1, t_max)
                    if t:
                        raw.append((t, f"{pct}% covered (waxing)", rid))
                if branch in ("egress", "both") and t4 is not None:
                    t = _time_for_obscuration(obs, ts, target, t_max, t4)
                    if t:
                        raw.append((t, f"{pct}% covered (waning)", rid))

        elif kind == "totality_bracket":
            t2, t3 = anchor_t("c2"), anchor_t("c3")
            if t2 is None or t3 is None:
                warnings.append(
                    f"'{rule.get('label', rid)}': there is no totality at this "
                    "location, so it cannot be bracketed."
                )
                continue
            count = max(1, int(rule.get("count", 5)))
            inset = float(rule.get("inset_s", 2.0))
            lo, hi = t2 + inset, t3 - inset
            if hi <= lo:
                lo, hi = t2, t3
            if count == 1:
                raw.append(((lo + hi) / 2, "Mid-totality", rid))
            else:
                for k in range(count):
                    t = lo + (hi - lo) * k / (count - 1)
                    raw.append((t, f"Totality {k + 1}/{count}", rid))
        else:
            warnings.append(f"Unknown rule kind '{kind}' was skipped.")

    # Build full frames so every shot carries altitude and exposure guidance.
    t2, t3 = anchor_t("c2"), anchor_t("c3")
    shots = []
    for t_unix, label, rid in sorted(raw, key=lambda x: x[0]):
        f = frame_at(lat, lon, elev_m, t_unix)
        exp = _exposure_for(f.phase, t_unix, t2, t3)
        shot = f.as_dict()
        shot.update({"label": label, "rule_id": rid, "exposure": exp})
        if f.sun_alt_geometric < 0:
            shot["blocked"] = "Sun is below the horizon at this time."
        elif f.sun_alt < 3:
            shot["blocked"] = (
                f"Sun is only {f.sun_alt:.1f}° up — likely behind terrain."
            )
        shots.append(shot)

    below = sum(1 for s in shots if s.get("blocked"))
    if below:
        warnings.append(
            f"{below} of {len(shots)} planned shots have the Sun at or below "
            "the horizon. Spain sits at the sunset end of this eclipse."
        )
    return {"circumstances": circ, "shots": shots, "warnings": warnings}


PRESETS = [
    {
        "name": "Composite sequence (every 10% + totality)",
        "description": "Even obscuration steps for a classic strip composite, "
                       "plus the diamond rings and mid-totality.",
        "rules": [
            {"id": "steps", "kind": "obscuration_steps", "label": "10% steps",
             "percents": [10, 20, 30, 40, 50, 60, 70, 80, 90], "branch": "both"},
            {"id": "dr", "kind": "anchor_offsets", "label": "Diamond ring in",
             "anchor": "c2", "offsets_s": [-2, 2]},
            {"id": "dr2", "kind": "anchor_offsets", "label": "Diamond ring out",
             "anchor": "c3", "offsets_s": [-2, 2]},
            {"id": "mid", "kind": "anchor_offsets", "label": "Mid-totality",
             "anchor": "max", "offsets_s": [0]},
        ],
    },
    {
        "name": "Totality bracket (corona detail)",
        "description": "Beads, chromosphere, then a spread across totality for "
                       "an HDR corona stack.",
        "rules": [
            {"id": "beads", "kind": "anchor_offsets", "label": "Baily's beads",
             "anchor": "c2", "offsets_s": [-4, -2, 0, 2, 4]},
            {"id": "brk", "kind": "totality_bracket", "label": "Corona spread",
             "count": 7, "inset_s": 6},
            {"id": "beads2", "kind": "anchor_offsets", "label": "Exit beads",
             "anchor": "c3", "offsets_s": [-4, -2, 0, 2, 4]},
        ],
    },
    {
        "name": "Time-lapse every 5 minutes",
        "description": "Steady cadence from first to last contact.",
        "rules": [
            {"id": "tl", "kind": "interval", "label": "5 min cadence",
             "from_anchor": "c1", "to_anchor": "c4", "every_s": 300},
        ],
    },
]
