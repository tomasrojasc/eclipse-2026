/** Types and fetchers for the eclipse backend. */

export interface Frame {
  t_unix: number
  iso_utc?: string
  sep: number
  r_sun: number
  r_moon: number
  dx: number
  dy: number
  pa_north: number
  pa_zenith: number
  obscuration: number
  magnitude: number
  sun_alt: number
  sun_alt_geometric: number
  sun_az: number
  moon_alt?: number
  moon_az?: number
  phase: 'none' | 'partial' | 'total' | 'annular'
}

export interface Circumstances {
  lat: number
  lon: number
  elevation_m: number
  has_eclipse: boolean
  is_total: boolean
  totality_seconds?: number
  events: Partial<Record<'c1' | 'c2' | 'max' | 'c3' | 'c4', Frame>>
  max: Frame | null
  max_obscuration?: number
  max_magnitude?: number
  notes: string[]
  sun_set_unix?: number | null
}

export interface SeriesResponse {
  circumstances: Circumstances
  frames: Frame[]
}

export interface Exposure {
  target: string
  hint: string
  filter: boolean
}

export interface PlannedShot extends Frame {
  label: string
  rule_id: string
  exposure: Exposure
  blocked?: string
}

export interface PlanResponse {
  circumstances: Circumstances
  shots: PlannedShot[]
  warnings: string[]
}

export interface SavedShot {
  id: number
  lat: number
  lon: number
  elev_m: number
  t_unix: number
  label: string
  note: string
  payload: Partial<PlannedShot>
  created: number
}

export interface EclipsePath {
  centerline: { lat: number; lon: number; t_unix: number }[]
  centerline_iberia: { lat: number; lon: number; t_unix: number }[]
  limits: { north: { lat: number; lon: number }[]; south: { lat: number; lon: number }[] }
}

export type RuleKind =
  | 'obscuration_steps'
  | 'anchor_offsets'
  | 'interval'
  | 'totality_bracket'

export interface Rule {
  id: string
  kind: RuleKind
  label: string
  /** obscuration_steps */
  percents?: number[]
  branch?: 'ingress' | 'egress' | 'both'
  /** anchor_offsets */
  anchor?: 'c1' | 'c2' | 'max' | 'c3' | 'c4'
  offsets_s?: number[]
  /** interval */
  from_anchor?: 'c1' | 'c2' | 'max' | 'c3' | 'c4'
  to_anchor?: 'c1' | 'c2' | 'max' | 'c3' | 'c4'
  every_s?: number
  /** totality_bracket */
  count?: number
  inset_s?: number
}

export interface Preset {
  name: string
  description: string
  rules: Rule[]
}

export interface Place {
  name: string
  region: string
  lat: number
  lon: number
  elevation_m: number
  population: number
}

export interface PlaceSearchResponse {
  kind: 'places' | 'coordinates'
  results: Place[]
}

/** Compact per-site verdict used to annotate search results. */
export interface Summary {
  lat: number
  lon: number
  has_eclipse: boolean
  is_total: boolean
  totality_seconds?: number
  max_obscuration?: number
  max_t_unix?: number
  sun_alt_at_max?: number
  sun_up_at_max?: boolean
}

export interface Bead {
  pa_deg: number
  pa_zenith_deg: number
  clock: string
  t_first: number
  t_last: number
  duration_s: number
  peak_depth_asec: number
  width_deg: number
  sel_lat: number
  sel_lon: number
}

export interface BeadsResult {
  available: boolean
  is_total: boolean
  contact: 'c2' | 'c3'
  contact_t_unix?: number
  true_contact_t_unix?: number | null
  limb_correction_s?: number | null
  beads: Bead[]
  max_simultaneous: number
  phase_start?: number
  phase_end?: number
  phase_duration_s?: number
  profile?: {
    relief_min_km: number
    relief_max_km: number
    relief_rms_km: number
    sub_lat: number
    sub_lon: number
    distance_km: number
    resolution_asec: number
  }
  note: string
}

export interface BeadMap {
  available: boolean
  is_total: boolean
  contact: 'c2' | 'c3'
  contact_t_unix: number
  t_unix: number[]
  pa_deg: number[]
  zenith_offset_deg: number
  depth_asec: number[][]
  sun_radius_asec: number
  note?: string
}

export interface LimbProfile {
  pa_deg: number[]
  theta_rad: number[]
  relief_km: number[]
  /** Where on the Moon each limb point sits, for the terrain map. */
  sel_lat: number[]
  sel_lon: number[]
  mean_sphere_rad: number
  sub_lat: number
  sub_lon: number
  distance_km: number
}

