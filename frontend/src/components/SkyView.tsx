/** The eclipse as it will actually look, plus how high the Sun still is.
 *
 * Spain sees this eclipse a few degrees above the horizon, so the sky here is
 * not a black backdrop: it darkens and reddens with the Sun's altitude and with
 * how much of the disc is covered. The gauge beside it is the blunt companion
 * fact — whether the Sun is still up at all when your shot is due.
 */

import { useEffect, useRef, useState } from 'react'
import type { Bead, Circumstances, Frame } from '../api'

/** Redraw the canvases when the layout changes; they are sized in device px. */
function useResizeTick(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setTick((t) => t + 1))
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(raf)
    }
  }, [])
  return tick
}

type Orientation = 'zenith' | 'north'

/** Fixed-seed PRNG: the corona must not flicker while you scrub. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

function mix(c1: [number, number, number], c2: [number, number, number], t: number) {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ] as [number, number, number]
}

const rgb = (c: [number, number, number], a = 1) =>
  a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`

/** Remaining sunlight, very roughly. 99% covered is still surprisingly bright,
 *  which is exactly why the last seconds before C2 fool people. */
function lightLevel(obscuration: number, phase: string) {
  if (phase === 'total') return 0.03
  return Math.max(0.04, Math.pow(1 - obscuration, 0.45))
}

/** Sun colour reddens hard near the horizon from atmospheric extinction. */
function sunColour(alt: number): [number, number, number] {
  const t = clamp01(alt / 14)
  return mix([214, 78, 22], [255, 244, 214], t)
}

