/** Find an observing site by name, or by pasting coordinates.
 *
 * Results are annotated with what the eclipse actually does there, because
 * "Burgos" and "Madrid" look equally plausible in a list until you see that one
 * gets 111 seconds of totality and the other gets none.
 */

import { useEffect, useRef, useState } from 'react'
import type { Place, Summary } from '../api'
import { api, fmtObscurationPct } from '../api'

const key = (lat: number, lon: number) => `${lat.toFixed(3)},${lon.toFixed(3)}`

export function SiteSearch({
  onPick,
}: {
  onPick: (p: { lat: number; lon: number; elevation_m: number; name: string }) => void
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [summaries, setSummaries] = useState<Record<string, Summary>>({})
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)

  // Close when focus or the pointer leaves the widget.
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])

  // The index is local, so a short debounce is enough to stay responsive.
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setResults([])
      setErr(null)
      return
    }
    let cancelled = false
    const id = setTimeout(() => {
      api
        .placeSearch(term, 8)
        .then((r) => {
          if (cancelled) return
          setResults(r.results)
          setActive(0)
          setOpen(true)
          setErr(null)
        })
        .catch((e: Error) => !cancelled && setErr(e.message))
    }, 160)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [q])

  // Fill in the totality badges once the names are on screen.
  useEffect(() => {
    const missing = results.filter((r) => !summaries[key(r.lat, r.lon)])
    if (!missing.length) return
    let cancelled = false
    api
      .summaries(missing.map((r) => [r.lat, r.lon] as [number, number]))
      .then((rows) => {
        if (cancelled) return
        setSummaries((prev) => {
          const next = { ...prev }
          rows.forEach((s) => {
            next[key(s.lat, s.lon)] = s
          })
          return next
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [results, summaries])

  const choose = (p: Place) => {
    onPick({
      lat: p.lat,
      lon: p.lon,
      elevation_m: p.elevation_m,
      name: p.name,
    })
    setQ(p.name)
    setOpen(false)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (!open || !results.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(results[active])
    }
  }

  return (
    <div className="search" ref={box}>
      <input
        type="text"
        className="search-input"
        value={q}
        placeholder="Search a town, or paste 43.36, -5.85"
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onKeyDown={onKey}
        aria-label="Search for an observing site"
        autoComplete="off"
        spellCheck={false}
      />
      {q && (
        <button
          className="search-clear"
          onClick={() => {
            setQ('')
            setOpen(false)
          }}
          aria-label="Clear search"
        >
          ✕
        </button>
      )}

      {open && (err || results.length > 0 || q.trim().length >= 2) && (
        <div className="search-results" role="listbox">
          {err && <div className="search-err">{err}</div>}
          {!err && results.length === 0 && (
            <div className="search-empty">
              No town matches “{q.trim()}”. Try fewer letters, or click the map.
            </div>
          )}
          {results.map((r, i) => {
            const s = summaries[key(r.lat, r.lon)]
            return (
              <button
                key={`${r.name}-${r.lat}-${r.lon}`}
                className={`search-row${i === active ? ' active' : ''}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(r)}
              >
                <span className="sr-name">{r.name}</span>
                <span className="sr-region">
                  {r.region}
                  {r.elevation_m ? ` · ${r.elevation_m} m` : ''}
                </span>
                {s ? (
                  s.is_total ? (
                    <span className="sr-badge total">
                      {s.totality_seconds!.toFixed(0)} s totality
                    </span>
                  ) : s.has_eclipse ? (
                    <span className="sr-badge partial">
                      {fmtObscurationPct(s.max_obscuration!)}% partial
                    </span>
                  ) : (
                    <span className="sr-badge none">no eclipse</span>
                  )
                ) : (
                  <span className="sr-badge pending">…</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
