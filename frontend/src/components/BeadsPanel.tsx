/** Baily's beads: which valleys on the Moon's limb will let sunlight through,
 *  and exactly when. The polar chart shows the limb profile with its relief
 *  exaggerated — at true scale the whole range is 0.25% of the radius. */

import { useEffect, useRef, useState } from 'react'
import type { Bead, BeadsResult, LimbProfile } from '../api'
import { api, fmtLocal } from '../api'

const CONTACTS = [
  { key: 'c2' as const, title: 'C2 · beads before totality',
    blurb: 'The crescent breaks up, the last beads wink out, totality starts.' },
  { key: 'c3' as const, title: 'C3 · beads after totality',
    blurb: 'First light returns through the valleys on the opposite limb.' },
]

function LimbChart({
  profile,
  beads,
  size = 168,
}: {
  profile: LimbProfile | null
  beads: Bead[]
  size?: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv || !profile) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = size * dpr
    cv.height = size * dpr
    cv.style.width = `${size}px`
    cv.style.height = `${size}px`
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, size, size)

    const cx = size / 2
    const cy = size / 2
    const base = size * 0.3
    const relief = profile.relief_km
    const span = Math.max(...relief.map(Math.abs), 1)
    // Exaggerate relief hugely; the point is to read the shape, not the scale.
    const amp = size * 0.13

    // Mean limb, for reference.
    g.strokeStyle = 'rgba(133,147,180,0.35)'
    g.setLineDash([2, 3])
    g.beginPath()
    g.arc(cx, cy, base, 0, Math.PI * 2)
    g.stroke()
    g.setLineDash([])

    // The real limb. PA is measured from north, eastward; north is up here.
    g.strokeStyle = '#c8dcff'
    g.lineWidth = 1.2
    g.beginPath()
    profile.pa_deg.forEach((pa, i) => {
      const r = base + (relief[i] / span) * amp
      const a = ((pa - 90) * Math.PI) / 180
      const x = cx + r * Math.cos(a)
      const y = cy + r * Math.sin(a)
      i ? g.lineTo(x, y) : g.moveTo(x, y)
    })
    g.closePath()
    g.stroke()

    // Where each bead breaks through.
    beads.forEach((b) => {
      const a = ((b.pa_deg - 90) * Math.PI) / 180
      const i = Math.round((b.pa_deg / 360) * profile.pa_deg.length) % profile.pa_deg.length
      const r = base + (relief[i] / span) * amp
      const x = cx + r * Math.cos(a)
      const y = cy + r * Math.sin(a)
      const rad = 2 + Math.min(4, b.peak_depth_asec * 3)
      const grd = g.createRadialGradient(x, y, 0, x, y, rad * 3)
      grd.addColorStop(0, 'rgba(255,244,214,0.95)')
      grd.addColorStop(0.4, 'rgba(240,166,60,0.5)')
      grd.addColorStop(1, 'rgba(240,166,60,0)')
      g.fillStyle = grd
      g.beginPath()
      g.arc(x, y, rad * 3, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#fff8e6'
      g.beginPath()
      g.arc(x, y, rad * 0.6, 0, Math.PI * 2)
      g.fill()
    })

    g.fillStyle = '#5c6a8c'
    g.font = "9px 'JetBrains Mono', monospace"
    g.textAlign = 'center'
    g.fillText('N', cx, 10)
    g.textAlign = 'left'
    g.fillText('E', size - 9, cy + 3)
    g.fillStyle = '#5c6a8c'
    g.textAlign = 'center'
    g.fillText(`relief ×${(amp / base * 100).toFixed(0)}`, cx, size - 3)
  }, [profile, beads, size])

  if (!profile) return <div className="limb-chart-empty">—</div>
  return <canvas ref={ref} className="limb-chart" />
}

