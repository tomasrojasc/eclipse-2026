/** Define the shot pattern, preview the exact times, then commit them. */

import { useEffect, useState } from 'react'
import type { PlanResponse, Preset, Rule, RuleKind, SavedPattern } from '../api'
import { api, fmtLocal, fmtObscurationPct } from '../api'

const ANCHORS: Rule['anchor'][] = ['c1', 'c2', 'max', 'c3', 'c4']

const KIND_LABELS: Record<RuleKind, string> = {
  obscuration_steps: 'Coverage steps',
  anchor_offsets: 'Offsets from a contact',
  interval: 'Fixed cadence',
  totality_bracket: 'Spread across totality',
}

let seq = 0
const newId = () => `r${Date.now().toString(36)}${seq++}`

function blankRule(kind: RuleKind): Rule {
  const base = { id: newId(), kind, label: KIND_LABELS[kind] }
  switch (kind) {
    case 'obscuration_steps':
      return { ...base, percents: [25, 50, 75], branch: 'both' }
    case 'anchor_offsets':
      return { ...base, anchor: 'c2', offsets_s: [-2, 2] }
    case 'interval':
      return { ...base, from_anchor: 'c1', to_anchor: 'c4', every_s: 300 }
    case 'totality_bracket':
      return { ...base, count: 5, inset_s: 3 }
  }
}

const numList = (s: string) =>
  s
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x))

