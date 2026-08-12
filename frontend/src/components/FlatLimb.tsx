/** The limb rectified: relief against position angle, curvature removed.
 *
 * On the globe a bead is a sub-pixel notch on a curve. Straightened out, the
 * radial direction can be magnified on its own — a 2 km mountain beside a
 * 1737 km radius — and the beads become plainly readable: they are exactly the
 * stretches where the Sun's edge lies outside the Moon's profile.
 *
 * The vertical axis is inherently exaggerated relative to the horizontal, since
 * an 80 degree stretch of limb is ~1370 arcsec long and the whole relief is ~8
 * arcsec tall. The current factor is always shown rather than hidden.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FlatLimbData } from '../api'
import { api, fmtLocal } from '../api'

const PAD = { l: 52, r: 12, t: 14, b: 30 }

/** Distance from the Moon's centre out to the Sun's edge along position angle. */
function sunEdgeAsec(
  paRad: number,
  east: number,
  north: number,
  rSun: number,
): number {
  const dot = Math.sin(paRad) * east + Math.cos(paRad) * north
  const disc = dot * dot - (east * east + north * north) + rSun * rSun
  if (disc <= 0) return Number.NEGATIVE_INFINITY // this ray misses the Sun
  return dot + Math.sqrt(disc)
}

export function FlatLimb({
  lat,
  lon,
  elev,
  siteName,
}: {
  lat: number
  lon: number
  elev: number
  siteName: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [data, setData] = useState<FlatLimbData | null>(null)
  const [contact, setContact] = useState<'c2' | 'c3'>('c2')
  const [err, setErr] = useState<string | null>(null)
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [paCenter, setPaCenter] = useState(120)
  const [paSpan, setPaSpan] = useState(90)
  const [ySpan, setYSpan] = useState(9)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ x: number; center: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    setErr(null)
    setData(null)
    api
      .flatLimb(lat, lon, elev, contact, 240)
      .then((d) => {
        if (cancelled) return
        setData(d)
        if (d.is_total && d.bead_pa?.length) {
          // Frame the beads by default: that is what this view is for.
          const pas = d.bead_pa
          const lo = Math.min(...pas)
          const hi = Math.max(...pas)
          setPaCenter((lo + hi) / 2)
          setPaSpan(Math.max(12, (hi - lo) * 1.6))
        }
        if (d.t_unix?.length) setIdx(Math.floor(d.t_unix.length / 2))
      })
      .catch((e: Error) => !cancelled && setErr(e.message))
    return () => {
      cancelled = true
    }
  }, [lat, lon, elev, contact])

  useEffect(() => {
    if (!playing || !data?.t_unix) return
    const n = data.t_unix.length
    const id = setInterval(() => {
      setIdx((i) => {
        if (i >= n - 1) {
          setPlaying(false)
          return n - 1
        }
        return i + 1
      })
    }, 55)
    return () => clearInterval(id)
  }, [playing, data])

  // Lit arcs at the current instant, for the readout.
  const lit = useMemo(() => {
    if (!data?.is_total) return null
    const east = data.sun_east_asec[idx]
    const north = data.sun_north_asec[idx]
    const rSun = data.sun_radius_asec[idx]
    let arcs = 0
    let bins = 0
    let peak = 0
    let prev = false
    for (let i = 0; i < data.pa_deg.length; i++) {
      const rho = sunEdgeAsec((data.pa_deg[i] * Math.PI) / 180, east, north, rSun)
      const on = rho > data.moon_asec[i]
      if (on) {
        bins++
        peak = Math.max(peak, rho - data.moon_asec[i])
        if (!prev) arcs++
      }
      prev = on
    }
    return { arcs, deg: (bins / data.pa_deg.length) * 360, peak }
  }, [data, idx])

  useEffect(() => {
    const cv = ref.current
    if (!cv || !data?.is_total) return
    const holder = cv.parentElement
    const w = Math.max(340, holder?.clientWidth || 800)
    const h = 320
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = w * dpr
    cv.height = h * dpr
    cv.style.width = `${w}px`
    cv.style.height = `${h}px`
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)

    const plotW = w - PAD.l - PAD.r
    const plotH = h - PAD.t - PAD.b
    const pa0 = paCenter - paSpan / 2
    const pa1 = paCenter + paSpan / 2
    const y0 = -ySpan / 2
    const y1 = ySpan / 2
    const xOf = (pa: number) => PAD.l + ((pa - pa0) / (pa1 - pa0)) * plotW
    const yOf = (a: number) => PAD.t + (1 - (a - y0) / (y1 - y0)) * plotH

    g.fillStyle = '#05070e'
    g.fillRect(PAD.l, PAD.t, plotW, plotH)

    const mean = data.mean_asec
    const east = data.sun_east_asec[idx]
    const north = data.sun_north_asec[idx]
    const rSun = data.sun_radius_asec[idx]

    // Only walk the bins inside the window.
    const n = data.pa_deg.length
    const idxFor = (pa: number) => Math.round(((pa + 360) % 360) / 360 * n)
    const iStart = idxFor(pa0) - 2
    const iEnd = idxFor(pa1) + 2

    type Pt = { x: number; moon: number; sun: number }
    const pts: Pt[] = []
    for (let k = iStart; k <= iEnd; k++) {
      const i = ((k % n) + n) % n
      // Unwrap so a window crossing 0/360 still draws left to right.
      const paUnwrapped = pa0 + (((data.pa_deg[i] - pa0) % 360) + 360) % 360
      const rho = sunEdgeAsec((data.pa_deg[i] * Math.PI) / 180, east, north, rSun)
      pts.push({
        x: paUnwrapped,
        moon: data.moon_asec[i] - mean,
        sun: rho === Number.NEGATIVE_INFINITY ? -1e6 : rho - mean,
      })
    }
    pts.sort((a, b) => a.x - b.x)

    // Visible photosphere: the band between the Moon's profile and the Sun's
    // edge, wherever the Sun's edge is the outer one. These are the beads.
    g.beginPath()
    let open = false
    for (const p of pts) {
      if (p.sun > p.moon) {
        if (!open) {
          g.moveTo(xOf(p.x), yOf(p.moon))
          open = true
        }
        g.lineTo(xOf(p.x), yOf(p.moon))
      } else if (open) {
        open = false
      }
    }
    // Simpler and exact: fill each lit run as its own quad strip.
    g.beginPath()
    let run: Pt[] = []
    const flush = () => {
      if (run.length < 2) {
        run = []
        return
      }
      const grd = g.createLinearGradient(0, yOf(y1), 0, yOf(y0))
      grd.addColorStop(0, 'rgba(255,250,236,0.95)')
      grd.addColorStop(1, 'rgba(255,214,140,0.75)')
      g.fillStyle = grd
      g.beginPath()
      g.moveTo(xOf(run[0].x), yOf(run[0].moon))
      for (const p of run) g.lineTo(xOf(p.x), yOf(p.moon))
      for (let i = run.length - 1; i >= 0; i--)
        g.lineTo(xOf(run[i].x), yOf(Math.min(y1, run[i].sun)))
      g.closePath()
      g.fill()
      run = []
    }
    for (const p of pts) {
      if (p.sun > p.moon) run.push(p)
      else flush()
    }
    flush()

    // The Moon: everything below its profile is rock.
    g.fillStyle = '#141b2e'
    g.beginPath()
    g.moveTo(xOf(pts[0].x), yOf(y0))
    for (const p of pts) g.lineTo(xOf(p.x), yOf(p.moon))
    g.lineTo(xOf(pts[pts.length - 1].x), yOf(y0))
    g.closePath()
    g.fill()
    g.strokeStyle = '#c8dcff'
    g.lineWidth = 1.1
    g.beginPath()
    pts.forEach((p, i) => (i ? g.lineTo(xOf(p.x), yOf(p.moon)) : g.moveTo(xOf(p.x), yOf(p.moon))))
    g.stroke()

    // The Sun's edge.
    g.strokeStyle = 'rgba(240,166,60,0.95)'
    g.lineWidth = 1.2
    g.setLineDash([5, 3])
    g.beginPath()
    let started = false
    for (const p of pts) {
      if (p.sun < -1e5) {
        started = false
        continue
      }
      const yy = yOf(Math.max(y0, Math.min(y1, p.sun)))
      started ? g.lineTo(xOf(p.x), yy) : g.moveTo(xOf(p.x), yy)
      started = true
    }
    g.stroke()
    g.setLineDash([])

    // Mean limb reference.
    g.strokeStyle = 'rgba(133,147,180,0.4)'
    g.setLineDash([2, 4])
    g.beginPath()
    g.moveTo(PAD.l, yOf(0))
    g.lineTo(PAD.l + plotW, yOf(0))
    g.stroke()
    g.setLineDash([])

    // Axes.
    g.font = "9px 'JetBrains Mono', monospace"
    g.fillStyle = '#5c6a8c'
    g.textAlign = 'right'
    const kmPer = data.km_per_asec
    for (let k = -2; k <= 2; k++) {
      const a = (ySpan / 2) * (k / 2)
      g.fillText(`${a > 0 ? '+' : ''}${a.toFixed(1)}″`, PAD.l - 6, yOf(a) + 3)
      g.fillStyle = '#3f4a68'
      g.fillText(`${(a * kmPer).toFixed(1)}km`, PAD.l - 6, yOf(a) + 12)
      g.fillStyle = '#5c6a8c'
    }
    g.textAlign = 'center'
    const nTicks = 6
    for (let k = 0; k <= nTicks; k++) {
      const pa = pa0 + ((pa1 - pa0) * k) / nTicks
      g.fillText(`${(((pa % 360) + 360) % 360).toFixed(1)}°`, xOf(pa), h - 16)
    }
    g.fillText('position angle along the limb  →', PAD.l + plotW / 2, h - 4)

    // Mark where the tabulated beads sit.
    data.bead_pa.forEach((pa) => {
      const px = xOf(pa0 + (((pa - pa0) % 360) + 360) % 360)
      if (px < PAD.l || px > PAD.l + plotW) return
      g.strokeStyle = 'rgba(139,107,232,0.75)'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(px, PAD.t)
      g.lineTo(px, PAD.t + 8)
      g.stroke()
    })

    if (hover) {
      g.strokeStyle = 'rgba(240,166,60,0.55)'
      g.beginPath()
      g.moveTo(hover.x, PAD.t)
      g.lineTo(hover.x, PAD.t + plotH)
      g.stroke()
    }
  }, [data, idx, paCenter, paSpan, ySpan, hover])

  const hoverInfo = useMemo(() => {
    if (!data?.is_total || !hover || !ref.current) return null
    const w = parseFloat(ref.current.style.width)
    const plotW = w - PAD.l - PAD.r
    const pa0 = paCenter - paSpan / 2
    const pa = pa0 + ((hover.x - PAD.l) / plotW) * paSpan
    const n = data.pa_deg.length
    const i = ((Math.round((((pa % 360) + 360) % 360) / 360 * n) % n) + n) % n
    const rho = sunEdgeAsec((data.pa_deg[i] * Math.PI) / 180,
      data.sun_east_asec[idx], data.sun_north_asec[idx], data.sun_radius_asec[idx])
    return {
      pa: ((pa % 360) + 360) % 360,
      relief: data.moon_asec[i] - data.mean_asec,
      gap: rho - data.moon_asec[i],
      selLat: data.sel_lat[i],
      selLon: data.sel_lon[i],
    }
  }, [data, hover, paCenter, paSpan, idx])

  // Vertical exaggeration relative to true along-limb scale.
  const exaggeration = useMemo(() => {
    if (!data?.is_total || !ref.current) return 0
    const w = parseFloat(ref.current.style.width) || 800
    const plotW = w - PAD.l - PAD.r
    const plotH = 320 - PAD.t - PAD.b
    const arcsecAcross = (paSpan / 360) * 2 * Math.PI * data.mean_asec
    return (plotH / ySpan) / (plotW / arcsecAcross)
  }, [data, paSpan, ySpan])

  if (err) return <div className="err">{err}</div>
  if (data && !data.is_total) {
    return (
      <div className="panel">
        <div className="panel-body">
          <ul className="notes">
            <li className="warn">{data.note}</li>
            <li>Pick a site inside the violet band on the Plan tab.</li>
          </ul>
        </div>
      </div>
    )
  }

  return (
    <div className="globe-wrap">
      <div className="globe-head">
        <h2>
          Flat limb
          {siteName && <em> · {siteName}</em>}
        </h2>
        <span className="spacer" />
        {!data && <span className="loading">rectifying the limb…</span>}
        {data && (
          <span className="mono tiny">
            vertical exaggeration ×{exaggeration.toFixed(0)} · 1″ ={' '}
            {data.km_per_asec.toFixed(2)} km
          </span>
        )}
      </div>

      <div className="chart-holder flat-holder">
        <canvas
          ref={ref}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setHover({ x: e.clientX - r.left, y: e.clientY - r.top })
            if (drag.current) {
              const dx = e.clientX - drag.current.x
              const w = r.width - PAD.l - PAD.r
              setPaCenter(drag.current.center - (dx / w) * paSpan)
            }
          }}
          onMouseLeave={() => {
            setHover(null)
            drag.current = null
          }}
          onMouseDown={(e) => {
            drag.current = { x: e.clientX, center: paCenter }
          }}
          onMouseUp={() => {
            drag.current = null
          }}
          onWheel={(e) => {
            e.preventDefault()
            setPaSpan((s) =>
              Math.max(1.5, Math.min(180, s * (e.deltaY > 0 ? 1.15 : 1 / 1.15))),
            )
          }}
          style={{ cursor: drag.current ? 'grabbing' : 'grab' }}
        />
        <div className="flat-legend mono">
          <span className="k moon">— Moon's limb</span>
          <span className="k sun">-- Sun's edge</span>
          <span className="k bead">▬ sunlight</span>
        </div>
      </div>

      <div className="globe-controls">
        <div className="gc-row">
          <div className="speeds" role="group" aria-label="Contact">
            {(['c2', 'c3'] as const).map((k) => (
              <button
                key={k}
                aria-pressed={contact === k}
                onClick={() => setContact(k)}
              >
                {k.toUpperCase()}
              </button>
            ))}
          </div>
          <button className="btn primary" onClick={() => setPlaying(!playing)}>
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(0, (data?.t_unix?.length ?? 1) - 1)}
            value={idx}
            onChange={(e) => {
              setPlaying(false)
              setIdx(Number(e.target.value))
            }}
            aria-label="Time"
            style={{ flex: 1, minWidth: 140 }}
          />
          <span className="mono" style={{ fontSize: 12, color: 'var(--horizon)' }}>
            {data?.t_unix?.[idx] ? fmtLocal(data.t_unix[idx], true) : '—'}
          </span>
        </div>

        <div className="gc-row sliders">
          <label>
            <span>
              Limb window <b>{paSpan.toFixed(1)}°</b>
            </span>
            <input
              type="range"
              min={1.5}
              max={180}
              step={0.5}
              value={paSpan}
              onChange={(e) => setPaSpan(Number(e.target.value))}
            />
          </label>
          <label>
            <span>
              Centre <b>PA {paCenter.toFixed(1)}°</b>
            </span>
            <input
              type="range"
              min={0}
              max={360}
              step={0.5}
              value={paCenter}
              onChange={(e) => setPaCenter(Number(e.target.value))}
            />
          </label>
          <label>
            <span>
              Height <b>±{(ySpan / 2).toFixed(1)}″</b>
            </span>
            <input
              type="range"
              min={1}
              max={16}
              step={0.5}
              value={ySpan}
              onChange={(e) => setYSpan(Number(e.target.value))}
            />
          </label>
        </div>
      </div>

      <div className="panel">
        <div className="panel-body">
          <div className="explain">
            <p>
              The limb straightened out, so nothing is foreshortened and the
              radial direction can be magnified on its own. Rock is below the
              pale line, the dashed line is the Sun's edge, and the bright bands
              between them are sunlight getting past a ridge — the beads. Scrub
              through and watch a single band split into several as the ridges
              come up.
            </p>
            <div className="hoverbox mono">
              {hoverInfo ? (
                <>
                  PA {hoverInfo.pa.toFixed(2)}° · relief{' '}
                  {hoverInfo.relief >= 0 ? '+' : ''}
                  {hoverInfo.relief.toFixed(2)}″ (
                  {(hoverInfo.relief * (data?.km_per_asec ?? 0)).toFixed(2)} km)
                  <br />
                  {hoverInfo.gap > 0
                    ? `sunlight ${hoverInfo.gap.toFixed(2)}″ deep`
                    : `covered by ${(-hoverInfo.gap).toFixed(2)}″`}
                  <br />
                  valley at {hoverInfo.selLat >= 0 ? 'N' : 'S'}
                  {Math.abs(hoverInfo.selLat).toFixed(1)}°{' '}
                  {hoverInfo.selLon >= 0 ? 'E' : 'W'}
                  {Math.abs(hoverInfo.selLon).toFixed(1)}°
                </>
              ) : (
                'hover the profile · drag to pan · scroll to zoom'
              )}
            </div>
          </div>
          {lit && (
            <ul className="notes" style={{ marginTop: 8 }}>
              <li>
                At this instant: <b>{lit.arcs}</b> separate patch
                {lit.arcs === 1 ? '' : 'es'} of sunlight spanning{' '}
                {lit.deg.toFixed(2)}° of limb, deepest {lit.peak.toFixed(2)}″.
                Violet ticks along the top mark the beads in the tabulated list.
              </li>
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