function BeadList({
  data,
  onGoTo,
  onSaveAll,
  saving,
}: {
  data: BeadsResult
  onGoTo: (t: number) => void
  onSaveAll: () => void
  saving: boolean
}) {
  if (!data.is_total) {
    return <div className="beads-none">{data.note}</div>
  }
  return (
    <>
      <div className="beads-stats">
        <div className="bstat">
          <span className="k">Beads phase</span>
          <span className="v mono">
            {data.phase_start !== undefined
              ? `${fmtLocal(data.phase_start, true)} → ${fmtLocal(data.phase_end!, true)}`
              : '—'}
          </span>
          <span className="s">
            {data.phase_duration_s !== undefined
              ? `${data.phase_duration_s.toFixed(2)} s of broken light`
              : ''}
          </span>
        </div>
        <div className="bstat">
          <span className="k">Real contact</span>
          <span className="v mono">
            {data.true_contact_t_unix
              ? fmtLocal(data.true_contact_t_unix, true)
              : '—'}
          </span>
          <span className="s">
            {data.limb_correction_s !== null && data.limb_correction_s !== undefined
              ? `${data.limb_correction_s > 0 ? '+' : ''}${data.limb_correction_s.toFixed(2)} s vs a smooth Moon`
              : ''}
          </span>
        </div>
        <div className="bstat">
          <span className="k">Most at once</span>
          <span className="v mono">{data.max_simultaneous}</span>
          <span className="s">{data.beads.length} distinct beads</span>
        </div>
      </div>

      {data.beads.length > 0 && (
        <div className="bead-rows">
          {data.beads.map((b, i) => (
            <button
              key={`${b.pa_deg}-${b.t_first}-${i}`}
              className="bead-row"
              onClick={() => onGoTo(b.t_first)}
              title="Scrub the timeline to this bead"
            >
              <span className="t mono">{fmtLocal(b.t_first, true)}</span>
              <span className="dur mono">{b.duration_s.toFixed(2)}s</span>
              <span className="where">
                {b.clock}
                <em>PA {b.pa_deg.toFixed(0)}°</em>
              </span>
              <span className="valley mono" title="Selenographic position of the valley">
                {b.sel_lat > 0 ? 'N' : 'S'}
                {Math.abs(b.sel_lat).toFixed(0)}° {b.sel_lon > 0 ? 'E' : 'W'}
                {Math.abs(b.sel_lon).toFixed(0)}°
              </span>
              <span
                className="depth"
                title={`${b.peak_depth_asec}" deep, ${b.width_deg}° wide`}
              >
                <i style={{ width: `${Math.min(100, b.peak_depth_asec * 90)}%` }} />
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="beads-actions">
        <button className="btn" onClick={onSaveAll} disabled={saving || !data.beads.length}>
          ★ Add {data.beads.length} bead times to shot list
        </button>
      </div>
    </>
  )
}

export function BeadsPanel({
  lat,
  lon,
  elev,
  onGoTo,
  onSaved,
}: {
  lat: number
  lon: number
  elev: number
  onGoTo: (t: number) => void
  onSaved: () => void
}) {
  const [data, setData] = useState<Record<string, BeadsResult>>({})
  const [profiles, setProfiles] = useState<Record<string, LimbProfile | null>>({})
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setErr(null)
    setData({})
    setProfiles({})
    Promise.all(CONTACTS.map((c) => api.beads(lat, lon, elev, c.key)))
      .then(async (rows) => {
        if (cancelled) return
        const byKey: Record<string, BeadsResult> = {}
        CONTACTS.forEach((c, i) => (byKey[c.key] = rows[i]))
        setData(byKey)
        // The limb profile only matters where totality actually happens.
        const withTotality = CONTACTS.filter((c) => byKey[c.key]?.is_total)
        const profs = await Promise.all(
          withTotality.map((c) =>
            api
              .limb(lat, lon, elev, byKey[c.key].contact_t_unix!)
              .catch(() => null),
          ),
        )
        if (cancelled) return
        const pk: Record<string, LimbProfile | null> = {}
        withTotality.forEach((c, i) => (pk[c.key] = profs[i]))
        setProfiles(pk)
      })
      .catch((e: Error) => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setBusy(false))
    return () => {
      cancelled = true
    }
  }, [lat, lon, elev])

  const saveAll = async (key: string) => {
    const d = data[key]
    if (!d?.beads.length) return
    setSaving(true)
    try {
      await api.addShots(
        d.beads.map((b, i) => ({
          lat,
          lon,
          elev_m: elev,
          t_unix: b.t_first,
          label: `${key.toUpperCase()} bead ${i + 1} · ${b.clock}`,
          note: `PA ${b.pa_deg.toFixed(0)}°, lasts ${b.duration_s.toFixed(2)} s`,
          payload: {
            phase: 'partial',
            obscuration: 0.9999,
            sun_alt: undefined,
            exposure: {
              target: "Baily's beads — filter OFF",
              hint:
                'ISO 200, f/8, ~1/2000 s. Shoot a burst: the bead lasts ' +
                `${b.duration_s.toFixed(2)} s.`,
              filter: false,
            },
          },
        })),
      )
      onSaved()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Baily's beads</h2>
        <span className="spacer" />
        {busy && <span className="loading">reading the lunar limb…</span>}
        {data.c2?.profile && (
          <span className="mono" style={{ fontSize: 10, color: 'var(--faint)' }}>
            libration {data.c2.profile.sub_lat.toFixed(2)}°,{' '}
            {data.c2.profile.sub_lon.toFixed(2)}° · limb relief{' '}
            {data.c2.profile.relief_rms_km.toFixed(2)} km rms · LOLA{' '}
            {data.c2.profile.resolution_asec.toFixed(2)}″
          </span>
        )}
      </div>

      <div className="panel-body">
        {err && <div className="err">{err}</div>}

        {!err && (
          <div className="beads-grid">
            {CONTACTS.map((c) => {
              const d = data[c.key]
              return (
                <section className="beads-col" key={c.key}>
                  <header>
                    <h3>{c.title}</h3>
                    <p>{c.blurb}</p>
                  </header>
                  {d ? (
                    <div className="beads-body">
                      {d.is_total && (
                        <LimbChart profile={profiles[c.key] ?? null} beads={d.beads} />
                      )}
                      <div className="beads-detail">
                        <BeadList
                          data={d}
                          onGoTo={onGoTo}
                          onSaveAll={() => saveAll(c.key)}
                          saving={saving}
                        />
                      </div>
                    </div>
                  ) : (
                    !busy && <div className="beads-none">No data.</div>
                  )}
                </section>
              )
            })}
          </div>
        )}

        {data.c2?.note && (
          <ul className="notes" style={{ marginTop: 12 }}>
            <li>{data.c2.note}</li>
            <li>
              Beads come from LOLA laser altimetry of the Moon's shape combined
              with its libration at that instant, so these are the actual
              valleys that will let light through from your spot. Position
              angles run from celestial north through east; clock positions
              assume a horizon-levelled camera.
            </li>
          </ul>
        )}
      </div>
    </div>
  )
}
