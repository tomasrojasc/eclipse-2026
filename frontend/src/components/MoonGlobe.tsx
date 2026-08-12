/** The eclipse in three dimensions, built from the real lunar shape.
 *
 * The Moon is a sphere displaced by LOLA altimetry; the Sun is a sphere at its
 * true distance and radius; the camera starts exactly where you will be standing.
 * All three come from the backend in the Moon's body-fixed frame in kilometres,
 * so nothing here has to reconstruct the geometry — it just places objects and
 * the beads fall out of the silhouette on their own.
 *
 * Scene units are 1000 km, which keeps the numbers manageable across a range
 * from a 1.7-unit Moon to a Sun 151,000 units away.
 */

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { MoonScene } from '../api'
import { api, fmtLocal } from '../api'

const KM = 1 / 1000 // km -> scene units

/** Mesh resolution. 1024x512 keeps the limb crisp without a million vertices. */
const N_LON = 1024
const N_LAT = 512

type Dem = { data: Int16Array; w: number; h: number; scale: number; offset: number }

/** Bilinear sample of the DEM, in km of radius. Longitude is -180 at column 0. */
function sampleRadiusKm(dem: Dem, latDeg: number, lonDeg: number): number {
  const fx = ((((lonDeg + 180) % 360) + 360) % 360) / 360 * dem.w - 0.5
  const fy = ((90 - latDeg) / 180) * dem.h - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.max(0, Math.min(dem.h - 1, Math.floor(fy)))
  const y1 = Math.max(0, Math.min(dem.h - 1, y0 + 1))
  const tx = fx - x0
  const ty = fy - y0
  const xa = ((x0 % dem.w) + dem.w) % dem.w
  const xb = (xa + 1) % dem.w
  const v = (r: number, c: number) => dem.data[r * dem.w + c]
  const top = v(y0, xa) * (1 - tx) + v(y0, xb) * tx
  const bot = v(y1, xa) * (1 - tx) + v(y1, xb) * tx
  const dn = top * (1 - ty) + bot * ty
  return (dn * dem.scale + dem.offset) / 1000
}

type Patch = Dem & {
  latTop: number
  latBottom: number
  lonLeft: number
  lonRight: number
}

/** High-resolution mesh of just the limb stretch that makes the beads.
 *
 * The global sphere is meshed far coarser than the altimetry, so zooming into
 * its silhouette would show a smoothed edge and invent beads. This patch is one
 * vertex per DEM pixel, so at close range the silhouette is the real one. */
