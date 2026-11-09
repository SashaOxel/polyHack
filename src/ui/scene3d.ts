import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { elevationContext, wayProfile } from '../core/elevation'
import { project } from '../core/geo'
import { isDrivable, roadStyle } from '../core/roads'
import type { OsmDocument, OsmWay } from '../core/types'

/**
 * Построитель 3D-сцены из документа. Чистая функция: three.js работает и в Node, поэтому её можно тестировать.
 * Координаты: X — на восток, Z — на юг, Y — вверх, метры. Начало — центр сети.
 */

export interface BuildOptions {
  /** Преувеличение высот (только для показа): мост 6 м на карте в 2 км почти не виден */
  zScale: number
  buildings: boolean
  pedestrian: boolean
}

export interface SceneData {
  root: THREE.Group
  roads: THREE.Mesh | null
  /** на каждый треугольник дорожной сетки — id дороги (для выбора кликом) */
  faceWay: number[]
  /** радиус сети, м (для камеры) */
  radius: number
  /** лента дороги для подсветки выбранной: шире и чуть выше обычной */
  wayRibbon(wayId: number, extraWidth: number, dy: number): THREE.BufferGeometry | null
  stats: { roads: number; buildings: number; bridges: number; signals: number }
}

const LANE_W = 3.2

/** Ширина проезжей части, м: по `lanes`, иначе по классу дороги. */
export function roadWidth(way: OsmWay): number {
  const hw = way.tags.highway ?? ''
  if (!isDrivable(way)) return 1.8
  const lanes = Number(way.tags.lanes)
  if (lanes > 0) return Math.max(3.5, lanes * LANE_W)
  switch (hw) {
    case 'motorway': case 'trunk': case 'primary': return 7.5
    case 'secondary': return 6.5
    case 'tertiary': return 6
    case 'service': return 3.5
    default: return 5.5
  }
}

interface P { x: number; y: number; z: number }
interface Buf { pos: number[]; col: number[]; idx: number[] }

/** Лента вдоль ломаной с мягкими углами. Возвращает число добавленных треугольников. */
function addRibbon(buf: Buf, pts: P[], width: number, color: THREE.Color, ownerOut?: { faceWay: number[]; wayId: number }): number {
  // убираем почти совпадающие точки
  const p: P[] = []
  for (const q of pts) if (!p.length || Math.hypot(q.x - p.at(-1)!.x, q.z - p.at(-1)!.z) > 0.05) p.push(q)
  if (p.length < 2) return 0
  const hw = width / 2
  const base = buf.pos.length / 3
  const dir = (a: P, b: P) => {
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1
    return { x: dx / l, z: dz / l }
  }
  for (let i = 0; i < p.length; i++) {
    const prev = i > 0 ? dir(p[i - 1], p[i]) : null
    const next = i < p.length - 1 ? dir(p[i], p[i + 1]) : null
    const a = prev ?? next!, b = next ?? prev!
    let tx = a.x + b.x, tz = a.z + b.z
    const tl = Math.hypot(tx, tz) || 1
    tx /= tl; tz /= tl
    const miter = Math.min(2, 1 / Math.max(0.5, tx * b.x + tz * b.z))
    const nx = -tz * hw * miter, nz = tx * hw * miter
    buf.pos.push(p[i].x + nx, p[i].y, p[i].z + nz, p[i].x - nx, p[i].y, p[i].z - nz)
    buf.col.push(color.r, color.g, color.b, color.r, color.g, color.b)
  }
  let tris = 0
  for (let i = 0; i < p.length - 1; i++) {
    const A0 = base + 2 * i, B0 = A0 + 1, A1 = A0 + 2, B1 = A0 + 3
    buf.idx.push(A0, A1, B0, B0, A1, B1)
    tris += 2
  }
  if (ownerOut) for (let i = 0; i < tris; i++) ownerOut.faceWay.push(ownerOut.wayId)
  return tris
}