export function SkyView({
  frame,
  orientation,
  beads = [],
}: {
  frame: Frame | null
  orientation: Orientation
  /** Computed beads, drawn at their real position angles when their moment
   *  falls under the scrubber. */
  beads?: Bead[]
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const tick = useResizeTick()

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    // The holder is a flex child, so its box is set by the row height; reading
    // it here cannot feed back into the layout.
    const holder = cv.parentElement
    const w = Math.max(260, holder?.clientWidth || 520)
    const h = Math.max(240, holder?.clientHeight || Math.round((w * 3) / 4))
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = w * dpr
    cv.height = h * dpr
    cv.style.width = `${w}px`
    cv.style.height = `${h}px`
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)

    if (!frame) {
      g.fillStyle = '#0d1424'
      g.fillRect(0, 0, w, h)
      g.fillStyle = '#5c6a8c'
      g.font = "12px 'JetBrains Mono', monospace"
      g.textAlign = 'center'
      g.fillText('Pick a spot on the map', w / 2, h / 2)
      return
    }

    const L = lightLevel(frame.obscuration, frame.phase)
    const alt = frame.sun_alt

    // --- sky ---------------------------------------------------------------
    // Twilight navy at the top, sodium glow toward the horizon; both are pulled
    // down in brightness by L, and pushed violet during totality.
    const violet = clamp01((frame.obscuration - 0.9) / 0.1)
    const top = mix(
      mix([12, 26, 58], [8, 10, 24], 1 - L),
      [26, 16, 52],
      violet * 0.8,
    )
    const bottom = mix(
      mix([232, 138, 62], [18, 14, 30], 1 - L),
      [52, 26, 74],
      violet * 0.7,
    )
    const sky = g.createLinearGradient(0, 0, 0, h)
    sky.addColorStop(0, rgb(top))
    sky.addColorStop(1, rgb(bottom))
    g.fillStyle = sky
    g.fillRect(0, 0, w, h)

    // --- geometry ----------------------------------------------------------
    const cx = w / 2
    const cy = h * 0.46
    const rSunPx = Math.min(w, h) * 0.19
    const pxPerRad = rSunPx / frame.r_sun
    const rMoonPx = frame.r_moon * pxPerRad

    // dy is toward the zenith, which is up on screen (canvas y grows down).
    const pa = orientation === 'zenith' ? frame.pa_zenith : frame.pa_north
    const off = frame.sep * pxPerRad
    const mx = cx + off * Math.sin((pa * Math.PI) / 180)
    const my = cy - off * Math.cos((pa * Math.PI) / 180)

    const sunCol = sunColour(alt)
    const isTotal = frame.phase === 'total'

    // --- corona (only when the photosphere is actually hidden) -------------
    if (isTotal) {
      const rnd = mulberry32(20260812)
      // 2026 falls near solar maximum, so the corona is fairly round with
      // streamers rather than the two sharp equatorial fans of solar minimum.
      // The corona is mostly a smooth, steeply falling halo. Structure sits on
      // top of that as a few broad streamers, not as a starburst of spikes.
      const outer = rMoonPx * 3.2
      const glow = g.createRadialGradient(mx, my, rMoonPx * 0.98, mx, my, outer)
      glow.addColorStop(0, 'rgba(236,244,255,0.95)')
      glow.addColorStop(0.06, 'rgba(214,230,255,0.6)')
      glow.addColorStop(0.18, 'rgba(186,208,250,0.3)')
      glow.addColorStop(0.45, 'rgba(160,186,240,0.12)')
      glow.addColorStop(1, 'rgba(150,178,240,0)')
      g.fillStyle = glow
      g.beginPath()
      g.arc(mx, my, outer, 0, Math.PI * 2)
      g.fill()

      g.save()
      g.globalCompositeOperation = 'lighter'
      g.filter = 'blur(3px)'
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2 + rnd() * 0.22
        const len = rMoonPx * (1.35 + rnd() * 1.15)
        const wid = 0.06 + rnd() * 0.13
        const alpha = 0.05 + rnd() * 0.07
        const gr = g.createLinearGradient(mx, my, mx + Math.cos(a) * len, my + Math.sin(a) * len)
        gr.addColorStop(0, `rgba(226,238,255,${alpha})`)
        gr.addColorStop(0.35, `rgba(214,230,255,${alpha * 0.7})`)
        gr.addColorStop(1, 'rgba(200,220,255,0)')
        g.fillStyle = gr
        g.beginPath()
        g.moveTo(mx + Math.cos(a - wid) * rMoonPx, my + Math.sin(a - wid) * rMoonPx)
        g.lineTo(mx + Math.cos(a) * len, my + Math.sin(a) * len)
        g.lineTo(mx + Math.cos(a + wid) * rMoonPx, my + Math.sin(a + wid) * rMoonPx)
        g.closePath()
        g.fill()
      }
      g.restore()

      // Chromosphere: a thin rose ring, brightest just after C2 / before C3.
      const edge = Math.abs(frame.sep - Math.abs(frame.r_sun - frame.r_moon)) * pxPerRad
      const chromo = clamp01(1 - edge / (rMoonPx * 0.06))
      if (chromo > 0.01) {
        g.strokeStyle = `rgba(255,110,120,${0.5 * chromo})`
        g.lineWidth = Math.max(1, rMoonPx * 0.018)
        g.beginPath()
        g.arc(mx, my, rMoonPx * 1.005, 0, Math.PI * 2)
        g.stroke()
      }
    }

    // --- the Sun -----------------------------------------------------------
    if (!isTotal) {
      const halo = g.createRadialGradient(cx, cy, rSunPx * 0.9, cx, cy, rSunPx * 2.2)
      halo.addColorStop(0, rgb(sunCol, 0.4 * L))
      halo.addColorStop(1, rgb(sunCol, 0))
      g.fillStyle = halo
      g.beginPath()
      g.arc(cx, cy, rSunPx * 2.2, 0, Math.PI * 2)
      g.fill()

      g.fillStyle = rgb(sunCol)
      g.beginPath()
      g.arc(cx, cy, rSunPx, 0, Math.PI * 2)
      g.fill()

      // Limb darkening, exaggerated slightly so the disc reads as a sphere.
      const limb = g.createRadialGradient(cx, cy, rSunPx * 0.55, cx, cy, rSunPx)
      limb.addColorStop(0, 'rgba(255,255,255,0)')
      limb.addColorStop(1, rgb(mix(sunCol, [140, 40, 10], 0.5), 0.55))
      g.fillStyle = limb
      g.beginPath()
      g.arc(cx, cy, rSunPx, 0, Math.PI * 2)
      g.fill()
    }

    // --- the Moon ----------------------------------------------------------
    // Backlit and unlit: through a solar filter it reads as a true silhouette,
    // so keep only a trace of the sky in it.
    g.fillStyle = isTotal ? '#04060d' : rgb(mix(bottom, [3, 5, 11], 0.94))
    g.beginPath()
    g.arc(mx, my, rMoonPx, 0, Math.PI * 2)
    g.fill()

    // --- Baily's beads -----------------------------------------------------
    // Drawn from the LOLA limb profile rather than invented: each bead sits at
    // the position angle of the lunar valley that lets its light through. The
    // series samples totality every second while beads can last a fraction of
    // one, so allow a little slack around each bead's window.
    const SLACK_S = 0.6
    const live = beads.filter(
      (b) => frame.t_unix >= b.t_first - SLACK_S && frame.t_unix <= b.t_last + SLACK_S,
    )
    for (const b of live) {
      const bpa = orientation === 'zenith' ? b.pa_zenith_deg : b.pa_deg
      const a = (bpa * Math.PI) / 180
      const bx = mx + Math.sin(a) * rMoonPx
      const by = my - Math.cos(a) * rMoonPx
      // Brighter and larger for the deeper beads, which is what a longer lens
      // will actually resolve.
      const strength = clamp01(0.25 + b.peak_depth_asec / 1.2)
      const rad = rSunPx * (0.1 + 0.22 * strength)
      const spark = g.createRadialGradient(bx, by, 0, bx, by, rad)
      spark.addColorStop(0, 'rgba(255,255,255,0.98)')
      spark.addColorStop(0.16, `rgba(255,246,222,${0.85 * strength})`)
      spark.addColorStop(0.45, `rgba(255,214,140,${0.35 * strength})`)
      spark.addColorStop(1, 'rgba(255,200,120,0)')
      g.fillStyle = spark
      g.beginPath()
      g.arc(bx, by, rad, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = 'rgba(255,255,255,0.95)'
      g.beginPath()
      g.arc(bx, by, Math.max(1, rSunPx * 0.018 * (0.6 + strength)), 0, Math.PI * 2)
      g.fill()
    }
    if (live.length) {
      g.fillStyle = 'rgba(240,166,60,0.85)'
      g.font = "10px 'JetBrains Mono', monospace"
      g.textAlign = 'left'
      g.fillText(
        `${live.length} BEAD${live.length > 1 ? 'S' : ''}`,
        7,
        h - 8,
      )
    }

    // --- horizon -----------------------------------------------------------
    // Drawn to the same angular scale as the discs, so when the Sun is 2° up
    // you see the terrain genuinely crowding it.
    const horizonY = cy + (alt * Math.PI) / 180 * pxPerRad
    if (horizonY < h + 40) {
      const hz = g.createLinearGradient(0, horizonY - 26, 0, horizonY)
      hz.addColorStop(0, rgb(bottom, 0))
      hz.addColorStop(1, rgb(mix(bottom, [255, 190, 120], 0.28 * L), 0.5))
      g.fillStyle = hz
      g.fillRect(0, horizonY - 26, w, 26)

      g.fillStyle = '#05070e'
      g.beginPath()
      g.moveTo(0, horizonY)
      // A low, irregular ridge — a reminder that real horizons are not flat.
      const rnd2 = mulberry32(77)
      for (let x = 0; x <= w; x += w / 22) {
        g.lineTo(x, horizonY + (rnd2() - 0.5) * 5)
      }
      g.lineTo(w, h)
      g.lineTo(0, h)
      g.closePath()
      g.fill()

      g.strokeStyle = 'rgba(240,166,60,0.3)'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(0, horizonY)
      g.lineTo(w, horizonY)
      g.stroke()

      g.fillStyle = 'rgba(240,166,60,0.65)'
      g.font = "9px 'JetBrains Mono', monospace"
      g.textAlign = 'left'
      g.fillText('HORIZON 0°', 7, horizonY - 5)
    }

    // --- orientation key ---------------------------------------------------
    g.fillStyle = 'rgba(228,233,247,0.5)'
    g.font = "9px 'JetBrains Mono', monospace"
    g.textAlign = 'left'
    g.fillText(
      orientation === 'zenith' ? 'UP = ZENITH' : 'UP = CELESTIAL NORTH',
      7,
      13,
    )
    g.textAlign = 'right'
    g.fillText(`${(frame.r_sun * 2 * 180 / Math.PI).toFixed(3)}° SUN Ø`, w - 7, 13)
  }, [frame, orientation, beads, tick])

  return (
    <div className="sky-holder">
      <canvas ref={ref} className="sky-canvas" />
    </div>
  )
}

