/** The saved shot list — the thing you actually hold in the field. */

import { useState } from 'react'
import type { SavedShot } from '../api'
import { CLIENT_ID, api, fmtDuration, fmtLocal, fmtObscurationPct, fmtUTC } from '../api'

export function ShotSidebar({
  shots,
  onChanged,
  now,
  onGoTo,
}: {
  shots: SavedShot[]
  onChanged: () => void
  now: number
  onGoTo: (t: number) => void
}) {
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')

  // The next shot still ahead of now, so the list orients itself on the day.
  const nextIdx = shots.findIndex((s) => s.t_unix > now)

  return (
    <>
      <div className="sidebar-head">
        <h2>Shot list</h2>
        <span className="count mono">{shots.length}</span>
        <span className="spacer" style={{ marginLeft: 'auto' }} />
        {shots.length > 0 && (
          <>
            <a
              className="btn"
              href={`/api/shots/export.csv?client=${encodeURIComponent(CLIENT_ID)}`}
              download
            >
              CSV
            </a>
            <button
              className="btn danger"
              onClick={async () => {
                if (!confirm(`Delete all ${shots.length} saved shots?`)) return
                await api.clearShots()
                onChanged()
              }}
            >
              Clear
            </button>
          </>
        )}
      </div>

      {shots.length === 0 ? (
        <div className="empty">
          <strong>Nothing saved yet</strong>
          Build a pattern below the map and add it here, or save the moment you
          are scrubbing to with “Save this moment”.
        </div>
      ) : (
        <div className="shot-list">
          {shots.map((s, i) => {
            const p = s.payload ?? {}
            const exp = p.exposure
            const total = p.phase === 'total'
            const dt = s.t_unix - now
            return (
              <div
                className={`shot${i === nextIdx ? ' next' : ''}${total ? ' is-total' : ''}`}
                key={s.id}
              >
                <div className="shot-top">
                  <button
                    className="t"
                    onClick={() => onGoTo(s.t_unix)}
                    title="Scrub the timeline to this moment"
                    style={{
                      background: 'none',
                      border: 0,
                      padding: 0,
                      cursor: 'pointer',
                      color: total ? 'var(--umbra)' : 'var(--text)',
                    }}
                  >
                    {fmtLocal(s.t_unix, true)}
                  </button>
                  <span className="lbl">{s.label || '—'}</span>
                  {exp && (
                    <span
                      className={`badge ${exp.filter ? 'filter-on' : 'filter-off'}`}
                    >
                      {exp.filter ? 'FILTER' : 'NO FILTER'}
                    </span>
                  )}
                </div>

                <div className="shot-meta">
                  <span>{fmtUTC(s.t_unix)}</span>
                  {p.obscuration !== undefined && (
                    <span>{fmtObscurationPct(p.obscuration, 2)}% covered</span>
                  )}
                  {p.sun_alt !== undefined && (
                    <span
                      style={{
                        color:
                          p.sun_alt < 0
                            ? 'var(--warn)'
                            : p.sun_alt < 3
                              ? 'var(--horizon)'
                              : undefined,
                      }}
                    >
                      alt {p.sun_alt.toFixed(2)}°
                    </span>
                  )}
                  {p.sun_az !== undefined && <span>az {p.sun_az.toFixed(1)}°</span>}
                  <span style={{ color: 'var(--faint)' }}>
                    {dt > 0 ? `in ${fmtDuration(dt)}` : fmtDuration(-dt) + ' ago'}
                  </span>
                </div>

                {p.blocked && (
                  <div className="shot-exp" style={{ color: 'var(--warn)' }}>
                    {p.blocked}
                  </div>
                )}

                {exp && (
                  <div className="shot-exp">
                    <b style={{ fontWeight: 500 }}>{exp.target}.</b> {exp.hint}
                  </div>
                )}

                <div className="shot-note">
                  {editing === s.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={async () => {
                        await api.updateShot(s.id, { note: draft })
                        setEditing(null)
                        onChanged()
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        if (e.key === 'Escape') setEditing(null)
                      }}
                      placeholder="Note to self"
                    />
                  ) : (
                    <div className="shot-actions">
                      <button
                        className="btn icon"
                        onClick={() => {
                          setDraft(s.note)
                          setEditing(s.id)
                        }}
                      >
                        {s.note ? `✎ ${s.note}` : '✎ Note'}
                      </button>
                      <span className="spacer" style={{ marginLeft: 'auto' }} />
                      <button
                        className="btn icon danger"
                        onClick={async () => {
                          await api.deleteShot(s.id)
                          onChanged()
                        }}
                        title="Remove this shot"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
