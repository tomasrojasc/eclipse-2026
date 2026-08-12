/** Click-to-choose observing site, with the umbral band drawn on top. */

import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { EclipsePath } from '../api'

export interface Site {
  lat: number
  lon: number
}

export const CITIES: { name: string; lat: number; lon: number; total: boolean }[] = [
  { name: 'A Coruña', lat: 43.3623, lon: -8.4115, total: true },
  { name: 'Oviedo', lat: 43.3619, lon: -5.8494, total: true },
  { name: 'Bilbao', lat: 43.263, lon: -2.935, total: true },
  { name: 'Burgos', lat: 42.3439, lon: -3.6969, total: true },
  { name: 'Zaragoza', lat: 41.6488, lon: -0.8891, total: true },
  { name: 'Valencia', lat: 39.4699, lon: -0.3763, total: true },
  { name: 'Palma', lat: 39.5696, lon: 2.6502, total: true },
  { name: 'Madrid', lat: 40.4168, lon: -3.7038, total: false },
  { name: 'Barcelona', lat: 41.3874, lon: 2.1686, total: false },
]

export function MapPanel({
  site,
  onPick,
  path,
  focusNonce,
}: {
  site: Site
  onPick: (s: Site) => void
  path: EclipsePath | null
  /** Bumped when the site came from search, so the map recentres. A map click
   *  leaves it alone — panning out from under the cursor is disorienting. */
  focusNonce: number
}) {
  const div = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const marker = useRef<L.Marker | null>(null)
  const overlays = useRef<L.LayerGroup | null>(null)
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick

  // Create the map once; React 19 strict mode would otherwise double-init it.
  useEffect(() => {
    if (!div.current || map.current) return
    const m = L.map(div.current, {
      center: [41.0, -3.5],
      zoom: 6,
      zoomControl: true,
      attributionControl: true,
    })
    // A dark basemap, so the umbral band is the brightest thing on the map.
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 20,
      subdomains: 'abcd',
      attribution: '© OpenStreetMap contributors © CARTO',
    }).addTo(m)
    m.on('click', (e: L.LeafletMouseEvent) => {
      onPickRef.current({ lat: e.latlng.lat, lon: e.latlng.lng })
    })
    overlays.current = L.layerGroup().addTo(m)
    map.current = m
    return () => {
      m.remove()
      map.current = null
    }
  }, [])

  // Umbral band: shaded polygon between the limits, dashed centreline.
  useEffect(() => {
    const g = overlays.current
    if (!g || !path) return
    g.clearLayers()

    const { north, south } = path.limits
    if (north.length > 1 && south.length > 1) {
      const ring: [number, number][] = [
        ...north.map((p) => [p.lat, p.lon] as [number, number]),
        ...[...south].reverse().map((p) => [p.lat, p.lon] as [number, number]),
      ]
      L.polygon(ring, {
        color: '#a98cff',
        weight: 1.5,
        opacity: 0.9,
        fillColor: '#8b6be8',
        fillOpacity: 0.3,
        interactive: false,
      })
        .addTo(g)
        .bindTooltip('Path of totality', { sticky: true })
    }

    if (path.centerline_iberia.length > 1) {
      L.polyline(
        path.centerline_iberia.map((p) => [p.lat, p.lon] as [number, number]),
        {
          color: '#c8dcff',
          weight: 1.5,
          opacity: 0.85,
          dashArray: '5 5',
          interactive: false,
        },
      )
        .addTo(g)
        .bindTooltip('Centreline — longest totality', { sticky: true })
    }

    CITIES.forEach((c) => {
      L.circleMarker([c.lat, c.lon], {
        radius: 3,
        color: c.total ? '#c8dcff' : '#8593b4',
        weight: 1,
        fillColor: c.total ? '#c8dcff' : '#3a4568',
        fillOpacity: 0.9,
      })
        .addTo(g)
        .bindTooltip(c.name, { direction: 'right', offset: [4, 0] })
    })
  }, [path])

  // Recentre only when the site was chosen by name, not by clicking.
  useEffect(() => {
    if (!map.current || focusNonce === 0) return
    map.current.flyTo([site.lat, site.lon], Math.max(map.current.getZoom(), 9), {
      duration: 0.7,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce])

  // Marker follows the selected site.
  useEffect(() => {
    const m = map.current
    if (!m) return
    const pos: L.LatLngExpression = [site.lat, site.lon]
    if (!marker.current) {
      marker.current = L.marker(pos, {
        draggable: true,
        icon: L.divIcon({
          className: '',
          html:
            '<div style="width:16px;height:16px;border-radius:50%;' +
            'background:#f0a63c;border:2px solid #fff2d0;' +
            'box-shadow:0 0 12px rgba(240,166,60,.9)"></div>',
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
      }).addTo(m)
      marker.current.on('dragend', () => {
        const p = marker.current!.getLatLng()
        onPickRef.current({ lat: p.lat, lon: p.lng })
      })
    } else {
      marker.current.setLatLng(pos)
    }
  }, [site])

  return <div ref={div} className="map" />
}
