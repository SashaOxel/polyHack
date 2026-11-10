import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { elevationContext, wayProfile } from '../core/elevation'
import { dashPolyline, offsetPolyline, project } from '../core/geo'
import { hasCrossing, hasSignal, isDrivable, isParkingArea, isTram, laneInfo, roadStyle, wayLevel } from '../core/roads'
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
  /** трамвайные пути (по умолчанию да) */
  tram?: boolean
  /** разметка полос (по умолчанию да) */
  lanes?: boolean
  /** ночь: тёмное небо, луна, фонари вдоль улиц, светящаяся разметка */
  night?: boolean
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
  /** lat/lon → мировые координаты сцены (X — восток, Z — юг) */
  toWorld(lat: number, lon: number): { x: number; z: number }
  /** высота узла в сцене (с учётом мостов и масштаба высот), если узел на дороге */
  nodeY(id: number): number | undefined
  /** точка над серединой дороги (по длине) — для подписи/знака */
  wayAnchor(wayId: number, lift?: number): THREE.Vector3 | null
  stats: { roads: number; buildings: number; bridges: number; signals: number; crossings: number; trams: number }
}

const LANE_W = 3.2

/** Ширина проезжей части, м: число полос × 3,2 м (по тегам, иначе по правилам OSM для двусторонней/односторонней). */
export function roadWidth(way: OsmWay): number {
  const li = laneInfo(way)
  if (!li) return 1.8 // пешеходные дорожки
  return Math.max(3.5, li.total * LANE_W)
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
  const markBuf: Buf = { pos: [], col: [], idx: [] } // дорожная разметка: пунктир между полосами
  const white = new THREE.Color('#f6f6f2'), yellow = new THREE.Color('#ffd54f')
  const faceWay: number[] = []
  const pillars: (P & { r: number })[] = []
  const tunnelBuf: Buf = { pos: [], col: [], idx: [] } // тоннели «на просвет» сквозь землю
  const crossings: { x: number; y: number; z: number; dx: number; dz: number; width: number }[] = []
  const crossingNodes = new Set<number>()
  const nodeY = new Map<number, number>()
  const slabColor = new THREE.Color('#2b2f36')
  let bridges = 0

  for (const way of hwWays) {
    const drivable = isDrivable(way)
    const pts = wayPoints(way, 0.01 * roadStyle(way.tags.highway).width)
    for (const q of pts) if (q.id !== undefined && !nodeY.has(q.id)) nodeY.set(q.id, q.y)
    const color = new THREE.Color(drivable ? roadStyle(way.tags.highway).color : '#d9d3c7')
    if (drivable) color.lerp(new THREE.Color('#4a515d'), 0.5) // приглушаем под «асфальт», класс остаётся читаемым
    addRibbon(roadBuf, pts, roadWidth(way), color, { faceWay, wayId: way.id })

    // разметка полос: пунктир между полосами, встречная линия жёлтая; у перекрёстков (6 м от концов) не рисуем
    const li = drivable && opts.lanes !== false ? laneInfo(way) : null
    if (li && li.total >= 2 && pts.length >= 2) {
      const flat = pts.map((q) => ({ x: q.x, y: q.z, h: q.y })) // «y» здесь — вторая горизонтальная ось (Z мира)
      const widthM = li.total * LANE_W
      for (let i = 1; i < li.total; i++) {
        const line = offsetPolyline(flat, -widthM / 2 + i * LANE_W)
        for (const piece of dashPolyline(line, 3, 5, 6)) {
          addRibbon(markBuf, piece.map((q) => ({ x: q.x, y: (q.h ?? 0) + 0.11, z: q.y })), 0.15, li.centerAfter === i ? yellow : white)
        }
      }
    }

    // пешеходные переходы (узлы highway=crossing или crossing=* на проезжей дороге)
    if (drivable) {
      pts.forEach((q, i) => {
        if (q.id === undefined || crossingNodes.has(q.id) || !hasCrossing(doc.nodes.get(q.id)?.tags ?? {})) return
        crossingNodes.add(q.id)
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]
        crossings.push({ x: q.x, y: q.y, z: q.z, dx: b.x - a.x, dz: b.z - a.z, width: roadWidth(way) })
      })
    }

    const level = wayLevel(way)
    if (level === 'bridge') {
      // любой мост — и автомобильный, и пешеходный (надземный переход): настил и опоры
      bridges++
      const deck = drivable ? 0.7 : 0.35
      addRibbon(slabBuf, pts.map((p) => ({ ...p, y: p.y - deck })), roadWidth(way) + (drivable ? 0.8 : 0.5), slabColor)
      // опоры: не чаще чем через ~25 м (у пешеходных — 12 м и тоньше), только там, где мост заметно над землёй
      const step = drivable ? 25 : 12
      let last = -Infinity, run = 0
      pts.forEach((p, i) => {
        if (i > 0) run += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z)
        if (p.y > 1.5 && run - last >= step) { pillars.push({ x: p.x, y: p.y - deck, z: p.z, r: drivable ? 1 : 0.4 }); last = run }
      })
    } else if (level === 'tunnel') {
      addRibbon(tunnelBuf, pts, roadWidth(way), new THREE.Color(drivable ? '#94a3b8' : '#c4b5fd'))
    }
  }

  const night = !!opts.night
  const roads = roadBuf.idx.length
    ? new THREE.Mesh(toGeometry(roadBuf), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }))
    : null
  if (roads) { roads.receiveShadow = true; root.add(roads) }
  // ---- трамвайные пути: балласт и два рельса (колея 1524 мм) поверх улицы ----
  const tramWays = opts.tram === false ? [] : [...doc.ways.values()].filter(isTram)
  const tramBuf: Buf = { pos: [], col: [], idx: [] }
  const ballast = new THREE.Color('#8b8680'), rail = new THREE.Color('#3b3f45')
  for (const way of tramWays) {
    const pts = wayPoints(way, 0.12)
    if (pts.length < 2) continue
    addRibbon(tramBuf, pts, 2.6, ballast)
    const flat = pts.map((q) => ({ x: q.x, y: q.z, h: q.y }))
    for (const off of [-0.76, 0.76]) {
      addRibbon(tramBuf, offsetPolyline(flat, off).map((q) => ({ x: q.x, y: (q.h ?? 0) + 0.05, z: q.y })), 0.14, rail)
    }
  }
  if (tramBuf.idx.length) {
    root.add(new THREE.Mesh(toGeometry(tramBuf), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })))
  }

  if (markBuf.idx.length) {
    // ночью разметка светится (не зависит от освещения)
    root.add(new THREE.Mesh(toGeometry(markBuf), night
      ? new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })
      : new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })))
  }
  if (slabBuf.idx.length) {
    root.add(new THREE.Mesh(toGeometry(slabBuf), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })))
  }

  // ---- тоннели: полупрозрачно и поверх земли, чтобы было видно, где они проходят ----
  if (tunnelBuf.idx.length) {
    const tunnels = new THREE.Mesh(toGeometry(tunnelBuf), new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    }))
    tunnels.renderOrder = 2
    root.add(tunnels)
  }

  // ---- парковки: наземные — площадка, многоуровневые — объём, подземные — контур на просвет ----
  const parkFlat: THREE.BufferGeometry[] = [], parkUnder: THREE.BufferGeometry[] = [], parkTall: THREE.BufferGeometry[] = []
  for (const way of doc.ways.values()) {
    if (!isParkingArea(way)) continue
    const pts = way.nodes.slice(0, -1).map((id) => doc.nodes.get(id)).filter((n): n is NonNullable<typeof n> => !!n)
    if (pts.length < 3) continue
    const shape = new THREE.Shape(pts.map((n) => { const w = world(n.lat, n.lon); return new THREE.Vector2(w.x, -w.z) }))
    const kind = way.tags.parking ?? 'surface'
    if (kind === 'multi-storey') {
      const levels = parseFloat(way.tags['building:levels'] ?? '') || 3
      const g = new THREE.ExtrudeGeometry(shape, { depth: levels * 3, bevelEnabled: false })
      g.rotateX(-Math.PI / 2); g.deleteAttribute('uv')
      parkTall.push(g)
    } else {
      const g = new THREE.ShapeGeometry(shape)
      g.rotateX(-Math.PI / 2); g.translate(0, kind === 'underground' ? 0.06 : 0.03, 0); g.deleteAttribute('uv')
      ;(kind === 'underground' ? parkUnder : parkFlat).push(g)
    }
  }
  const addMerged = (list: THREE.BufferGeometry[], mat: THREE.Material, shadow: boolean) => {
    if (!list.length) return
    const mesh = new THREE.Mesh(mergeGeometries(list, false), mat)
    mesh.receiveShadow = true; mesh.castShadow = shadow
    root.add(mesh)
    list.forEach((g) => g.dispose())
  }
  addMerged(parkFlat, new THREE.MeshLambertMaterial({ color: night ? '#1e293b' : '#6b7280', side: THREE.DoubleSide }), false)
  addMerged(parkUnder, new THREE.MeshBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }), false)
  addMerged(parkTall, new THREE.MeshLambertMaterial({ color: night ? '#3b4a63' : '#a3aab5' }), true)

  // ---- опоры мостов ----
  if (pillars.length) {
    const inst = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.6, 0.8, 1, 10), new THREE.MeshLambertMaterial({ color: '#8d939c' }), pillars.length,
    )
    const m = new THREE.Matrix4()
    pillars.forEach((p, i) => {
      m.compose(new THREE.Vector3(p.x, p.y / 2, p.z), new THREE.Quaternion(), new THREE.Vector3(p.r, Math.max(0.1, p.y), p.r))
      inst.setMatrixAt(i, m)
    })
    root.add(inst)
  }

  // ---- светофоры: узлы highway=traffic_signals ----
  const spots = [...doc.nodes.values()].filter((n) => hasSignal(n.tags) && nodeY.has(n.id))
    .map((n) => { const w = world(n.lat, n.lon); return { x: w.x, y: nodeY.get(n.id) ?? 0, z: w.z } })
  if (spots.length) {
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.12, 5, 6), new THREE.MeshLambertMaterial({ color: '#2f343b' }), spots.length)
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 1.5, 0.6), new THREE.MeshLambertMaterial({ color: '#2e9e4d' }), spots.length)
    const m = new THREE.Matrix4()
    spots.forEach((p, i) => {
      m.makeTranslation(p.x, p.y + 2.5, p.z); poles.setMatrixAt(i, m)
      m.makeTranslation(p.x, p.y + 5.2, p.z); heads.setMatrixAt(i, m)
    })
    root.add(poles, heads)
  }

  // ---- пешеходные переходы: белая «зебра» поперёк дороги ----
  if (crossings.length) {
    const STRIPES = 6
    const stripes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: '#f4f4f2' }), crossings.length * STRIPES)
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    let n = 0
    for (const c of crossings) {
      const len = Math.hypot(c.dx, c.dz) || 1
      const ux = c.dx / len, uz = c.dz / len
      q.setFromAxisAngle(up, -Math.atan2(uz, ux)) // ось X полосы вдоль дороги
      for (let k = 0; k < STRIPES; k++) {
        const t = (k - (STRIPES - 1) / 2) * 1.1
        pos.set(c.x + ux * t, c.y + 0.14, c.z + uz * t)
        sc.set(0.55, 0.06, c.width * 0.95)
        m.compose(pos, q, sc)
        stripes.setMatrixAt(n++, m)
      }
    }
    root.add(stripes)
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
      const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial(night
        ? { color: '#47526a', emissive: '#10182b' }
        : { color: '#d8d2c6' }))
      mesh.castShadow = true
      mesh.receiveShadow = true
      root.add(mesh)
      geos.forEach((g) => g.dispose())
    }
  }

  // ---- земля и свет ----
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(radius * 8, radius * 8), new THREE.MeshLambertMaterial({ color: night ? '#101a2e' : '#e4e2d8', polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }))
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.15
  ground.receiveShadow = true
  root.add(ground)
  root.add(night ? new THREE.HemisphereLight('#7f9fd6', '#0a1020', 1.1) : new THREE.HemisphereLight('#ffffff', '#8a8f99', 1.0))
  // солнце (днём) или луна (ночью) с мягкими тенями
  const sun = new THREE.DirectionalLight(night ? '#a8c0ff' : '#fff4e0', night ? 0.6 : 1.8)
  sun.position.set(radius * 0.6, radius * 1.1, radius * 0.45)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  const sc = sun.shadow.camera
  sc.left = -radius * 1.2; sc.right = radius * 1.2; sc.top = radius * 1.2; sc.bottom = -radius * 1.2
  sc.near = 1; sc.far = radius * 4
  sun.shadow.bias = -0.0006
  sun.shadow.normalBias = 0.6
  root.add(sun, sun.target)

  // ночью: фонари вдоль улиц (через ~32 м, попеременно по сторонам) — светящиеся точки
  if (night) {
    const lamps: number[] = []
    for (const way of hwWays) {
      if (!isDrivable(way) || way.tags.highway === 'service') continue
      const pts = wayPoints(way)
      const half = roadWidth(way) / 2 + 1.2
      let run = 0, next = 10, side = 1
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i]
        const seg = Math.hypot(b.x - a.x, b.z - a.z)
        if (seg < 0.01) continue
        const ux = (b.x - a.x) / seg, uz = (b.z - a.z) / seg
        while (next <= run + seg) {
          const t = (next - run) / seg
          lamps.push(a.x + (b.x - a.x) * t - uz * half * side, a.y + (b.y - a.y) * t + 7, a.z + (b.z - a.z) * t + ux * half * side)
          side = -side
          next += 32
        }
        run += seg
      }
    }
    if (lamps.length) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(lamps, 3))
      root.add(new THREE.Points(g, new THREE.PointsMaterial({
        size: 9, map: glowTexture(), color: '#ffd38a', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
      })))
    }
  }

  const wayById = (id: number) => doc.ways.get(id)
  return {
    root, roads, faceWay, radius,
    toWorld: world,
    nodeY: (id) => nodeY.get(id),
    wayAnchor(wayId, lift = 6) {
      const way = wayById(wayId)
      if (!way) return null
      const pts = wayPoints(way)
      if (!pts.length) return null
      let total = 0
      for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
      let left = total / 2
      for (let i = 1; i < pts.length; i++) {
        const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
        if (left <= seg || i === pts.length - 1) {
          const t = seg > 0 ? Math.min(1, left / seg) : 0
          const a = pts[i - 1], b = pts[i]
          return new THREE.Vector3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t + lift, a.z + (b.z - a.z) * t)
        }
        left -= seg
      }
      return new THREE.Vector3(pts[0].x, pts[0].y + lift, pts[0].z)
    },
    wayRibbon(wayId, extraWidth, dy) {
      const way = wayById(wayId)
      if (!way) return null
      const buf: Buf = { pos: [], col: [], idx: [] }
      addRibbon(buf, wayPoints(way, 0.3 + dy), roadWidth(way) + extraWidth, new THREE.Color('#00b0ff'))
      return buf.idx.length ? toGeometry(buf) : null
    },
    stats: { roads: hwWays.length, buildings: buildingCount, bridges, signals: spots.length, crossings: crossings.length, trams: tramWays.length },
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

let glow: THREE.Texture | null = null
/** Мягкое круглое пятно света (для фонарей, фар, сигналов). */
export function glowTexture(): THREE.Texture {
  if (glow) return glow
  if (typeof document === 'undefined') return (glow = new THREE.Texture())
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.25, 'rgba(255,255,255,0.75)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  glow = new THREE.CanvasTexture(c)
  return glow
}
