/** Scrub through the eclipse. Playback is in eclipse-time, not wall-clock. */

import { useEffect, useRef } from 'react'
import type { Circumstances, Frame } from '../api'
import { fmtLocal } from '../api'

const SPEEDS = [1, 10, 60, 300]

export function Timeline({
  frames,
  index,
  onIndex,
  playing,
  onPlaying,
  speed,
  onSpeed,
  circ,
}: {
  frames: Frame[]
  index: number
  onIndex: (i: number) => void
  playing: boolean
  onPlaying: (p: boolean) => void
  speed: number
  onSpeed: (s: number) => void
  circ: Circumstances | null
}) {
  const raf = useRef<number>(0)
  const last = useRef<number>(0)
  // Fractional position carried across frames so slow playback still advances.
  const pos = useRef<number>(index)

  useEffect(() => {
    pos.current = index
  }, [index])

  useEffect(() => {
    if (!playing || frames.length < 2) return
    last.current = performance.now()

    const tick = (now: number) => {
      const dtWall = (now - last.current) / 1000
      last.current = now
      // Advance by eclipse-seconds, converted to frame steps via local spacing.
      const i = Math.floor(pos.current)
      const next = Math.min(i + 1, frames.length - 1)
      const spacing = Math.max(
        0.001,
        frames[next].t_unix - frames[i].t_unix || 1,
      )
      pos.current += (dtWall * speed) / spacing
      if (pos.current >= frames.length - 1) {
        pos.current = frames.length - 1
        onIndex(frames.length - 1)
        onPlaying(false)
        return
      }
      onIndex(Math.floor(pos.current))
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [playing, speed, frames, onIndex, onPlaying])

  const nearestTo = (t: number) => {
    let best = 0
    let bd = Infinity
    frames.forEach((f, i) => {
      const d = Math.abs(f.t_unix - t)
      if (d < bd) {
        bd = d
        best = i
      }
    })
    return best
  }

  const t0 = frames[0]?.t_unix ?? 0
  const t1 = frames[frames.length - 1]?.t_unix ?? 1
  const pct = (t: number) => ((t - t0) / (t1 - t0)) * 100

  const c2 = circ?.events?.c2
  const c3 = circ?.events?.c3

  const ticks = (['c1', 'c2', 'max', 'c3', 'c4'] as const)
    .map((k) => ({ k, f: circ?.events?.[k] }))
    .filter((x): x is { k: typeof x.k; f: Frame } => !!x.f)

  // Totality is ~90 s inside a ~110 min eclipse, so C2/MAX/C3 land almost on
  // top of each other. Keep every tick mark, but only label the ones that have
  // room, otherwise the three captions overprint into nonsense.
  const MIN_LABEL_GAP_PCT = 4
  let lastLabelled = -Infinity
  const labelled = new Set<string>()
  for (const { k, f } of ticks) {
    const x = pct(f.t_unix)
    if (x - lastLabelled >= MIN_LABEL_GAP_PCT) {
      labelled.add(k)
      lastLabelled = x
    }
  }

  return (
    <div className="timeline">
      <div className="scrub-wrap">
        <div className="scrub-ticks">
          {ticks.map(({ k, f }) => (
            <span
              key={k}
              className={`scrub-tick${k === 'c2' || k === 'c3' ? ' tot' : ''}`}
              style={{ left: `${pct(f.t_unix)}%` }}
              title={`${k.toUpperCase()} — ${fmtLocal(f.t_unix)}`}
            >
              {labelled.has(k) ? k.toUpperCase() : ''}
            </span>
          ))}
        </div>
        {c2 && c3 && (
          <div
            className="scrub-band"
            style={{
              left: `${pct(c2.t_unix)}%`,
              width: `${Math.max(0.6, pct(c3.t_unix) - pct(c2.t_unix))}%`,
            }}
          />
        )}
        <input
          type="range"
          min={0}
          max={Math.max(0, frames.length - 1)}
          value={index}
          onChange={(e) => {
            onPlaying(false)
            onIndex(Number(e.target.value))
          }}
          aria-label="Eclipse time"
        />
      </div>

      <div className="transport">
        <button
          className="btn primary"
          onClick={() => onPlaying(!playing)}
          disabled={frames.length < 2}
        >
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <div className="speeds" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              aria-pressed={speed === s}
              onClick={() => onSpeed(s)}
              title={`${s}× eclipse time`}
            >
              {s}×
            </button>
          ))}
        </div>
        <button
          className="btn icon"
          onClick={() => {
            onPlaying(false)
            onIndex(Math.max(0, index - 1))
          }}
          title="Previous sample"
        >
          ◀
        </button>
        <button
          className="btn icon"
          onClick={() => {
            onPlaying(false)
            onIndex(Math.min(frames.length - 1, index + 1))
          }}
          title="Next sample"
        >
          ▶
        </button>
        <span className="spacer" style={{ marginLeft: 'auto' }} />
        {ticks.map(({ k, f }) => (
          <button
            key={k}
            className="btn ghost"
            onClick={() => {
              onPlaying(false)
              onIndex(nearestTo(f.t_unix))
            }}
            title={`Jump to ${k.toUpperCase()} — ${fmtLocal(f.t_unix)}`}
          >
            {k.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  )
}