export interface MoonScene {
  available: boolean
  is_total: boolean
  contact?: 'c2' | 'c3'
  contact_t_unix?: number
  t_unix: number[]
  /** Observer position relative to the Moon's centre, body-fixed km. */
  observer_km: number[][]
  /** Sun position in the same frame, body-fixed km. */
  sun_km: number[][]
  moon_radius_km: number
  sun_radius_km: number
  north_dir: number[]
  east_dir: number[]
  sub_lat: number
  sub_lon: number
  /** Selenographic bounds of the limb stretch that makes the beads. */
  bead_region?: {
    lat0: number
    lat1: number
    lon0: number
    lon1: number
    pa0: number
    pa1: number
  } | null
  note?: string
}

export interface FlatLimbData {
  available: boolean
  is_total: boolean
  contact?: 'c2' | 'c3'
  contact_t_unix?: number
  pa_deg: number[]
  /** Apparent limb radius per position angle, arcsec. */
  moon_asec: number[]
  sel_lat: number[]
  sel_lon: number[]
  mean_asec: number
  t_unix: number[]
  /** Sun centre relative to the Moon centre, arcsec. */
  sun_east_asec: number[]
  sun_north_asec: number[]
  sun_radius_asec: number[]
  bead_pa: number[]
  phase_start?: number | null
  phase_end?: number | null
  km_per_asec: number
  note?: string
}

export interface SavedPattern {
  id: number
  name: string
  rules: Rule[]
  created: number
}

/** A per-browser id, so a shared deployment gives everyone their own shot list
 *  rather than one list the whole internet edits together. */