const toGeometry = (b: Buf) => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3))
  g.setIndex(b.idx)
  g.computeVertexNormals()
  return g
}

export function buildScene(doc: OsmDocument, opts: BuildOptions): SceneData {
  const root = new THREE.Group()
  const ctx = elevationContext(doc)

  // ---- начало координат: центр сети ----
  const hwWays = [...doc.ways.values()].filter((w) => w.tags.highway && (isDrivable(w) || opts.pedestrian))
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const w of hwWays) for (const id of w.nodes) {
    const n = doc.nodes.get(id)
    if (!n) continue
    const m = project(n.lat, n.lon)
    x0 = Math.min(x0, m.x); x1 = Math.max(x1, m.x); y0 = Math.min(y0, m.y); y1 = Math.max(y1, m.y)
  }
  if (!isFinite(x0)) { x0 = x1 = y0 = y1 = 0 }
  const ox = (x0 + x1) / 2, oy = (y0 + y1) / 2
  // Меркатор растягивает метры на cos(широты): возвращаем реальные расстояния
  const midLat = (Math.atan(Math.sinh(oy / 6378137)) * 180) / Math.PI
  const k = Math.cos((midLat * Math.PI) / 180)
  const world = (lat: number, lon: number) => {
    const m = project(lat, lon)
    return { x: (m.x - ox) * k, z: -(m.y - oy) * k }
  }
  const radius = Math.max(50, Math.hypot((x1 - x0) * k, (y1 - y0) * k) / 2)

  /** Точки дороги в мировых координатах с высотой; id есть только у настоящих узлов. */
  const wayPoints = (way: OsmWay, dy = 0): (P & { id?: number })[] =>
    wayProfile(doc, way, ctx).map((q) => {
      const w = world(q.lat, q.lon)
      return { x: w.x, y: q.z * opts.zScale + dy, z: w.z, id: q.id }
    })

  // ---- дороги ----
  const roadBuf: Buf = { pos: [], col: [], idx: [] }
  const slabBuf: Buf = { pos: [], col: [], idx: [] }
  const faceWay: number[] = []
  const pillars: P[] = []
  const nodeY = new Map<number, number>()
  const slabColor = new THREE.Color('#2b2f36')
  let bridges = 0

  for (const way of hwWays) {
    const drivable = isDrivable(way)
    const pts = wayPoints(way, 0.01 * roadStyle(way.tags.highway).width)
    for (const q of pts) if (q.id !== undefined && !nodeY.has(q.id)) nodeY.set(q.id, q.y)
    const color = new THREE.Color(drivable ? roadStyle(way.tags.highway).color : '#d9d3c7')
    if (drivable) color.lerp(new THREE.Color('#4a515d'), 0.3) // приглушаем под «асфальт», класс остаётся читаемым
    addRibbon(roadBuf, pts, roadWidth(way), color, { faceWay, wayId: way.id })

    const isBridge = way.tags.bridge !== undefined && way.tags.bridge !== 'no'
    if (isBridge && drivable) {
      bridges++
      addRibbon(slabBuf, pts.map((p) => ({ ...p, y: p.y - 0.7 })), roadWidth(way) + 0.8, slabColor)
      // опоры: не чаще чем через ~25 м, только там, где мост заметно над землёй
      let last = -Infinity, run = 0
      pts.forEach((p, i) => {
        if (i > 0) run += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z)
        if (p.y > 1.5 && run - last >= 25) { pillars.push({ x: p.x, y: p.y - 0.7, z: p.z }); last = run }
      })
    }
  }

  const roads = roadBuf.idx.length
    ? new THREE.Mesh(toGeometry(roadBuf), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }))
    : null
  if (roads) root.add(roads)
  if (slabBuf.idx.length) {
    root.add(new THREE.Mesh(toGeometry(slabBuf), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })))
  }

  // ---- опоры мостов ----
  if (pillars.length) {
    const inst = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.6, 0.8, 1, 10), new THREE.MeshLambertMaterial({ color: '#8d939c' }), pillars.length,
    )
    const m = new THREE.Matrix4()
    pillars.forEach((p, i) => {
      m.compose(new THREE.Vector3(p.x, p.y / 2, p.z), new THREE.Quaternion(), new THREE.Vector3(1, Math.max(0.1, p.y), 1))
      inst.setMatrixAt(i, m)
    })
    root.add(inst)
  }

  // ---- светофоры ----
  const signals = [...doc.nodes.values()].filter((n) => n.tags.highway === 'traffic_signals' && nodeY.has(n.id))
  if (signals.length) {
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.12, 5, 6), new THREE.MeshLambertMaterial({ color: '#2f343b' }), signals.length)
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 1.5, 0.6), new THREE.MeshLambertMaterial({ color: '#2e9e4d' }), signals.length)
    const m = new THREE.Matrix4()
    signals.forEach((n, i) => {
      const w = world(n.lat, n.lon)
      const y = nodeY.get(n.id) ?? 0
      m.makeTranslation(w.x, y + 2.5, w.z); poles.setMatrixAt(i, m)
      m.makeTranslation(w.x, y + 5.2, w.z); heads.setMatrixAt(i, m)
    })
    root.add(poles, heads)
  }

  // ---- здания ----
  let buildingCount = 0
  if (opts.buildings) {
    const geos: THREE.BufferGeometry[] = []
    for (const way of doc.ways.values()) {
      if (!way.tags.building || way.nodes.length < 4 || way.nodes[0] !== way.nodes.at(-1)) continue
      const pts = way.nodes.slice(0, -1).map((id) => doc.nodes.get(id)).filter((n): n is NonNullable<typeof n> => !!n)
      if (pts.length < 3) continue
      const shape = new THREE.Shape(pts.map((n) => { const w = world(n.lat, n.lon); return new THREE.Vector2(w.x, -w.z) }))
      const h = parseFloat(way.tags.height ?? '') || (parseFloat(way.tags['building:levels'] ?? '') || 2) * 3
      const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(3, h), bevelEnabled: false })
      g.rotateX(-Math.PI / 2) // выдавливание вверх по Y
      // оставляем только общие атрибуты, иначе mergeGeometries откажется склеивать
      g.deleteAttribute('uv')
      geos.push(g)
    }
    buildingCount = geos.length
    if (geos.length) {
      const merged = mergeGeometries(geos, false)
      merged.computeVertexNormals()
      root.add(new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color: '#cfc9bd' })))
      geos.forEach((g) => g.dispose())
    }
  }

  // ---- земля и свет ----
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(radius * 8, radius * 8), new THREE.MeshLambertMaterial({ color: '#e7e5dd' }))
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.15
  root.add(ground)
  root.add(new THREE.HemisphereLight('#ffffff', '#8a8f99', 1.15))
  const sun = new THREE.DirectionalLight('#ffffff', 1.0)
  sun.position.set(radius * 0.6, radius * 1.2, radius * 0.4)
  root.add(sun)

  const wayById = (id: number) => doc.ways.get(id)
  return {
    root, roads, faceWay, radius,
    wayRibbon(wayId, extraWidth, dy) {
      const way = wayById(wayId)
      if (!way) return null
      const buf: Buf = { pos: [], col: [], idx: [] }
      addRibbon(buf, wayPoints(way, 0.3 + dy), roadWidth(way) + extraWidth, new THREE.Color('#00b0ff'))
      return buf.idx.length ? toGeometry(buf) : null
    },
    stats: { roads: hwWays.length, buildings: buildingCount, bridges, signals: signals.length },
  }
}

/** Освободить память сцены. */
export function disposeScene(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh
    m.geometry?.dispose?.()
    const mat = m.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
    else mat?.dispose?.()
  })
}
