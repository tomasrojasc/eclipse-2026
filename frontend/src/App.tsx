import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Bead, Circumstances, Frame, SavedShot, SeriesResponse, EclipsePath } from './api'
import { ANCHOR_LABELS, api, fmtDuration, fmtLocal, fmtObscurationPct, fmtUTC } from './api'
import { AltitudeGauge, SkyView } from './components/SkyView'
import { CITIES, MapPanel } from './components/MapPanel'
import type { Site } from './components/MapPanel'
import { Timeline } from './components/Timeline'
import { PatternBuilder } from './components/PatternBuilder'
import { BeadsPanel } from './components/BeadsPanel'
import { DataExplorer } from './components/DataExplorer'
import { MoonGlobe } from './components/MoonGlobe'
import { FlatLimb } from './components/FlatLimb'
import { ShotSidebar } from './components/ShotSidebar'
import { SiteSearch } from './components/SiteSearch'

const CONTACTS = ['c1', 'c2', 'max', 'c3', 'c4'] as const

export default function App() {
  const [site, setSite] = useState<Site>({ lat: 43.3619, lon: -5.8494 })
  const [elev, setElev] = useState(0)
  const [data, setData] = useState<SeriesResponse | null>(null)
  const [path, setPath] = useState<EclipsePath | null>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(60)
  const [orientation, setOrientation] = useState<'zenith' | 'north'>('zenith')
  const [shots, setShots] = useState<SavedShot[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now() / 1000)
  const [siteName, setSiteName] = useState('Oviedo')
  // Bumped only when the site is chosen by name, so the map recentres then and
  // stays put when you are clicking around it.
  const [focusNonce, setFocusNonce] = useState(0)
  const [beads, setBeads] = useState<Bead[]>([])
  const [tab, setTab] = useState<'plan' | 'data' | 'globe'>('plan')
  const [view3d, setView3d] = useState<'globe' | 'flat'>('globe')

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    api.path().then(setPath).catch(() => {})
  }, [])

  const refreshShots = useCallback(() => {
    api.shots().then(setShots).catch(() => {})
  }, [])

  useEffect(refreshShots, [refreshShots])

  // Fetch the whole eclipse for this site in one go, so scrubbing is local.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    setPlaying(false)
    api
      .series(site.lat, site.lon, elev)
      .then((d) => {
        if (cancelled) return
        setData(d)
        // Land on greatest eclipse: the moment everything else hangs off.
        const t = d.circumstances.max?.t_unix
        const i = t
          ? d.frames.reduce(
              (best, f, j) =>
                Math.abs(f.t_unix - t) < Math.abs(d.frames[best].t_unix - t) ? j : best,
              0,
            )
          : Math.floor(d.frames.length / 2)
        setIndex(i)
      })
      .catch((e: Error) => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [site.lat, site.lon, elev])

  // Beads for both contacts, so the sky view can light them up on the scrubber.
  useEffect(() => {
    let cancelled = false
    setBeads([])
    Promise.all([
      api.beads(site.lat, site.lon, elev, 'c2'),
      api.beads(site.lat, site.lon, elev, 'c3'),
    ])
      .then(([a, b]) => {
        if (!cancelled) setBeads([...a.beads, ...b.beads])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [site.lat, site.lon, elev])

  const frames: Frame[] = data?.frames ?? []
  const circ: Circumstances | null = data?.circumstances ?? null
  const frame: Frame | null = frames[index] ?? null

  const goToTime = useCallback(
    (t: number) => {
      if (!frames.length) return
      setPlaying(false)
      let best = 0
      let bd = Infinity
      frames.forEach((f, i) => {
        const d = Math.abs(f.t_unix - t)
        if (d < bd) {
          bd = d
          best = i
        }
      })
      setIndex(best)
    },
    [frames],
  )

  const pickNamed = useCallback(
    (p: { lat: number; lon: number; elevation_m: number; name: string }) => {
      setSite({ lat: p.lat, lon: p.lon })
      setElev(p.elevation_m || 0)
      setSiteName(p.name)
      setFocusNonce((n) => n + 1)
    },
    [],
  )

  const pickFromMap = useCallback((s: Site) => {
    setSite(s)
    setSiteName('')
  }, [])

  const activeCity = useMemo(
    () =>
      CITIES.find(
        (c) =>
          Math.abs(c.lat - site.lat) < 0.02 && Math.abs(c.lon - site.lon) < 0.02,
      ),
    [site],
  )

  const saveMoment = async () => {
    if (!frame) return
    const t2 = circ?.events?.c2?.t_unix
    const t3 = circ?.events?.c3?.t_unix
    let label = 'Marked moment'
    if (frame.phase === 'total') label = 'During totality'
    else if (t2 && Math.abs(frame.t_unix - t2) < 20) label = 'Near C2'
    else if (t3 && Math.abs(frame.t_unix - t3) < 20) label = 'Near C3'
    else label = `${fmtObscurationPct(frame.obscuration)}% covered`

    const filterOff =
      frame.phase === 'total' ||
      (t2 !== undefined && Math.abs(frame.t_unix - t2) <= 20) ||
      (t3 !== undefined && Math.abs(frame.t_unix - t3) <= 20)

    await api.addShot({
      lat: site.lat,
      lon: site.lon,
      elev_m: elev,
      t_unix: frame.t_unix,
      label,
      payload: {
        phase: frame.phase,
        obscuration: frame.obscuration,
        magnitude: frame.magnitude,
        sun_alt: frame.sun_alt,
        sun_az: frame.sun_az,
        exposure: {
          target: filterOff ? 'Unfiltered — corona / beads' : 'Partial phase, filter ON',
          hint: filterOff
            ? 'ISO 200, f/8 — bracket 1/2000 s to 1 s.'
            : 'ISO 100, f/8, ~1/125 s through an ND5 solar filter.',
          filter: !filterOff,
        },
        ...(frame.sun_alt_geometric < 0
          ? { blocked: 'Sun is below the horizon at this time.' }
          : {}),
      },
    })
    refreshShots()
  }

  const eclipseT = circ?.max?.t_unix
  const untilEclipse = eclipseT ? eclipseT - now : null

  return (
    <div className="app">
      <header className="masthead">
        <h1>
          Ephem<em>eris</em>
        </h1>
        <span className="date">
          TOTAL SOLAR ECLIPSE · 12 AUGUST 2026 · SPAIN
        </span>
        <nav className="tabs" role="tablist" aria-label="View">
          <button
            role="tab"
            aria-selected={tab === 'plan'}
            onClick={() => setTab('plan')}
          >
            Plan
          </button>
          <button
            role="tab"
            aria-selected={tab === 'data'}
            onClick={() => setTab('data')}
          >
            Limb data
          </button>
          <button
            role="tab"
            aria-selected={tab === 'globe'}
            onClick={() => setTab('globe')}
          >
            3D
          </button>
        </nav>
        <span className="countdown">
          {untilEclipse !== null &&
            (untilEclipse > 0 ? (
              <>
                greatest eclipse here in <b>{fmtDuration(untilEclipse)}</b>
              </>
            ) : (
              <>greatest eclipse was {fmtDuration(-untilEclipse)} ago</>
            ))}
        </span>
      </header>

      <main className="main">
        {err && <div className="err">Could not reach the backend — {err}</div>}

        {tab === 'globe' && (
          <>
            <div className="view-switch" role="group" aria-label="Projection">
              <button
                aria-pressed={view3d === 'globe'}
                onClick={() => setView3d('globe')}
                title="The Moon as a sphere, orbitable"
              >
                Globe · 3D
              </button>
              <button
                aria-pressed={view3d === 'flat'}
                onClick={() => setView3d('flat')}
                title="Limb straightened out, relief magnified on its own"
              >
                Flat limb · relief only
              </button>
            </div>
            {view3d === 'globe' ? (
              <MoonGlobe
                lat={site.lat}
                lon={site.lon}
                elev={elev}
                siteName={siteName}
              />
            ) : (
              <FlatLimb
                lat={site.lat}
                lon={site.lon}
                elev={elev}
                siteName={siteName}
              />
            )}
          </>
        )}

        {tab === 'data' && (
          <DataExplorer
            lat={site.lat}
            lon={site.lon}
            elev={elev}
            siteName={siteName}
          />
        )}

        <div hidden={tab !== 'plan'} className="tabpane">

        {/* Site + sky, side by side: the choice and its consequence. */}
        <div className="row">
          <div className="panel grow">
            <div className="panel-head">
              <h2>Observing site</h2>
              <span className="spacer" />
              {siteName && <span className="site-name">{siteName}</span>}
              <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                {site.lat.toFixed(4)}°, {site.lon.toFixed(4)}°
              </span>
            </div>
            <div className="panel-body" style={{ paddingBottom: 8 }}>
              <SiteSearch onPick={pickNamed} />
              <MapPanel
                site={site}
                onPick={pickFromMap}
                path={path}
                focusNonce={focusNonce}
              />
              <p className="map-hint" style={{ padding: '8px 0 10px' }}>
                Click the map or drag the pin. The violet band is where totality
                is visible; the dashed line runs down its centre.
              </p>
              <div className="city-chips">
                {CITIES.map((c) => (
                  <button
                    key={c.name}
                    className={`chip${activeCity?.name === c.name ? ' on' : ''}`}
                    onClick={() =>
                      pickNamed({
                        lat: c.lat,
                        lon: c.lon,
                        elevation_m: elev,
                        name: c.name,
                      })
                    }
                    title={c.total ? 'Inside the path of totality' : 'Partial only'}
                  >
                    {c.name}
                    {!c.total && ' ·'}
                  </button>
                ))}
                <label
                  className="chip"
                  style={{ display: 'flex', alignItems: 'center', gap: 5 }}
                >
                  Elev
                  <input
                    type="number"
                    value={elev}
                    onChange={(e) => setElev(Number(e.target.value) || 0)}
                    style={{ width: 58, padding: '0 4px', fontSize: 11 }}
                    step={50}
                  />
                  m
                </label>
              </div>
            </div>
          </div>

          <div className="panel grow stretch">
            <div className="panel-head">
              <h2>The sky at this moment</h2>
              <span className="spacer" />
              <div className="orient" role="group" aria-label="Frame orientation">
                <button
                  aria-pressed={orientation === 'zenith'}
                  onClick={() => setOrientation('zenith')}
                  title="As a horizon-levelled camera sees it"
                >
                  Zenith up
                </button>
                <button
                  aria-pressed={orientation === 'north'}
                  onClick={() => setOrientation('north')}
                  title="As an equatorially mounted scope sees it"
                >
                  North up
                </button>
              </div>
            </div>
            <div className="panel-body fill">
              <div className="sky-wrap">
                <SkyView frame={frame} orientation={orientation} beads={beads} />
                <AltitudeGauge frame={frame} frames={frames} circ={circ} />
              </div>
            </div>
          </div>
        </div>

        {/* Readouts for the scrubbed instant. */}
        <div className="panel">
          <div className="panel-head">
            <h2>Timeline</h2>
            <span className="spacer" />
            {loading && <span className="loading">computing…</span>}
            <button className="btn" onClick={saveMoment} disabled={!frame}>
              ★ Save this moment
            </button>
          </div>
          <div className="panel-body">
            <Timeline
              frames={frames}
              index={index}
              onIndex={setIndex}
              playing={playing}
              onPlaying={setPlaying}
              speed={speed}
              onSpeed={setSpeed}
              circ={circ}
            />
          </div>

          <div className="readouts">
            <div className="readout hot">
              <div className="k">Local time · CEST</div>
              <div className="v">{frame ? fmtLocal(frame.t_unix, true) : '—'}</div>
            </div>
            <div className="readout">
              <div className="k">UTC</div>
              <div className="v" style={{ fontSize: 15 }}>
                {frame ? fmtUTC(frame.t_unix) : '—'}
              </div>
            </div>
            <div
              className={`readout${frame?.phase === 'total' ? ' total' : ''}`}
            >
              <div className="k">Sun covered</div>
              <div className="v">
                {frame ? fmtObscurationPct(frame.obscuration, 2) : '—'}
                <small>%</small>
              </div>
            </div>
            <div
              className={`readout${
                frame && frame.sun_alt_geometric < 0
                  ? ' bad'
                  : frame && frame.sun_alt < 3
                    ? ' hot'
                    : ''
              }`}
            >
              <div className="k">Sun altitude</div>
              <div className="v">
                {frame ? frame.sun_alt.toFixed(2) : '—'}
                <small>°</small>
              </div>
            </div>
            <div className="readout">
              <div className="k">Sun azimuth</div>
              <div className="v">
                {frame ? frame.sun_az.toFixed(1) : '—'}
                <small>°</small>
              </div>
            </div>
            <div className="readout">
              <div className="k">Phase</div>
              <div
                className="v"
                style={{
                  fontSize: 14,
                  color:
                    frame?.phase === 'total' ? 'var(--umbra)' : undefined,
                }}
              >
                {frame
                  ? frame.phase === 'none'
                    ? 'uneclipsed'
                    : frame.phase
                  : '—'}
              </div>
            </div>
          </div>
        </div>

        {/* Contact sequence — a real ordered sequence, so numbered as one. */}
        <div className="panel">
          <div className="panel-head">
            <h2>Contacts at this site</h2>
            <span className="spacer" />
            {circ && (
              <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                {circ.is_total
                  ? `totality ${circ.totality_seconds?.toFixed(1)} s`
                  : `partial only — peak ${fmtObscurationPct(circ.max_obscuration ?? 0, 2)}%`}
              </span>
            )}
          </div>
          <div className="contacts">
            {CONTACTS.map((k) => {
              const f = circ?.events?.[k]
              const isTot = k === 'c2' || k === 'c3'
              return (
                <button
                  key={k}
                  className={`contact${isTot ? ' is-total' : ''}${k === 'max' ? ' is-max' : ''}`}
                  disabled={!f}
                  onClick={() => f && goToTime(f.t_unix)}
                  title={f ? `Scrub to ${ANCHOR_LABELS[k]}` : 'Does not occur here'}
                >
                  <div className="id">{ANCHOR_LABELS[k]}</div>
                  <div className="time">{f ? fmtLocal(f.t_unix, true) : '——:——'}</div>
                  <div className="sub">
                    {f
                      ? `alt ${f.sun_alt.toFixed(2)}° · ${fmtObscurationPct(f.obscuration)}%`
                      : 'no totality here'}
                  </div>
                </button>
              )
            })}
          </div>
          {circ && circ.notes.length > 0 && (
            <div className="panel-body">
              <ul className="notes">
                {circ.notes.map((n, i) => (
                  <li
                    key={i}
                    className={
                      /below the horizon|only|Partial eclipse only/.test(n)
                        ? 'warn'
                        : ''
                    }
                  >
                    {n}
                  </li>
                ))}
                {circ.sun_set_unix && (
                  <li>Sun sets at {fmtLocal(circ.sun_set_unix)} CEST.</li>
                )}
              </ul>
            </div>
          )}
        </div>

        <BeadsPanel
          lat={site.lat}
          lon={site.lon}
          elev={elev}
          onGoTo={goToTime}
          onSaved={refreshShots}
        />

        <PatternBuilder
          lat={site.lat}
          lon={site.lon}
          elev={elev}
          onCommitted={refreshShots}
        />
        </div>
      </main>

      <aside className="sidebar">
        <ShotSidebar
          shots={shots}
          onChanged={refreshShots}
          now={now}
          onGoTo={goToTime}
        />
      </aside>
    </div>
  )
}