export const CLIENT_ID: string = (() => {
  const KEY = 'eclipse2026.clientId'
  try {
    const existing = localStorage.getItem(KEY)
    if (existing) return existing
    const fresh =
      globalThis.crypto?.randomUUID?.().replace(/-/g, '') ??
      Math.random().toString(36).slice(2) + Date.now().toString(36)
    localStorage.setItem(KEY, fresh)
    return fresh
  } catch {
    // Private browsing with storage disabled: fall back to a session-only id.
    return 'ephemeral'
  }
})()

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'x-client-id': CLIENT_ID,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`)
  }
  return res.json() as Promise<T>
}

const q = (lat: number, lon: number, elev: number) =>
  `lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&elev_m=${elev}`

export const api = {
  series: (lat: number, lon: number, elev = 0, step = 10) =>
    req<SeriesResponse>(`/api/eclipse/series?${q(lat, lon, elev)}&step_s=${step}`),

  circumstances: (lat: number, lon: number, elev = 0) =>
    req<Circumstances>(`/api/eclipse/circumstances?${q(lat, lon, elev)}`),

  path: () => req<EclipsePath>('/api/eclipse/path'),

  plan: (lat: number, lon: number, elev: number, rules: Rule[]) =>
    req<PlanResponse>('/api/plan', {
      method: 'POST',
      body: JSON.stringify({ lat, lon, elev_m: elev, rules }),
    }),

  presets: () => req<Preset[]>('/api/plan/presets'),

  placeSearch: (q: string, limit = 8) =>
    req<PlaceSearchResponse>(
      `/api/places/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),

  summaries: (points: [number, number][]) =>
    req<Summary[]>('/api/eclipse/summaries', {
      method: 'POST',
      body: JSON.stringify({ points }),
    }),

  beads: (lat: number, lon: number, elev: number, contact: 'c2' | 'c3') =>
    req<BeadsResult>(
      `/api/eclipse/beads?${q(lat, lon, elev)}&contact=${contact}`,
    ),

  limb: (lat: number, lon: number, elev: number, t_unix: number) =>
    req<LimbProfile>(`/api/eclipse/limb?${q(lat, lon, elev)}&t_unix=${t_unix}`),

  beadMap: (lat: number, lon: number, elev: number, contact: 'c2' | 'c3') =>
    req<BeadMap>(`/api/eclipse/beadmap?${q(lat, lon, elev)}&contact=${contact}`),

  /** The LOLA raster as raw bytes; shape and range ride in the headers. */
  demRaster: async (width = 720) => {
    const res = await fetch(`/api/moon/dem?width=${width}`)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const buf = await res.arrayBuffer()
    return {
      data: new Uint8Array(buf),
      w: Number(res.headers.get('X-Width')),
      h: Number(res.headers.get('X-Height')),
      lo: Number(res.headers.get('X-Min-Radius-Km')),
      hi: Number(res.headers.get('X-Max-Radius-Km')),
    }
  },

  moonScene: (
    lat: number,
    lon: number,
    elev: number,
    contact: 'c2' | 'c3',
    n = 240,
  ) =>
    req<MoonScene>(
      `/api/moon/scene?${q(lat, lon, elev)}&contact=${contact}&n=${n}`,
    ),

  /** Elevation as int16 DN, for displacing the 3D surface. */
  dem16: async (width = 1440) => {
    const res = await fetch(`/api/moon/dem16?width=${width}`)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const buf = await res.arrayBuffer()
    return {
      data: new Int16Array(buf),
      w: Number(res.headers.get('X-Width')),
      h: Number(res.headers.get('X-Height')),
      scale: Number(res.headers.get('X-Scale-M')),
      offset: Number(res.headers.get('X-Offset-M')),
    }
  },

  /** Native-resolution DEM crop for the bead region. */
  demPatch: async (lat0: number, lat1: number, lon0: number, lon1: number) => {
    const res = await fetch(
      `/api/moon/dempatch?lat0=${lat0}&lat1=${lat1}&lon0=${lon0}&lon1=${lon1}`,
    )
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const buf = await res.arrayBuffer()
    const n = (k: string) => Number(res.headers.get(k))
    return {
      data: new Int16Array(buf),
      w: n('X-Width'),
      h: n('X-Height'),
      latTop: n('X-Lat-Top'),
      latBottom: n('X-Lat-Bottom'),
      lonLeft: n('X-Lon-Left'),
      lonRight: n('X-Lon-Right'),
      scale: n('X-Scale-M'),
      offset: n('X-Offset-M'),
    }
  },

  flatLimb: (
    lat: number,
    lon: number,
    elev: number,
    contact: 'c2' | 'c3',
    nTimes = 240,
  ) =>
    req<FlatLimbData>(
      `/api/eclipse/limbflat?${q(lat, lon, elev)}&contact=${contact}` +
        `&n_times=${nTimes}`,
    ),

  shots: () => req<SavedShot[]>('/api/shots'),

  addShot: (s: {
    lat: number
    lon: number
    elev_m?: number
    t_unix: number
    label?: string
    note?: string
    payload?: unknown
  }) => req<SavedShot>('/api/shots', { method: 'POST', body: JSON.stringify(s) }),

  addShots: (items: unknown[]) =>
    req<SavedShot[]>('/api/shots/bulk', {
      method: 'POST',
      body: JSON.stringify(items),
    }),

  updateShot: (id: number, patch: { label?: string; note?: string; t_unix?: number }) =>
    req<SavedShot>(`/api/shots/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteShot: (id: number) =>
    req<{ deleted: number }>(`/api/shots/${id}`, { method: 'DELETE' }),

  clearShots: () => req<{ deleted: number }>('/api/shots', { method: 'DELETE' }),

  patterns: () => req<SavedPattern[]>('/api/patterns'),

  savePattern: (name: string, rules: Rule[]) =>
    req<SavedPattern>('/api/patterns', {
      method: 'POST',
      body: JSON.stringify({ name, rules }),
    }),

  deletePattern: (id: number) =>
    req<{ deleted: number }>(`/api/patterns/${id}`, { method: 'DELETE' }),
}

/** Spanish peninsular local time on eclipse day is CEST (UTC+2). */
export const CEST_OFFSET_MIN = 120

export function fmtLocal(t: number, withMillis = false): string {
  const d = new Date((t + CEST_OFFSET_MIN * 60) * 1000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const base = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  return withMillis ? `${base}.${p(Math.floor(d.getUTCMilliseconds() / 100), 1)}` : base
}

export function fmtUTC(t: number): string {
  const d = new Date(t * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`
}

/** Format coverage without ever letting a partial eclipse read as "100%".
 *
 * Madrid reaches 99.98% and Santiago 99.95%. Rounded to one decimal both show
 * as "100.0%", which is precisely the wrong impression: a hair short of totality
 * looks nothing like totality and there is no corona to photograph.
 */
export function fmtObscurationPct(x: number, decimals = 1): string {
  const pct = x * 100
  if (pct >= 100) return '100'
  const shown = pct.toFixed(decimals)
  if (Number(shown) >= 100) return (Math.floor(pct * 100) / 100).toFixed(2)
  return shown
}

export function fmtDuration(s: number): string {
  const sign = s < 0 ? '−' : ''
  s = Math.abs(s)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  if (h) return `${sign}${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${sign}${m}m ${String(sec).padStart(2, '0')}s`
  return `${sign}${sec}s`
}

export const ANCHOR_LABELS: Record<string, string> = {
  c1: 'C1 · first contact',
  c2: 'C2 · totality begins',
  max: 'MAX · greatest eclipse',
  c3: 'C3 · totality ends',
  c4: 'C4 · last contact',
}
