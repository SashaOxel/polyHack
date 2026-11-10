import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { store } from '../core/store'
import { speedLimit } from '../core/roads'
import { buildScene, disposeScene, glowTexture, type SceneData } from './scene3d'
import { traffic } from './trafficController'
import type { Theme } from './theme'
import { speedSignCanvas } from './speedSign'

interface Props {
  showPedestrian: boolean
  showTram?: boolean
  showLanes?: boolean
  theme?: Theme
  onHint: (msg: string) => void
}

const MAX_CARS = 1000

/**
 * 3D-просмотр: дороги (ширина по полосам), мосты с опорами, светофоры, здания.
 * Вращение — левая кнопка, сдвиг — правая, масштаб — колесо. Клик по дороге выбирает её (как в 2D),
 * так что теги можно править в боковой панели и сразу видеть результат.
 */
export default function View3D({ showPedestrian, showTram = true, showLanes = true, theme = 'light', onHint }: Props) {
  // выбор объекта меняет version, правка документа — docVersion
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const host = useRef<HTMLDivElement>(null)
  const [zScale, setZScale] = useState(3)
  const [buildings, setBuildings] = useState(true)
  const [stats, setStats] = useState<SceneData['stats'] | null>(null)
  const [night, setNight] = useState(theme === 'dark')
  const [flying, setFlying] = useState(false)

  const gl = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    data: SceneData | null
    sel: THREE.Mesh | null
    sign: THREE.Sprite | null
    /** куда кликнули по дороге: знак скорости ставим сюда */
    click: { wayId: number; point: THREE.Vector3 } | null
    render: () => void
    framed: boolean
    /** машины демо-движения, их фары/стоп-сигналы и сигналы светофоров на подходах */
    cars: THREE.InstancedMesh
    lights: THREE.Points
    orbs: THREE.Points
    night: boolean
    fileKey: string
  } | null>(null)

  // ----- создание рендерера (один раз) -----
  useEffect(() => {
    const el = host.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    // кинематографичная цветопередача и мягкие тени
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    el.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#dde6ee')
    const camera = new THREE.PerspectiveCamera(50, 1, 1, 100000)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.maxPolarAngle = Math.PI / 2 - 0.04
    controls.screenSpacePanning = false

    const render = () => renderer.render(scene, camera)
    controls.addEventListener('change', render)

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      render()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()

    // динамические объекты живут вне пересобираемой сцены
    const cars = new THREE.InstancedMesh(
      new THREE.BoxGeometry(4.4, 1.45, 1.9).translate(0, 0.72, 0),
      new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.35 }), MAX_CARS,
    )
    cars.count = 0
    cars.castShadow = true
    cars.frustumCulled = false
    const pointsOf = (n: number, size: number) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3))
      g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3))
      g.setDrawRange(0, 0)
      const p = new THREE.Points(g, new THREE.PointsMaterial({
        size, map: glowTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }))
      p.frustumCulled = false
      return p
    }
    const lights = pointsOf(MAX_CARS * 4, 2.6)
    const orbs = pointsOf(600, 6)
    scene.add(cars, lights, orbs)

    gl.current = {
      renderer, scene, camera, controls, data: null, sel: null, sign: null, click: null, render, framed: false, fileKey: store.fileName,
      cars, lights, orbs, night: false,
    }
    // в режиме разработки доступно из консоли: __gl3d.camera, __gl3d.controls
    if (import.meta.env.DEV) (window as unknown as { __gl3d: unknown }).__gl3d = gl.current

    // ----- выбор дороги кликом (не перетаскиванием) -----
    const ray = new THREE.Raycaster()
    let down: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY } }
    const onUp = (e: PointerEvent) => {
      const g = gl.current
      if (!down || !g?.data?.roads) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      down = null
      if (moved > 4) return
      const r = renderer.domElement.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
      const hit = ray.intersectObject(g.data.roads, false)[0]
      const wayId = hit?.faceIndex != null ? g.data.faceWay[hit.faceIndex] : undefined
      g.click = wayId !== undefined && hit ? { wayId, point: hit.point.clone() } : null
      store.select(wayId !== undefined ? { kind: 'way', id: wayId } : null)
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)
    // машины едут — обновляем и перерисовываем каждый кадр
    const offFrame = traffic.onFrame(() => { updateTraffic(); gl.current?.render() })

    return () => {
      offFrame()
      ro.disconnect()
      controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      if (gl.current?.data) disposeScene(gl.current.data.root)
      if (gl.current?.sign) { gl.current.sign.material.map?.dispose(); gl.current.sign.material.dispose() }
      renderer.dispose()
      renderer.domElement.remove()
      gl.current = null
    }
  }, [])

  // ----- пересборка сцены при правке документа или смене настроек -----
  useEffect(() => {
    const g = gl.current
    if (!g) return
    if (g.fileKey !== store.fileName) { g.framed = false; g.fileKey = store.fileName } // новый файл → камера заново
    if (g.data) { g.scene.remove(g.data.root); disposeScene(g.data.root) }
    if (g.sel) { g.sel.geometry.dispose(); g.scene.remove(g.sel); g.sel = null }
    if (g.sign) { g.sign.material.map?.dispose(); g.sign.material.dispose(); g.scene.remove(g.sign); g.sign = null }
    if (store.doc.nodes.size === 0) { g.data = null; setStats(null); g.render(); return }

    const t0 = performance.now()
    const data = buildScene(store.doc, { zScale, buildings, pedestrian: showPedestrian, tram: showTram, lanes: showLanes, night })
    g.data = data
    g.night = night
    g.scene.add(data.root)
    applySky(g.scene, night, data.radius)
    g.renderer.toneMappingExposure = night ? 1.25 : 1.05
    setStats(data.stats)
    onHint(`3D: ${data.stats.roads} дорог, ${data.stats.buildings} зданий, ${data.stats.bridges} мостов, ${data.stats.signals} светофоров, ${data.stats.crossings} переходов (${Math.round(performance.now() - t0)} мс)`)

    // первый кадр после загрузки файла: камера «сверху под углом»
    if (!g.framed) {
      const r = data.radius
      g.camera.position.set(0, r * 1.2, r * 1.35)
      g.controls.target.set(0, 0, 0)
      g.camera.far = r * 30
      g.camera.updateProjectionMatrix()
      g.controls.update()
      g.framed = true
    }
    updateTraffic()
    g.render()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.docVersion, zScale, buildings, showPedestrian, showTram, showLanes, night])

  // ----- облёт: камера плавно кружит вокруг центра, любое касание мышью останавливает -----
  useEffect(() => {
    const g = gl.current
    if (!flying || !g) return
    let raf = 0
    const stop = () => setFlying(false)
    g.renderer.domElement.addEventListener('pointerdown', stop)
    const spin = () => {
      const t = g.controls.target, p = g.camera.position
      const dx = p.x - t.x, dz = p.z - t.z
      const a = Math.atan2(dz, dx) + 0.0022
      const r = Math.hypot(dx, dz)
      p.x = t.x + r * Math.cos(a)
      p.z = t.z + r * Math.sin(a)
      g.camera.lookAt(t)
      g.render()
      raf = requestAnimationFrame(spin)
    }
    raf = requestAnimationFrame(spin)
    return () => { cancelAnimationFrame(raf); g.renderer.domElement.removeEventListener('pointerdown', stop) }
  }, [flying])

  /** Расставить машины, фары и сигналы светофоров по текущему состоянию демо-движения. */
  function updateTraffic() {
    const g = gl.current
    const sim = traffic.sim
    if (!g) return
    if (!sim || !g.data) {
      g.cars.count = 0
      g.lights.geometry.setDrawRange(0, 0)
      g.orbs.geometry.setDrawRange(0, 0)
      return
    }
    const data = g.data
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1)
    const up = new THREE.Vector3(0, 1, 0), col = new THREE.Color()
    const lp = g.lights.geometry.getAttribute('position') as THREE.BufferAttribute
    const lc = g.lights.geometry.getAttribute('color') as THREE.BufferAttribute
    let li = 0
    const n = Math.min(sim.vehicles.length, MAX_CARS)
    for (let i = 0; i < n; i++) {
      const v = sim.vehicles[i]
      const p = sim.position(v)
      const w = data.toWorld(p.lat, p.lon)
      const ya = data.nodeY(p.a) ?? 0, yb = data.nodeY(p.b) ?? 0
      const y = ya + (yb - ya) * p.t + 0.12
      const dx = Math.cos(p.heading), dz = -Math.sin(p.heading)
      // машина в своей полосе: сдвиг от оси дороги вправо по ходу (метры)
      const rx = -dz, rz = dx
      pos.set(w.x + rx * p.offset, y, w.z + rz * p.offset)
      q.setFromAxisAngle(up, p.heading)
      m.compose(pos, q, one)
      g.cars.setMatrixAt(i, m)
      // цвет кузова: днём — разные машины, ночью — по скорости (стоит — красный, едет — зелёный)
      const r = Math.max(0, Math.min(1, v.v / sim.vmax(v.edge)))
      g.cars.setColorAt(i, g.night ? col.setHSL((120 * r) / 360, 0.75, 0.5) : col.setHSL(v.hue / 360, 0.45, 0.55))
      if (g.night) {
        // две фары впереди и два стоп-сигнала сзади (ярче, когда машина тормозит/стоит)
        const fx = pos.x + dx * 2.3, fz = pos.z + dz * 2.3, bx = pos.x - dx * 2.3, bz = pos.z - dz * 2.3
        for (const s of [-0.65, 0.65]) {
          lp.setXYZ(li, fx + rx * s, y + 0.7, fz + rz * s); lc.setXYZ(li++, 1, 0.95, 0.75)
          const brake = r < 0.2 ? 1 : 0.45
          lp.setXYZ(li, bx + rx * s, y + 0.75, bz + rz * s); lc.setXYZ(li++, brake, 0.05, 0.05)
        }
      }
    }
    g.cars.count = n
    g.cars.instanceMatrix.needsUpdate = true
    if (g.cars.instanceColor) g.cars.instanceColor.needsUpdate = true
    g.lights.geometry.setDrawRange(0, li)
    lp.needsUpdate = true; lc.needsUpdate = true

    // сигналы светофоров на подходах: светящиеся огни на высоте мачты
    const op = g.orbs.geometry.getAttribute('position') as THREE.BufferAttribute
    const oc = g.orbs.geometry.getAttribute('color') as THREE.BufferAttribute
    let oi = 0
    for (const l of sim.approachLights()) {
      if (oi >= op.count) break
      const w = data.toWorld(l.lat, l.lon)
      op.setXYZ(oi, w.x, 5.4, w.z)
      if (l.state === 'green') oc.setXYZ(oi, 0.2, 1, 0.35)
      else if (l.state === 'yellow') oc.setXYZ(oi, 1, 0.85, 0.1)
      else oc.setXYZ(oi, 1, 0.12, 0.1)
      oi++
    }
    g.orbs.geometry.setDrawRange(0, oi)
    op.needsUpdate = true; oc.needsUpdate = true
  }

  // ----- подсветка выбранной дороги -----
  useEffect(() => {
    const g = gl.current
    if (!g?.data) return
    if (g.sel) { g.sel.geometry.dispose(); g.scene.remove(g.sel); g.sel = null }
    if (g.sign) { g.sign.material.map?.dispose(); g.sign.material.dispose(); g.scene.remove(g.sign); g.sign = null }
    const s = store.selection
    if (s?.kind === 'way') {
      const geo = g.data.wayRibbon(s.id, 2.5, 0.2)
      if (geo) {
        g.sel = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }))
        g.scene.add(g.sel)
      }
      // знак скорости: над точкой клика, а если выбрали не кликом — над серединой дороги
      const way = store.doc.ways.get(s.id)
      const anchor = g.click?.wayId === s.id ? g.click.point.clone().add(new THREE.Vector3(0, 8, 0)) : g.data.wayAnchor(s.id, 8)
      if (way && anchor) {
        const tex = new THREE.CanvasTexture(speedSignCanvas(speedLimit(way)))
        tex.colorSpace = THREE.SRGBColorSpace
        g.sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, transparent: true }))
        g.sign.scale.set(0.055, 0.055, 1) // sizeAttenuation=false: размер в долях высоты окна, не зависит от расстояния
        g.sign.position.copy(anchor)
        g.sign.renderOrder = 10
        g.scene.add(g.sign)
      }
    }
    g.render()
  }, [version, store.docVersion, zScale, buildings, showPedestrian])

  const resetCamera = () => {
    const g = gl.current
    if (!g?.data) return
    const r = g.data.radius
    g.camera.position.set(0, r * 1.2, r * 1.35)
    g.controls.target.set(0, 0, 0)
    g.controls.update()
    g.render()
  }

  return (
    <div className="view3d">
      <div ref={host} className="gl" />
      <div className="v3-panel">
        <b>3D</b>
        <label><input type="checkbox" checked={buildings} onChange={(e) => setBuildings(e.target.checked)} /> Здания</label>
        <label className="slider">
          Высота ×{zScale}
          <input type="range" min={1} max={10} step={1} value={zScale} onChange={(e) => setZScale(+e.target.value)}
            title="Преувеличение высот только для показа: мост в 6 м на карте в 2 км почти не виден" />
        </label>
        <div className="seg">
          <button className={!night ? 'active' : ''} onClick={() => setNight(false)}>☀ День</button>
          <button className={night ? 'active' : ''} onClick={() => setNight(true)}>☾ Ночь</button>
        </div>
        <button className={flying ? 'btn on-fly' : 'btn'} onClick={() => setFlying(!flying)}>{flying ? '⏹ Стоп' : '🎥 Облёт'}</button>
        <button onClick={resetCamera}>Сбросить камеру</button>
        {stats && <span className="meta">дорог {stats.roads} · зданий {stats.buildings} · мостов {stats.bridges}</span>}
      </div>
      <div className="v3-help">ЛКМ — вращать · ПКМ — сдвиг · колесо — масштаб · клик — выбрать дорогу</div>
    </div>
  )
}

/** Небо (вертикальный градиент) и туман: днём светлое, ночью почти чёрное с синевой у горизонта. */
function applySky(scene: THREE.Scene, night: boolean, radius: number) {
  const c = document.createElement('canvas')
  c.width = 2; c.height = 256
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  if (night) { g.addColorStop(0, '#01040c'); g.addColorStop(0.6, '#07142b'); g.addColorStop(1, '#14284a') }
  else { g.addColorStop(0, '#6fa8dc'); g.addColorStop(0.55, '#b7d3ee'); g.addColorStop(1, '#e8f0f7') }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 2, 256)
  const old = scene.background
  if (old instanceof THREE.Texture) old.dispose()
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  scene.background = tex
  scene.fog = new THREE.Fog(night ? '#0a1730' : '#dbe7f2', radius * 1.6, radius * 6)
}
