/** Explore the data behind the bead prediction.
 *
 * Three views of the same thing, from source to result: the Moon's measured
 * shape, the limb profile that shape produces for your spot, and the field of
 * visible photosphere over angle and time that the beads are picked out of.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Bead, BeadMap, BeadsResult, LimbProfile } from '../api'
import { api, fmtLocal } from '../api'

// --- the Moon's measured shape ---------------------------------------------

function TerrainMap({
  profile,
  beads,
}: {
  profile: LimbProfile | null
  beads: Bead[]
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [dem, setDem] = useState<{
    data: Uint8Array
    w: number
    h: number
    lo: number
    hi: number
  } | null>(null)
  const [hover, setHover] = useState<{ lat: number; lon: number; km: number } | null>(
    null,
  )

  useEffect(() => {
    let cancelled = false
    api
      .demRaster(720)
      .then((d) => !cancelled && setDem(d))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const cv = ref.current
    if (!cv || !dem) return
    const w = dem.w
    const h = dem.h
    cv.width = w
    cv.height = h
    const g = cv.getContext('2d')
    if (!g) return

    // Grayscale height, tinted so it reads as terrain rather than a photo.
    const img = g.createImageData(w, h)
    for (let i = 0; i < dem.data.length; i++) {
      const v = dem.data[i]
      img.data[i * 4] = 40 + v * 0.78
      img.data[i * 4 + 1] = 44 + v * 0.74
      img.data[i * 4 + 2] = 66 + v * 0.7
      img.data[i * 4 + 3] = 255
    }
    g.putImageData(img, 0, 0)

    // The raster arrives centred on longitude 0, so -180 is the left edge and
    // the nearside sits in the middle where it belongs.
    const xOf = (lon: number) => ((((lon + 180) % 360) + 360) % 360) / 360 * w
    const yOf = (lat: number) => ((90 - lat) / 180) * h

    if (profile) {
      // The limb itself: the terrain silhouetted from this observing site.
      g.lineWidth = 2
      g.strokeStyle = 'rgba(200,220,255,0.9)'
      let prev: number | null = null
      g.beginPath()
      profile.pa_deg.forEach((_, i) => {
        const x = xOf(profile.sel_lon[i])
        const y = yOf(profile.sel_lat[i])
        // The limb track wraps in longitude; break the line rather than
        // drawing a spurious horizontal streak across the map.
        if (prev !== null && Math.abs(x - prev) > w / 2) g.moveTo(x, y)
        else if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
        prev = x
      })
      g.stroke()

      // Sub-observer point: the centre of the Moon's visible face from here.
      const sx = xOf(profile.sub_lon)
      const sy = yOf(profile.sub_lat)
      g.strokeStyle = '#f0a63c'
      g.lineWidth = 1.5
      g.beginPath()
      g.arc(sx, sy, 6, 0, Math.PI * 2)
      g.moveTo(sx - 10, sy)
      g.lineTo(sx + 10, sy)
      g.moveTo(sx, sy - 10)
      g.lineTo(sx, sy + 10)
      g.stroke()
    }

    // The valleys producing beads.
    beads.forEach((b) => {
      const x = xOf(b.sel_lon)
      const y = yOf(b.sel_lat)
      const grd = g.createRadialGradient(x, y, 0, x, y, 11)
      grd.addColorStop(0, 'rgba(255,246,222,0.95)')
      grd.addColorStop(0.45, 'rgba(240,166,60,0.55)')
      grd.addColorStop(1, 'rgba(240,166,60,0)')
      g.fillStyle = grd
      g.beginPath()
      g.arc(x, y, 11, 0, Math.PI * 2)
      g.fill()
    })
  }, [dem, profile, beads])

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = ref.current
    if (!cv || !dem) return
    const r = cv.getBoundingClientRect()
    const fx = (e.clientX - r.left) / r.width
    const fy = (e.clientY - r.top) / r.height
    const px = Math.min(dem.w - 1, Math.max(0, Math.floor(fx * dem.w)))
    const py = Math.min(dem.h - 1, Math.max(0, Math.floor(fy * dem.h)))
    const v = dem.data[py * dem.w + px]
    setHover({
      lon: ((px + 0.5) / dem.w) * 360 - 180,
      lat: 90 - ((py + 0.5) / dem.h) * 180,
      km: dem.lo + (v / 255) * (dem.hi - dem.lo),
    })
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>1 · The Moon's measured shape</h2>
        <span className="spacer" />
        <span className="mono tiny">
          {dem ? `LOLA LDEM_16 · ${dem.lo.toFixed(1)}–${dem.hi.toFixed(1)} km radius` : 'loading…'}
        </span>
      </div>
      <div className="panel-body">
        <canvas
          ref={ref}
          className="terrain"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
        <div className="explain">
          <p>
            Every populated pixel is a laser measurement of the Moon's radius.
            The pale line is the <strong>limb as seen from your site</strong> —
            the terrain silhouetted against the Sun — and the orange cross is the
            centre of the face turned toward you. Amber blooms mark the valleys
            that let your beads through.
          </p>
          <div className="hoverbox mono">
            {hover
              ? `${hover.lat >= 0 ? 'N' : 'S'}${Math.abs(hover.lat).toFixed(1)}°  ` +
                `${hover.lon >= 0 ? 'E' : 'W'}${Math.abs(hover.lon).toFixed(1)}°  ` +
                `radius ${hover.km.toFixed(2)} km`
              : 'hover the map to read a radius'}
          </div>
        </div>
      </div>
    </div>
  )
}

// --- the limb profile -------------------------------------------------------

function ProfileChart({
  profile,
  beadsByContact,
}: {
  profile: LimbProfile | null
  beadsByContact: { c2: Bead[]; c3: Bead[] }
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv || !profile) return
    const holder = cv.parentElement
    const w = Math.max(320, holder?.clientWidth || 700)
    const h = 200
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = w * dpr
    cv.height = h * dpr
    cv.style.width = `${w}px`
    cv.style.height = `${h}px`
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)

    const padL = 40
    const padB = 22
    const padT = 12
    const relief = profile.relief_km
    const lo = Math.min(...relief)
    const hi = Math.max(...relief)
    const xOf = (pa: number) => padL + (pa / 360) * (w - padL - 8)
    const yOf = (km: number) =>
      padT + (1 - (km - lo) / (hi - lo)) * (h - padT - padB)

    // Which stretch of limb each contact uses.
    const bands: [Bead[], string][] = [
      [beadsByContact.c2, 'rgba(139,107,232,0.16)'],
      [beadsByContact.c3, 'rgba(240,166,60,0.14)'],
    ]
    bands.forEach(([bs, fill]) => {
      if (!bs.length) return
      const pas = bs.map((b) => b.pa_deg)
      g.fillStyle = fill
      g.fillRect(
        xOf(Math.min(...pas) - 6),
        padT,
        xOf(Math.max(...pas) + 6) - xOf(Math.min(...pas) - 6),
        h - padT - padB,
      )
    })

    // Zero line: the 1737.4 km reference sphere.
    g.strokeStyle = 'rgba(133,147,180,0.5)'
    g.setLineDash([3, 3])
    g.beginPath()
    g.moveTo(padL, yOf(0))
    g.lineTo(w - 8, yOf(0))
    g.stroke()
    g.setLineDash([])

    g.strokeStyle = '#c8dcff'
    g.lineWidth = 1
    g.beginPath()
    profile.pa_deg.forEach((pa, i) => {
      const x = xOf(pa)
      const y = yOf(relief[i])
      i ? g.lineTo(x, y) : g.moveTo(x, y)
    })
    g.stroke()

    // Beads.
    ;[
      [beadsByContact.c2, '#8b6be8'],
      [beadsByContact.c3, '#f0a63c'],
    ].forEach(([bs, col]) => {
      ;(bs as Bead[]).forEach((b) => {
        const i =
          Math.round((b.pa_deg / 360) * profile.pa_deg.length) %
          profile.pa_deg.length
        const x = xOf(b.pa_deg)
        const y = yOf(relief[i])
        g.fillStyle = col as string
        g.beginPath()
        g.arc(x, y, 3, 0, Math.PI * 2)
        g.fill()
      })
    })

    // Axes.
    g.fillStyle = '#5c6a8c'
    g.font = "9px 'JetBrains Mono', monospace"
    g.textAlign = 'right'
    ;[hi, 0, lo].forEach((v) => g.fillText(`${v > 0 ? '+' : ''}${v.toFixed(1)}`, padL - 5, yOf(v) + 3))
    g.save()
    g.translate(11, h / 2)
    g.rotate(-Math.PI / 2)
    g.textAlign = 'center'
    g.fillText('relief, km', 0, 0)
    g.restore()
    g.textAlign = 'center'
    for (let pa = 0; pa <= 360; pa += 45) g.fillText(`${pa}°`, xOf(pa), h - 7)
    g.fillText('position angle from celestial north, eastward', w / 2, h - 0.5)

    if (hover !== null) {
      const i = Math.min(
        profile.pa_deg.length - 1,
        Math.max(0, Math.round((hover / 360) * profile.pa_deg.length)),
      )
      g.strokeStyle = 'rgba(240,166,60,0.7)'
      g.beginPath()
      g.moveTo(xOf(profile.pa_deg[i]), padT)
      g.lineTo(xOf(profile.pa_deg[i]), h - padB)
      g.stroke()
    }
  }, [profile, beadsByContact, hover])

  const hoverInfo = useMemo(() => {
    if (!profile || hover === null) return null
    const i = Math.min(
      profile.pa_deg.length - 1,
      Math.max(0, Math.round((hover / 360) * profile.pa_deg.length)),
    )
    return {
      pa: profile.pa_deg[i],
      km: profile.relief_km[i],
      lat: profile.sel_lat[i],
      lon: profile.sel_lon[i],
    }
  }, [profile, hover])

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>2 · The limb profile from your site</h2>
        <span className="spacer" />
        {profile && (
          <span className="mono tiny">
            libration {profile.sub_lat.toFixed(2)}°, {profile.sub_lon.toFixed(2)}°
          </span>
        )}
      </div>
      <div className="panel-body">
        <div className="chart-holder">
          <canvas
            ref={ref}
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              const padL = 40
              const frac = (e.clientX - r.left - padL) / (r.width - padL - 8)
              setHover(Math.max(0, Math.min(360, frac * 360)))
            }}
            onMouseLeave={() => setHover(null)}
          />
        </div>
        <div className="explain">
          <p>
            The Moon's edge, unrolled. Zero is a perfect 1737.4 km sphere; the
            wiggle is real mountains and valleys, a couple of kilometres of it.
            Shaded bands show the stretches of limb that second contact (violet)
            and third contact (amber) actually use — they are on opposite sides,
            which is why the two contacts get different beads.
          </p>
          <div className="hoverbox mono">
            {hoverInfo
              ? `PA ${hoverInfo.pa.toFixed(1)}°  relief ${hoverInfo.km >= 0 ? '+' : ''}${hoverInfo.km.toFixed(2)} km  ` +
                `at ${hoverInfo.lat >= 0 ? 'N' : 'S'}${Math.abs(hoverInfo.lat).toFixed(1)}° ` +
                `${hoverInfo.lon >= 0 ? 'E' : 'W'}${Math.abs(hoverInfo.lon).toFixed(1)}°`
              : 'hover the profile to read the limb'}
          </div>
        </div>
      </div>
    </div>
  )
}

// --- the depth field --------------------------------------------------------

function BeadMapChart({ map, beads }: { map: BeadMap | null; beads: Bead[] }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv || !map || !map.depth_asec?.length) return
    const holder = cv.parentElement
    const w = Math.max(300, holder?.clientWidth || 480)
    const h = 260
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = w * dpr
    cv.height = h * dpr
    cv.style.width = `${w}px`
    cv.style.height = `${h}px`
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)

    const padL = 44
    const padB = 26
    const padT = 10
    const plotW = w - padL - 8
    const plotH = h - padT - padB

    const nT = map.depth_asec.length
    const nP = map.depth_asec[0].length
    let maxD = 0
    for (const row of map.depth_asec) for (const v of row) if (v > maxD) maxD = v

    // Time across, position angle up. Lit cells glow; covered limb stays dark.
    const img = g.createImageData(nT, nP)
    for (let ti = 0; ti < nT; ti++) {
      for (let pi = 0; pi < nP; pi++) {
        const v = map.depth_asec[ti][pi]
        // Image rows run top-down, so flip so PA increases upward.
        const o = ((nP - 1 - pi) * nT + ti) * 4
        if (v > 0) {
          const f = Math.pow(Math.min(1, v / maxD), 0.45)
          img.data[o] = 60 + 195 * f
          img.data[o + 1] = 40 + 206 * f
          img.data[o + 2] = 20 + 190 * f
          img.data[o + 3] = 255
        } else {
          // Slight gradient below zero shows how close the limb is to letting go.
          const f = Math.min(1, -v / Math.max(1, maxD))
          img.data[o] = 12 + 10 * (1 - f)
          img.data[o + 1] = 16 + 12 * (1 - f)
          img.data[o + 2] = 32 + 18 * (1 - f)
          img.data[o + 3] = 255
        }
      }
    }
    const off = document.createElement('canvas')
    off.width = nT
    off.height = nP
    off.getContext('2d')!.putImageData(img, 0, 0)
    g.imageSmoothingEnabled = false
    g.drawImage(off, padL, padT, plotW, plotH)

    // Contact time.
    const t0 = map.t_unix[0]
    const t1 = map.t_unix[map.t_unix.length - 1]
    const xOfT = (t: number) => padL + ((t - t0) / (t1 - t0)) * plotW
    g.strokeStyle = 'rgba(255,255,255,0.55)'
    g.setLineDash([4, 3])
    g.beginPath()
    g.moveTo(xOfT(map.contact_t_unix), padT)
    g.lineTo(xOfT(map.contact_t_unix), padT + plotH)
    g.stroke()
    g.setLineDash([])

    g.fillStyle = '#5c6a8c'
    g.font = "9px 'JetBrains Mono', monospace"
    g.textAlign = 'center'
    g.fillText(
      `${map.contact.toUpperCase()} (smooth Moon)`,
      xOfT(map.contact_t_unix),
      padT - 2,
    )
    // Axes.
    const pa0 = map.pa_deg[0]
    const pa1 = map.pa_deg[map.pa_deg.length - 1]
    g.textAlign = 'right'
    ;[pa1, (pa0 + pa1) / 2, pa0].forEach((pa, k) =>
      g.fillText(`${pa.toFixed(0)}°`, padL - 5, padT + (k * plotH) / 2 + 3),
    )
    g.save()
    g.translate(11, padT + plotH / 2)
    g.rotate(-Math.PI / 2)
    g.textAlign = 'center'
    g.fillText('position angle', 0, 0)
    g.restore()
    g.textAlign = 'center'
    for (let k = 0; k <= 4; k++) {
      const t = t0 + ((t1 - t0) * k) / 4
      g.fillText(fmtLocal(t), padL + (plotW * k) / 4, h - 13)
    }
    g.fillText(
      `local time · peak ${maxD.toFixed(1)}″ of photosphere`,
      padL + plotW / 2,
      h - 2,
    )
    void beads
  }, [map, beads])

  if (!map || !map.is_total) {
    return <div className="beads-none">{map?.note ?? 'No data.'}</div>
  }
  return (
    <div className="chart-holder">
      <canvas ref={ref} />
    </div>
  )
}

// --- the tab ----------------------------------------------------------------

export function DataExplorer({
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
  const [beads, setBeads] = useState<{ c2: BeadsResult; c3: BeadsResult } | null>(null)
  const [profile, setProfile] = useState<LimbProfile | null>(null)
  const [maps, setMaps] = useState<{ c2: BeadMap | null; c3: BeadMap | null }>({
    c2: null,
    c3: null,
  })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setErr(null)
    setProfile(null)
    setMaps({ c2: null, c3: null })
    Promise.all([
      api.beads(lat, lon, elev, 'c2'),
      api.beads(lat, lon, elev, 'c3'),
    ])
      .then(async ([c2, c3]) => {
        if (cancelled) return
        setBeads({ c2, c3 })
        if (!c2.is_total) return
        const [prof, m2, m3] = await Promise.all([
          api.limb(lat, lon, elev, c2.contact_t_unix!),
          api.beadMap(lat, lon, elev, 'c2'),
          api.beadMap(lat, lon, elev, 'c3'),
        ])
        if (cancelled) return
        setProfile(prof)
        setMaps({ c2: m2, c3: m3 })
      })
      .catch((e: Error) => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setBusy(false))
    return () => {
      cancelled = true
    }
  }, [lat, lon, elev])

  const byContact = {
    c2: beads?.c2.beads ?? [],
    c3: beads?.c3.beads ?? [],
  }
  const allBeads = [...byContact.c2, ...byContact.c3]

  return (
    <div className="explorer">
      <div className="explorer-head">
        <h2>
          Lunar limb data
          {siteName && <em> · {siteName}</em>}
        </h2>
        <span className="mono tiny">
          {lat.toFixed(4)}°, {lon.toFixed(4)}° · {elev} m
        </span>
        {busy && <span className="loading">computing…</span>}
      </div>

      {err && <div className="err">{err}</div>}

      {beads && !beads.c2.is_total && (
        <div className="panel">
          <div className="panel-body">
            <ul className="notes">
              <li className="warn">{beads.c2.note}</li>
              <li>
                The limb profile below still needs a totality to be meaningful.
                Pick a site inside the violet band on the Plan tab.
              </li>
            </ul>
          </div>
        </div>
      )}

      <TerrainMap profile={profile} beads={allBeads} />

      <ProfileChart profile={profile} beadsByContact={byContact} />

      <div className="panel">
        <div className="panel-head">
          <h2>3 · Visible photosphere, angle versus time</h2>
          <span className="spacer" />
          <span className="mono tiny">
            bright = sunlight still getting through
          </span>
        </div>
        <div className="panel-body">
          <div className="map-pair">
            {(['c2', 'c3'] as const).map((k) => (
              <div key={k}>
                <h3 className="submap-title">
                  {k.toUpperCase()} ·{' '}
                  {k === 'c2' ? 'crescent breaking up' : 'first light returning'}
                </h3>
                <BeadMapChart map={maps[k]} beads={byContact[k]} />
              </div>
            ))}
          </div>
          <div className="explain">
            <p>
              This is the field the bead list is picked out of. Each bright
              streak is one valley letting sunlight through: where it sits
              vertically is its position angle on the limb, how wide it is
              horizontally is how long it lasts. Watch the crescent narrow to a
              band and then shatter into separate streaks — that break-up
              <em> is</em> Baily's beads. The dashed line is contact time for a
              perfectly smooth Moon; the real light ends when the last streak
              does, which is why the correction is not zero.
            </p>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Where this data comes from</h2>
        </div>
        <div className="panel-body">
          <table className="sources">
            <tbody>
              <tr>
                <th>Moon's shape</th>
                <td>
                  <strong>LRO LOLA LDEM_16</strong> — Lunar Orbiter Laser
                  Altimeter, dataset <span className="mono">LRO-L-LOLA-4-GDR-V1.0</span>,
                  product v3.1 from measurements 2009–2016. 5760×2880 at 16
                  pixels/degree, 1895 m/pixel.
                  <em>NASA PDS Geosciences Node</em>
                </td>
              </tr>
              <tr>
                <th>Moon's orientation</th>
                <td>
                  <strong>moon_pa_de421_1900-2050</strong> plus the{' '}
                  <span className="mono">MOON_ME_DE421</span> frame definition
                  and body constants. This is what supplies the physical
                  libration, deciding which terrain is on the limb for you.
                  <em>JPL NAIF generic kernels</em>
                </td>
              </tr>
              <tr>
                <th>Sun &amp; Moon positions</th>
                <td>
                  <strong>JPL DE421</strong>, via Skyfield — the same ephemeris
                  behind every contact time in this app.
                  <em>JPL Solar System Dynamics</em>
                </td>
              </tr>
              <tr>
                <th>Town coordinates</th>
                <td>
                  <strong>GeoNames</strong> Spain extract, 30,895 populated
                  places with elevations. <em>CC BY 4.0</em>
                </td>
              </tr>
            </tbody>
          </table>
          <ul className="notes" style={{ marginTop: 10 }}>
            <li>
              Resolution is the binding limit: 16 pixels/degree is ~1.9 km at the
              limb, about 1.1 arcsecond from Earth. Prominent beads are real,
              timings are good to roughly a second, and the faintest beads will
              be missing. The 64 pixel/degree LOLA grid would sharpen this but is
              530 MB.
            </li>
            <li>
              Fetch or refresh it all with{' '}
              <span className="mono">
                uv run python -m backend.scripts.fetch_lunar
              </span>
              , which verifies the limb relief before accepting the download.
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