export function PatternBuilder({
  lat,
  lon,
  elev,
  onCommitted,
}: {
  lat: number
  lon: number
  elev: number
  onCommitted: () => void
}) {
  const [rules, setRules] = useState<Rule[]>([blankRule('obscuration_steps')])
  const [plan, setPlan] = useState<PlanResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [presets, setPresets] = useState<Preset[]>([])
  const [saved, setSaved] = useState<SavedPattern[]>([])
  const [name, setName] = useState('')

  useEffect(() => {
    api.presets().then(setPresets).catch(() => {})
    refreshSaved()
  }, [])

  const refreshSaved = () => {
    api.patterns().then(setSaved).catch(() => {})
  }

  // Re-plan whenever the rules or the site change: the times are meaningless
  // if they lag behind the coordinates on screen.
  useEffect(() => {
    if (!rules.length) {
      setPlan(null)
      return
    }
    let cancelled = false
    setBusy(true)
    setErr(null)
    api
      .plan(lat, lon, elev, rules)
      .then((p) => {
        if (!cancelled) setPlan(p)
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message)
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [rules, lat, lon, elev])

  const patch = (id: string, up: Partial<Rule>) =>
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...up } : r)))

  const commit = async () => {
    if (!plan?.shots.length) return
    setBusy(true)
    try {
      await api.addShots(
        plan.shots.map((s) => ({
          lat,
          lon,
          elev_m: elev,
          t_unix: s.t_unix,
          label: s.label,
          note: '',
          payload: {
            phase: s.phase,
            obscuration: s.obscuration,
            magnitude: s.magnitude,
            sun_alt: s.sun_alt,
            sun_az: s.sun_az,
            exposure: s.exposure,
            blocked: s.blocked,
          },
        })),
      )
      onCommitted()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Shot pattern</h2>
        <span className="spacer" />
        <select
          value=""
          onChange={(e) => {
            const p = presets.find((x) => x.name === e.target.value)
            if (p) setRules(p.rules.map((r) => ({ ...r, id: newId() })))
          }}
          style={{ width: 210 }}
          aria-label="Load a preset pattern"
        >
          <option value="">Load a preset…</option>
          {presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        {saved.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const p = saved.find((x) => String(x.id) === e.target.value)
              if (p) setRules(p.rules.map((r) => ({ ...r, id: newId() })))
            }}
            style={{ width: 150 }}
            aria-label="Load a saved pattern"
          >
            <option value="">Your patterns…</option>
            {saved.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="panel-body">
        <div className="rules">
          {rules.map((r) => (
            <div className="rule" key={r.id}>
              <div className="rule-head">
                <span className="kind">{KIND_LABELS[r.kind]}</span>
                <input
                  type="text"
                  value={r.label}
                  onChange={(e) => patch(r.id, { label: e.target.value })}
                  aria-label="Rule name"
                />
                <button
                  className="btn icon danger"
                  onClick={() => setRules((rs) => rs.filter((x) => x.id !== r.id))}
                  title="Remove this rule"
                >
                  ✕
                </button>
              </div>

              <div className="rule-grid">
                {r.kind === 'obscuration_steps' && (
                  <>
                    <div>
                      <label className="field">Coverage %</label>
                      <input
                        type="text"
                        className="mono"
                        defaultValue={(r.percents ?? []).join(', ')}
                        onBlur={(e) =>
                          patch(r.id, { percents: numList(e.target.value) })
                        }
                      />
                    </div>
                    <div>
                      <label className="field">Side</label>
                      <select
                        value={r.branch ?? 'both'}
                        onChange={(e) =>
                          patch(r.id, { branch: e.target.value as Rule['branch'] })
                        }
                      >
                        <option value="both">Both sides</option>
                        <option value="ingress">Waxing only</option>
                        <option value="egress">Waning only</option>
                      </select>
                    </div>
                  </>
                )}

                {r.kind === 'anchor_offsets' && (
                  <>
                    <div>
                      <label className="field">Contact</label>
                      <select
                        value={r.anchor ?? 'c2'}
                        onChange={(e) =>
                          patch(r.id, { anchor: e.target.value as Rule['anchor'] })
                        }
                      >
                        {ANCHORS.map((a) => (
                          <option key={a} value={a}>
                            {a!.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="field">Offsets, seconds</label>
                      <input
                        type="text"
                        className="mono"
                        defaultValue={(r.offsets_s ?? []).join(', ')}
                        onBlur={(e) =>
                          patch(r.id, { offsets_s: numList(e.target.value) })
                        }
                      />
                    </div>
                  </>
                )}

                {r.kind === 'interval' && (
                  <>
                    <div>
                      <label className="field">From</label>
                      <select
                        value={r.from_anchor ?? 'c1'}
                        onChange={(e) =>
                          patch(r.id, {
                            from_anchor: e.target.value as Rule['from_anchor'],
                          })
                        }
                      >
                        {ANCHORS.map((a) => (
                          <option key={a} value={a}>
                            {a!.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="field">To</label>
                      <select
                        value={r.to_anchor ?? 'c4'}
                        onChange={(e) =>
                          patch(r.id, {
                            to_anchor: e.target.value as Rule['to_anchor'],
                          })
                        }
                      >
                        {ANCHORS.map((a) => (
                          <option key={a} value={a}>
                            {a!.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="field">Every, seconds</label>
                      <input
                        type="number"
                        className="mono"
                        min={1}
                        value={r.every_s ?? 300}
                        onChange={(e) =>
                          patch(r.id, { every_s: Number(e.target.value) })
                        }
                      />
                    </div>
                  </>
                )}

                {r.kind === 'totality_bracket' && (
                  <>
                    <div>
                      <label className="field">Frames</label>
                      <input
                        type="number"
                        className="mono"
                        min={1}
                        max={60}
                        value={r.count ?? 5}
                        onChange={(e) =>
                          patch(r.id, { count: Number(e.target.value) })
                        }
                      />
                    </div>
                    <div>
                      <label className="field">Keep clear of edges, s</label>
                      <input
                        type="number"
                        className="mono"
                        min={0}
                        value={r.inset_s ?? 3}
                        onChange={(e) =>
                          patch(r.id, { inset_s: Number(e.target.value) })
                        }
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="add-rule">
          {(Object.keys(KIND_LABELS) as RuleKind[]).map((k) => (
            <button
              key={k}
              className="btn"
              onClick={() => setRules((rs) => [...rs, blankRule(k)])}
            >
              + {KIND_LABELS[k]}
            </button>
          ))}
        </div>

        {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}

        {plan && plan.warnings.length > 0 && (
          <ul className="notes" style={{ marginTop: 10 }}>
            {plan.warnings.map((wn, i) => (
              <li key={i} className="warn">
                {wn}
              </li>
            ))}
          </ul>
        )}

        {plan && plan.shots.length > 0 && (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                margin: '12px 0 6px',
              }}
            >
              <span className="field" style={{ margin: 0 }}>
                {plan.shots.length} shots
              </span>
              <span className="spacer" style={{ marginLeft: 'auto' }} />
              <input
                type="text"
                placeholder="Name this pattern"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ width: 160 }}
              />
              <button
                className="btn"
                disabled={!name.trim()}
                onClick={async () => {
                  await api.savePattern(name.trim(), rules)
                  setName('')
                  refreshSaved()
                }}
              >
                Save pattern
              </button>
              <button className="btn primary" onClick={commit} disabled={busy}>
                Add {plan.shots.length} to shot list
              </button>
            </div>

            <div className="preview-list">
              {plan.shots.map((s, i) => (
                <div
                  className={`preview-row${s.blocked ? ' blocked' : ''}`}
                  key={`${s.t_unix}-${i}`}
                >
                  <span className="t">{fmtLocal(s.t_unix, true)}</span>
                  <span>{s.label}</span>
                  <span className="mono" style={{ color: 'var(--muted)', fontSize: 11 }}>
                    {fmtObscurationPct(s.obscuration, 2)}% · {s.sun_alt.toFixed(1)}°
                  </span>
                  {s.blocked ? (
                    <span className="badge bad" title={s.blocked}>
                      NO SUN
                    </span>
                  ) : (
                    <span
                      className={`badge ${s.exposure.filter ? 'filter-on' : 'filter-off'}`}
                    >
                      {s.exposure.filter ? 'FILTER' : 'NO FILTER'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {plan && plan.shots.length === 0 && !busy && (
          <div className="empty" style={{ padding: '18px 0 4px' }}>
            No shots yet. Add a rule, or load a preset.
          </div>
        )}
      </div>
    </div>
  )
}
