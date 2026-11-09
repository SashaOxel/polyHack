import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { store } from '../core/store'
import { buildScene, disposeScene, type SceneData } from './scene3d'

interface Props {
  showPedestrian: boolean
  onHint: (msg: string) => void
}

/**
 * 3D-просмотр: дороги (ширина по полосам), мосты с опорами, светофоры, здания.
 * Вращение — левая кнопка, сдвиг — правая, масштаб — колесо. Клик по дороге выбирает её (как в 2D),
 * так что теги можно править в боковой панели и сразу видеть результат.
 */
export default function View3D({ showPedestrian, onHint }: Props) {
  // выбор объекта меняет version, правка документа — docVersion
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const host = useRef<HTMLDivElement>(null)
  const [zScale, setZScale] = useState(3)
  const [buildings, setBuildings] = useState(true)
  const [stats, setStats] = useState<SceneData['stats'] | null>(null)

  const gl = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    data: SceneData | null
    sel: THREE.Mesh | null
    render: () => void
    framed: boolean
    fileKey: string
  } | null>(null)

  // ----- создание рендерера (один раз) -----
  useEffect(() => {
    const el = host.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
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

    gl.current = { renderer, scene, camera, controls, data: null, sel: null, render, framed: false, fileKey: store.fileName }
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
      store.select(wayId !== undefined ? { kind: 'way', id: wayId } : null)
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)

    return () => {
      ro.disconnect()
      controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      if (gl.current?.data) disposeScene(gl.current.data.root)
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
    if (store.doc.nodes.size === 0) { g.data = null; setStats(null); g.render(); return }

    const t0 = performance.now()
    const data = buildScene(store.doc, { zScale, buildings, pedestrian: showPedestrian })
    g.data = data
    g.scene.add(data.root)
    setStats(data.stats)
    onHint(`3D: ${data.stats.roads} дорог, ${data.stats.buildings} зданий, ${data.stats.bridges} мостов (${Math.round(performance.now() - t0)} мс)`)

    // первый кадр после загрузки файла: камера «сверху под углом»
    if (!g.framed) {
      const r = data.radius
      g.camera.position.set(0, r * 1.5, r * 1.7)
      g.controls.target.set(0, 0, 0)
      g.camera.far = r * 30
      g.camera.updateProjectionMatrix()
      g.controls.update()
      g.framed = true
    }
    g.render()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.docVersion, zScale, buildings, showPedestrian])

  // ----- подсветка выбранной дороги -----
  useEffect(() => {
    const g = gl.current
    if (!g?.data) return
    if (g.sel) { g.sel.geometry.dispose(); g.scene.remove(g.sel); g.sel = null }
    const s = store.selection
    if (s?.kind === 'way') {
      const geo = g.data.wayRibbon(s.id, 2.5, 0.2)
      if (geo) {
        g.sel = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }))
        g.scene.add(g.sel)
      }
    }
    g.render()
  }, [version, store.docVersion, zScale, buildings, showPedestrian])

  const resetCamera = () => {
    const g = gl.current
    if (!g?.data) return
    const r = g.data.radius
    g.camera.position.set(0, r * 1.5, r * 1.7)
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
        <button onClick={resetCamera}>Сбросить камеру</button>
        {stats && <span className="meta">дорог {stats.roads} · зданий {stats.buildings} · мостов {stats.bridges}</span>}
      </div>
      <div className="v3-help">ЛКМ — вращать · ПКМ — сдвиг · колесо — масштаб · клик — выбрать дорогу</div>
    </div>
  )
}