function buildPatch(
  patch: Patch,
  meanRadiusKm: number,
  exaggeration: number,
) {
  const { w, h } = patch
  const positions = new Float32Array(w * h * 3)
  const colors = new Float32Array(w * h * 3)
  const dLat = (patch.latTop - patch.latBottom) / Math.max(1, h - 1)
  const dLon = (patch.lonRight - patch.lonLeft) / Math.max(1, w - 1)
  let p = 0
  let c = 0
  for (let i = 0; i < h; i++) {
    const lat = patch.latTop - dLat * i
    const la = (lat * Math.PI) / 180
    for (let j = 0; j < w; j++) {
      const lon = patch.lonLeft + dLon * j
      const lo2 = (lon * Math.PI) / 180
      const rTrue =
        (patch.data[i * w + j] * patch.scale + patch.offset) / 1000
      const r = (meanRadiusKm + (rTrue - meanRadiusKm) * exaggeration) * KM
      positions[p++] = r * Math.cos(la) * Math.cos(lo2)
      positions[p++] = r * Math.cos(la) * Math.sin(lo2)
      positions[p++] = r * Math.sin(la)
      const f = Math.max(0, Math.min(1, (rTrue - (meanRadiusKm - 5)) / 12))
      colors[c++] = 0.26 + 0.64 * f
      colors[c++] = 0.27 + 0.61 * f
      colors[c++] = 0.34 + 0.54 * f
    }
  }
  const indices: number[] = []
  for (let i = 0; i < h - 1; i++) {
    for (let j = 0; j < w - 1; j++) {
      const a = i * w + j
      indices.push(a, a + w, a + 1, a + 1, a + w, a + w + 1)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

/** Sphere displaced by real topography, with relief optionally exaggerated.
 *
 *  `biasKm` sinks the whole sphere slightly so the high-resolution patch always
 *  wins at the silhouette. The interior of the disc is unlit at totality, so a
 *  half-kilometre shift there is invisible. */
function buildMoon(
  dem: Dem,
  meanRadiusKm: number,
  exaggeration: number,
  biasKm = 0,
) {
  const positions = new Float32Array((N_LAT + 1) * (N_LON + 1) * 3)
  const colors = new Float32Array((N_LAT + 1) * (N_LON + 1) * 3)
  const uv = new Float32Array((N_LAT + 1) * (N_LON + 1) * 2)
  let p = 0
  let c = 0
  let u = 0

  // Colour ramp over the actual relief range, so the terrain reads as terrain.
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < dem.data.length; i += 7) {
    const r = (dem.data[i] * dem.scale + dem.offset) / 1000
    if (r < lo) lo = r
    if (r > hi) hi = r
  }

  for (let i = 0; i <= N_LAT; i++) {
    const lat = 90 - (180 * i) / N_LAT
    const la = (lat * Math.PI) / 180
    for (let j = 0; j <= N_LON; j++) {
      const lon = -180 + (360 * j) / N_LON
      const lo2 = (lon * Math.PI) / 180
      const rTrue = sampleRadiusKm(dem, lat, lon)
      const r =
        (meanRadiusKm + (rTrue - meanRadiusKm) * exaggeration + biasKm) * KM
      positions[p++] = r * Math.cos(la) * Math.cos(lo2)
      positions[p++] = r * Math.cos(la) * Math.sin(lo2)
      positions[p++] = r * Math.sin(la)

      const f = Math.max(0, Math.min(1, (rTrue - lo) / (hi - lo)))
      // Cool dark lowlands to pale highlands, matching the app's palette.
      colors[c++] = 0.24 + 0.66 * f
      colors[c++] = 0.25 + 0.63 * f
      colors[c++] = 0.32 + 0.56 * f
      uv[u++] = j / N_LON
      uv[u++] = 1 - i / N_LAT
    }
  }

  const indices: number[] = []
  const row = N_LON + 1
  for (let i = 0; i < N_LAT; i++) {
    for (let j = 0; j < N_LON; j++) {
      const a = i * row + j
      indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

/** Vertical field of view to 35 mm equivalent focal length. */
const fovToMm = (fovDeg: number) =>
  Math.round(12 / Math.tan(((fovDeg / 2) * Math.PI) / 180))

export function MoonGlobe({
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
  const mount = useRef<HTMLDivElement>(null)
  const [scene, setScene] = useState<MoonScene | null>(null)
  const [dem, setDem] = useState<Dem | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [contact, setContact] = useState<'c2' | 'c3'>('c2')
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [follow, setFollow] = useState(true)
  const [exag, setExag] = useState(1)
  const [fov, setFov] = useState(0.75)
  const [earthshine, setEarthshine] = useState(0.06)
  const [ready, setReady] = useState(false)
  const [patch, setPatch] = useState<Patch | null>(null)
  const [closeup, setCloseup] = useState(false)

  // Live values the animation loop reads without re-subscribing.
  const live = useRef({
    idx: 0, follow: true, fov: 0.75, earthshine: 0.06, closeup: false,
  })
  live.current = { idx, follow, fov, earthshine, closeup }

  const three = useRef<{
    renderer: THREE.WebGLRenderer
    cam: THREE.PerspectiveCamera
    scene: THREE.Scene
    sunScene: THREE.Scene
    controls: OrbitControls
    moon: THREE.Mesh
    patchMesh: THREE.Mesh | null
    sun: THREE.Mesh
    light: THREE.DirectionalLight
    ambient: THREE.AmbientLight
  } | null>(null)

  // --- data -----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false
    setErr(null)
    api
      .moonScene(lat, lon, elev, contact, 240)
      .then((s) => {
        if (cancelled) return
        setScene(s)
        setIdx(Math.floor((s.t_unix?.length ?? 2) / 2))
      })
      .catch((e: Error) => !cancelled && setErr(e.message))
    return () => {
      cancelled = true
    }
  }, [lat, lon, elev, contact])

  useEffect(() => {
    const r = scene?.bead_region
    if (!r) {
      setPatch(null)
      return
    }
    let cancelled = false
    api
      .demPatch(r.lat0, r.lat1, r.lon0, r.lon1)
      .then((d) => !cancelled && setPatch(d))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [scene])

  useEffect(() => {
    let cancelled = false
    api
      .dem16(1440)
      .then((d) => !cancelled && setDem(d))
      .catch((e: Error) => !cancelled && setErr(e.message))
    return () => {
      cancelled = true
    }
  }, [])

  // --- scene ----------------------------------------------------------------

  useEffect(() => {
    const el = mount.current
    // Wait for the patch too when there is one, so the mesh pair is consistent.
    if (!el || !dem || !scene?.is_total || three.current) return
    if (scene.bead_region && !patch) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(el.clientWidth, el.clientHeight)
    renderer.setClearColor(0x05070e)
    el.appendChild(renderer.domElement)

    const sc = new THREE.Scene()
    const cam = new THREE.PerspectiveCamera(
      fov,
      el.clientWidth / el.clientHeight,
      0.01,
      4e5,
    )

    const surface = () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 1,
        metalness: 0,
      })

    const moonGeo = buildMoon(dem, scene.moon_radius_km, 1, patch ? -0.5 : 0)
    const moon = new THREE.Mesh(moonGeo, surface())
    sc.add(moon)

    let patchMesh: THREE.Mesh | null = null
    if (patch) {
      patchMesh = new THREE.Mesh(
        buildPatch(patch, scene.moon_radius_km, 1),
        surface(),
      )
      sc.add(patchMesh)
    }

    // The Sun lives in its own scene, drawn in a first pass. It is 400 times
    // farther away than the Moon, so a single depth buffer spanning both cannot
    // hold enough precision and the Sun speckles through the silhouette. Drawing
    // it first and then clearing depth makes the occlusion exact instead.
    const sunScene = new THREE.Scene()
    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(scene.sun_radius_km * KM, 96, 48),
      new THREE.MeshBasicMaterial({ color: 0xfff6de }),
    )
    sunScene.add(sun)

    const light = new THREE.DirectionalLight(0xfff4e0, 1.5)
    sc.add(light)
    const ambient = new THREE.AmbientLight(0x9fb4e8, earthshine)
    sc.add(ambient)

    const controls = new OrbitControls(cam, renderer.domElement)
    controls.target.set(0, 0, 0)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = scene.moon_radius_km * KM * 1.02
    controls.maxDistance = 2000
    controls.rotateSpeed = 0.45
    controls.zoomSpeed = 0.7
    // Any manual drag means the user wants to look around, not be dragged back.
    controls.addEventListener('start', () => setFollow(false))

    const o = scene.observer_km[0]
    cam.up.set(...(scene.north_dir as [number, number, number]))
    cam.position.set(o[0] * KM, o[1] * KM, o[2] * KM)
    controls.update()

    renderer.autoClear = false
    three.current = {
      renderer, cam, scene: sc, sunScene, controls, moon, patchMesh, sun, light,
      ambient,
    }
    setReady(true)

    let raf = 0
    const tick = () => {
      const t = three.current
      if (!t) return
      const s = scene
      const i = Math.max(0, Math.min(s.observer_km.length - 1, live.current.idx))
      const ob = s.observer_km[i]
      const su = s.sun_km[i]

      t.sun.position.set(su[0] * KM, su[1] * KM, su[2] * KM)
      // Sunlight travels from the Sun toward the Moon's centre.
      t.light.position.copy(t.sun.position)
      t.light.target.position.set(0, 0, 0)
      t.light.target.updateMatrixWorld()
      t.ambient.intensity = live.current.earthshine

      if (live.current.follow) {
        t.cam.up.set(...(s.north_dir as [number, number, number]))
        t.cam.position.set(ob[0] * KM, ob[1] * KM, ob[2] * KM)
        t.controls.enableRotate = false
        t.controls.enablePan = false
      } else {
        t.controls.enableRotate = true
      }

      // Close-up looks at the limb point where the beads break through, since a
      // 1-arcsecond bead is invisible when the whole disc is in frame.
      if (live.current.closeup && s.bead_region) {
        const D = Math.hypot(ob[0], ob[1], ob[2])
        const R = s.moon_radius_km
        const sHat = [ob[0] / D, ob[1] / D, ob[2] / D]
        const paMid = ((s.bead_region.pa0 + s.bead_region.pa1) / 2) * Math.PI / 180
        const k = R / D
        const q = Math.sqrt(Math.max(0, 1 - k * k))
        const tgt = [0, 1, 2].map(
          (n) =>
            R *
            (k * sHat[n] +
              q *
                (Math.cos(paMid) * s.north_dir[n] +
                  Math.sin(paMid) * s.east_dir[n])) *
            KM,
        )
        t.controls.target.set(tgt[0], tgt[1], tgt[2])
      } else {
        t.controls.target.set(0, 0, 0)
      }
      t.cam.fov = live.current.fov
      t.controls.update()

      const d = t.cam.position.length()
      const rMoon = s.moon_radius_km * KM
      t.renderer.clear()

      // Pass 1: the Sun, with a far plane out past it.
      t.cam.near = Math.max(0.001, d * 0.5)
      t.cam.far = 4e5
      t.cam.updateProjectionMatrix()
      t.renderer.render(t.sunScene, t.cam)

      // Pass 2: the Moon, on a depth range tight enough that its own surface
      // self-occludes cleanly. Near/far only affect depth, not where things
      // land on screen, so the two passes stay perfectly registered.
      t.renderer.clearDepth()
      t.cam.near = Math.max(0.0005, d - rMoon * 1.5)
      t.cam.far = d + rMoon * 1.5
      t.cam.updateProjectionMatrix()
      t.renderer.render(t.scene, t.cam)

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const onResize = () => {
      if (!el || !three.current) return
      three.current.renderer.setSize(el.clientWidth, el.clientHeight)
      three.current.cam.aspect = el.clientWidth / el.clientHeight
      three.current.cam.updateProjectionMatrix()
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      controls.dispose()
      moonGeo.dispose()
      patchMesh?.geometry.dispose()
      renderer.dispose()
      if (renderer.domElement.parentElement === el)
        el.removeChild(renderer.domElement)
      three.current = null
      setReady(false)
    }
    // Built once per site/contact; live values are read through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dem, patch, scene])

  // Rebuild the meshes when the exaggeration changes.
  useEffect(() => {
    const t = three.current
    if (!t || !dem || !scene?.is_total) return
    const geo = buildMoon(dem, scene.moon_radius_km, exag, patch ? -0.5 : 0)
    const old = t.moon.geometry
    t.moon.geometry = geo
    old.dispose()
    if (t.patchMesh && patch) {
      const pg = buildPatch(patch, scene.moon_radius_km, exag)
      const po = t.patchMesh.geometry
      t.patchMesh.geometry = pg
      po.dispose()
    }
  }, [exag, dem, patch, scene])

  // Playback across the bead window.
  useEffect(() => {
    if (!playing || !scene?.t_unix) return
    const n = scene.t_unix.length
    const id = setInterval(() => {
      setIdx((i) => {
        if (i >= n - 1) {
          setPlaying(false)
          return n - 1
        }
        return i + 1
      })
    }, 45)
    return () => clearInterval(id)
  }, [playing, scene])

  const t_now = scene?.t_unix?.[idx]
  const dist =
    scene?.observer_km?.[idx] &&
    Math.hypot(...(scene.observer_km[idx] as [number, number, number]))

  if (err) return <div className="err">{err}</div>
  if (scene && !scene.is_total) {
    return (
      <div className="panel">
        <div className="panel-body">
          <ul className="notes">
            <li className="warn">{scene.note}</li>
            <li>
              A 3D reconstruction needs a totality to show. Pick a site inside
              the violet band on the Plan tab.
            </li>
          </ul>
        </div>
      </div>
    )
  }

  return (
    <div className="globe-wrap">
      <div className="globe-head">
        <h2>
          The eclipse in 3D
          {siteName && <em> · {siteName}</em>}
        </h2>
        <span className="spacer" />
        {!ready && <span className="loading">building the Moon…</span>}
        {scene && (
          <span className="mono tiny">
            libration {scene.sub_lat.toFixed(2)}°, {scene.sub_lon.toFixed(2)}°
          </span>
        )}
      </div>

      <div className="globe-stage">
        <div ref={mount} className="globe-canvas" />
        <div className="globe-hud mono">
          <div>
            <b>{t_now ? fmtLocal(t_now, true) : '—'}</b> CEST
          </div>
          <div>{dist ? `${Math.round(dist).toLocaleString()} km away` : ''}</div>
          <div>
            {fov.toFixed(2)}° · ≈{fovToMm(fov).toLocaleString()} mm
          </div>
          <div className={follow ? 'on' : ''}>
            {follow ? 'your view' : 'free orbit'}
          </div>
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
            max={Math.max(0, (scene?.t_unix?.length ?? 1) - 1)}
            value={idx}
            onChange={(e) => {
              setPlaying(false)
              setIdx(Number(e.target.value))
            }}
            aria-label="Time through the bead window"
            style={{ flex: 1, minWidth: 140 }}
          />
          <button
            className={`btn${follow ? ' primary' : ''}`}
            onClick={() => setFollow(true)}
            title="Put the camera back where you will be standing"
          >
            ⌖ My view
          </button>
          <button
            className="btn"
            onClick={() => setFollow(false)}
            title="Release the camera and fly around the Moon"
          >
            ⟳ Free orbit
          </button>
          <button
            className={`btn${closeup ? ' primary' : ''}`}
            disabled={!scene?.bead_region}
            onClick={() => {
              const next = !closeup
              setCloseup(next)
              if (next) {
                setFollow(true)
                setFov(0.05)
              } else {
                setFov(0.75)
              }
            }}
            title="Zoom onto the stretch of limb where the beads break through"
          >
            ◉ Beads close-up
          </button>
        </div>

        <div className="gc-row sliders">
          <label>
            <span>
              Relief <b>×{exag}</b>
            </span>
            <input
              type="range"
              min={1}
              max={40}
              step={1}
              value={exag}
              onChange={(e) => setExag(Number(e.target.value))}
            />
          </label>
          <label>
            <span>
              Lens <b>{fovToMm(fov).toLocaleString()} mm</b>
            </span>
            <input
              type="range"
              min={0.02}
              max={2.5}
              step={0.005}
              value={2.52 - fov}
              onChange={(e) => setFov(2.52 - Number(e.target.value))}
            />
          </label>
          <label>
            <span>
              Earthshine <b>{(earthshine * 100).toFixed(0)}%</b>
            </span>
            <input
              type="range"
              min={0}
              max={0.35}
              step={0.01}
              value={earthshine}
              onChange={(e) => setEarthshine(Number(e.target.value))}
            />
          </label>
        </div>
      </div>

      <div className="panel">
        <div className="panel-body">
          <ul className="notes">
            <li>
              Drag to orbit, scroll to change your distance, and press{' '}
              <strong>My view</strong> to snap back to where you will actually be
              standing. The lens slider changes only the field of view, so it
              tells you the focal length that would frame this.
            </li>
            <li>
              The Moon looks black from your side because it is: at totality you
              are looking at the new Moon's unlit face, with only earthshine on
              it. Orbit around and the sunlit far side comes into view.
            </li>
            <li>
              At <b>Relief ×1</b> the shape is true — and the whole limb relief is
              only 0.25% of the radius, so exaggerate it to see the valleys the
              beads come through. Exaggeration changes the silhouette, so the
              beads you see move; the bead <em>times</em> on the other tabs are
              always computed from the unexaggerated shape.
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