/** How high the Sun still is, with its track through the eclipse. */
export function AltitudeGauge({
  frame,
  frames,
  circ,
}: {
  frame: Frame | null
  frames: Frame[]
  circ: Circumstances | null
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const tick = useResizeTick()

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const w = 78
    const row = cv.parentElement
    const h = Math.max(240, row?.clientHeight || 300)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = w * dpr
    cv.height = h * dpr
    cv.style.width = `${w}px`
    cv.style.height = `${h}px`
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)

    const maxAlt = Math.max(5, ...frames.map((f) => f.sun_alt), frame?.sun_alt ?? 0)
    const top = Math.ceil(maxAlt / 5) * 5
    const padT = 14
    const padB = 30
    const yOf = (a: number) => padT + (1 - a / top) * (h - padT - padB)

    const bg = g.createLinearGradient(0, 0, 0, h)
    bg.addColorStop(0, '#0b1122')
    bg.addColorStop(1, '#1d1526')
    g.fillStyle = bg
    g.fillRect(0, 0, w, h)

    // Ground.
    const y0 = yOf(0)
    g.fillStyle = '#05070e'
    g.fillRect(0, y0, w, h - y0)
    g.strokeStyle = 'rgba(240,166,60,0.45)'
    g.beginPath()
    g.moveTo(0, y0)
    g.lineTo(w, y0)
    g.stroke()

    // Degree ticks.
    g.font = "9px 'JetBrains Mono', monospace"
    g.textAlign = 'right'
    for (let a = 0; a <= top; a += 5) {
      const y = yOf(a)
      g.strokeStyle = 'rgba(37,49,84,0.9)'
      g.beginPath()
      g.moveTo(w - 22, y)
      g.lineTo(w - 17, y)
      g.stroke()
      g.fillStyle = '#5c6a8c'
      g.fillText(`${a}°`, w - 4, y + 3)
    }

    // The Sun's track across the eclipse, left-to-right in time.
    if (frames.length > 1) {
      const t0 = frames[0].t_unix
      const t1 = frames[frames.length - 1].t_unix
      const xOf = (t: number) => 8 + ((t - t0) / (t1 - t0)) * (w - 34)
      g.strokeStyle = 'rgba(133,147,180,0.5)'
      g.lineWidth = 1
      g.beginPath()
      frames.forEach((f, i) => {
        const x = xOf(f.t_unix)
        const y = yOf(f.sun_alt)
        i ? g.lineTo(x, y) : g.moveTo(x, y)
      })
      g.stroke()

      // Totality marked on the track — the part you cannot reschedule.
      const c2 = circ?.events?.c2
      const c3 = circ?.events?.c3
      if (c2 && c3) {
        g.strokeStyle = '#8b6be8'
        g.lineWidth = 3
        g.beginPath()
        frames
          .filter((f) => f.t_unix >= c2.t_unix && f.t_unix <= c3.t_unix)
          .forEach((f, i) => {
            const x = xOf(f.t_unix)
            const y = yOf(f.sun_alt)
            i ? g.lineTo(x, y) : g.moveTo(x, y)
          })
        g.stroke()
      }

      if (frame) {
        const x = xOf(frame.t_unix)
        const y = yOf(frame.sun_alt)
        g.fillStyle = frame.phase === 'total' ? '#8b6be8' : '#f0a63c'
        g.beginPath()
        g.arc(x, y, 4, 0, Math.PI * 2)
        g.fill()
        g.strokeStyle = 'rgba(255,255,255,0.7)'
        g.lineWidth = 1
        g.stroke()
      }
    }

    g.fillStyle = '#8593b4'
    g.textAlign = 'left'
    g.fillText('SUN ALT', 5, 11)

    if (frame) {
      g.fillStyle = frame.sun_alt_geometric < 0 ? '#e85d5d' : '#f0a63c'
      g.font = "600 12px 'JetBrains Mono', monospace"
      g.textAlign = 'center'
      g.fillText(`${frame.sun_alt.toFixed(2)}°`, w / 2, h - 10)
    }
  }, [frame, frames, circ, tick])

  return <canvas ref={ref} className="gauge" />
}
