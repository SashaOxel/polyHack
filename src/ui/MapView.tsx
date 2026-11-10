import { useEffect, useRef, useSyncExternalStore } from 'react'
import { offsetPolyline, project, unproject } from '../core/geo'
import { Icon } from './icons'
import { Minimap, scaleBar } from './overlays'
import { drawCrossingIcon, drawSignalIcon } from './roadIcons'
import { drawSpeedSign } from './speedSign'
import { GROUP_COLORS, readPlan, turnsAt } from '../core/signals'
import type { Layers } from './layers'
import { GLOW_CLASSES, PALETTES, type Theme } from './theme'
import { traffic } from './trafficController'
import { routeUi } from './routeUi'
import { readRoute, resolveStop, type RouteStop } from '../core/routes'
import { linkStopToNode } from '../core/ops'
import { isStopPlatform, linkedStop, nearestFreeRoadNode, nearestWayNode, stopsAt } from '../core/stops'
import { drawArea, placeBusStop, drawRoad, placeRoadFeature, insertNodeOnWay, mergeNodes, moveNode, type DrawPoint } from '../core/ops'
import { hasCrossing, hasSignal, isDrivable, isParkingArea, isTram, laneInfo, wayLevel, onewayDirection, roadStyle, speedLimit, wayMidpoint } from '../core/roads'
import { store } from '../core/store'
import type { OsmWay, Tags } from '../core/types'
import type { Issue } from '../validate'
import { drawTiles, type View } from './tiles'

export type Tool = 'select' | 'draw' | 'node' | 'signal' | 'crossing' | 'stop' | 'parking'

interface Props {
  tileUrl: string
  issues: Issue[]
  /** какие объекты рисовать (кнопки «Слои») */
  layers: Layers
  theme: Theme
  focus: { lat: number; lon: number; n: number } | null
  tool: Tool
  /** теги новой дороги в режиме рисования */
  drawTags: Tags
  /** подсказки/сообщения в строку состояния */
  onHint: (msg: string) => void
  onStopCreated: () => void
}

const HIT = 8

/**
 * Кэш отрисовки на версию документа: проекции узлов, рамки дорог для отсечения, отсортированный список дорог,
 * полосы, привязанные остановки. Пересчитывается только при правке, а не на каждом кадре.
 */
interface RenderCache {
  docVersion: number
  doc: object
  merc: Map<number, { x: number; y: number }>
  box: Map<number, [number, number, number, number]>
  ways: OsmWay[]
  trams: OsmWay[]
  lanes: Map<number, ReturnType<typeof laneInfo>>
  linkedPlatforms: Set<number>
  stopPlatforms: number[]
  parkings: OsmWay[]
  parkingNodes: number[]
}
let renderCache: RenderCache | null = null
function getRenderCache(): RenderCache {
  const doc = store.doc
  if (renderCache && renderCache.docVersion === store.docVersion && renderCache.doc === doc) return renderCache
  const merc = new Map<number, { x: number; y: number }>()
  for (const n of doc.nodes.values()) merc.set(n.id, project(n.lat, n.lon))
  const box = new Map<number, [number, number, number, number]>()
  const ways: OsmWay[] = [], trams: OsmWay[] = []
  const lanes = new Map<number, ReturnType<typeof laneInfo>>()
  const parkings: OsmWay[] = []
  for (const w of doc.ways.values()) {
    const tram = isTram(w)
    const parking = isParkingArea(w)
    if (!w.tags.highway && !tram && !parking) continue
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const id of w.nodes) {
      const m = merc.get(id)
      if (!m) continue
      if (m.x < x0) x0 = m.x; if (m.x > x1) x1 = m.x; if (m.y < y0) y0 = m.y; if (m.y > y1) y1 = m.y
    }
    box.set(w.id, [x0, y0, x1, y1])
    if (parking) parkings.push(w)
    else if (tram) trams.push(w)
    else { ways.push(w); lanes.set(w.id, laneInfo(w)) }
  }
  // порядок: пешеходные → служебные → основные (по толщине линии класса)
  ways.sort((a, b) => roadStyle(a.tags.highway).width - roadStyle(b.tags.highway).width)
  const linkedPlatforms = new Set<number>()
  for (const r of doc.relations.values()) { const st = linkedStop(r); if (st) linkedPlatforms.add(st.platform) }
  const stopPlatforms = [...doc.nodes.values()].filter((n) => isStopPlatform(n.tags)).map((n) => n.id)
  const parkingNodes = [...doc.nodes.values()].filter((n) => n.tags.amenity === 'parking').map((n) => n.id)
  renderCache = { docVersion: store.docVersion, doc, merc, box, ways, trams, lanes, linkedPlatforms, stopPlatforms, parkings, parkingNodes }
  return renderCache
}

/** Результат привязки курсора: к узлу, к отрезку дороги или никуда. */
type Snap =
  | { kind: 'node'; id: number; lat: number; lon: number }
  | { kind: 'way'; wayId: number; lat: number; lon: number }

export function MapView({ tileUrl, issues, layers, theme, focus, tool, drawTags, onHint, onStopCreated }: Props) {
  const showNodeIds = layers.nodeIds, showPedestrian = layers.pedestrian
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const canvas = useRef<HTMLCanvasElement>(null)
  /** отдельный прозрачный слой для машин: его можно перерисовывать 60 раз в секунду, не трогая сеть */
  const dynCanvas = useRef<HTMLCanvasElement>(null)
  const dirty = useRef({ map: false, cars: false })
  const view = useRef<View>({ cx: 0, cy: 0, scale: 0.1 })
  const drag = useRef<null | { kind: 'pan' | 'node'; id?: number; sx: number; sy: number; moved: boolean }>(null)
  const dragPos = useRef<{ id: number; lat: number; lon: number } | null>(null)
  const stopAnchor = useRef<Snap | null>(null)
  const draft = useRef<DrawPoint[]>([])
  const hover = useRef<{ x: number; y: number; snap: Snap | null } | null>(null)
  const raf = useRef(0)
  // оверлеи обновляются напрямую в DOM из draw(), без перерисовки React
  const mini = useRef(new Minimap())
  const miniCanvas = useRef<HTMLCanvasElement>(null)
  const miniBox = useRef<HTMLDivElement>(null)
  const barEl = useRef<HTMLDivElement>(null)
  const barLabel = useRef<HTMLSpanElement>(null)
  const coordsEl = useRef<HTMLDivElement>(null)
  const fitScale = useRef(0)
  /** где показать знак скорости: точка клика по выбранной дороге */
  const signAt = useRef<{ wayId: number; lat: number; lon: number } | null>(null)
  const miniDrag = useRef(false)
  const props = useRef({ tileUrl, issues, layers, theme, showNodeIds, showPedestrian, tool, drawTags, onHint, onStopCreated })
  props.current = { tileUrl, issues, layers, theme, showNodeIds, showPedestrian, tool, drawTags, onHint, onStopCreated }

  /** Перерисовать всё (сдвиг, масштаб, правка). Не чаще одного раза за кадр. */
  const redraw = () => { dirty.current.map = true; dirty.current.cars = true; schedule() }
  /** Перерисовать только машины (кадр движения). */
  const redrawCars = () => { dirty.current.cars = true; schedule() }
  const schedule = () => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      const t0 = performance.now()
      if (dirty.current.map) { dirty.current.map = false; draw() }
      const t1 = performance.now()
      if (dirty.current.cars) { dirty.current.cars = false; drawCars() }
      if (import.meta.env.DEV) {
        // журнал времени кадров для замеров из консоли: __mapLog.map / __mapLog.cars (мс)
        const w = window as unknown as { __mapLog?: { map: number[]; cars: number[] } }
        const log = (w.__mapLog ??= { map: [], cars: [] })
        if (t1 - t0 > 0) log.map.push(t1 - t0)
        log.cars.push(performance.now() - t1)
        if (log.map.length > 500) log.map.shift()
        if (log.cars.length > 500) log.cars.shift()
      }
    })
  }

  // ----- координаты -----
  const toScreen = (lat: number, lon: number, w: number, h: number) => {
    const p = project(lat, lon)
    const v = view.current
    return { x: (p.x - v.cx) * v.scale + w / 2, y: (v.cy - p.y) * v.scale + h / 2 }
  }
  const fromScreen = (sx: number, sy: number, w: number, h: number) => {
    const v = view.current
    return unproject(v.cx + (sx - w / 2) / v.scale, v.cy - (sy - h / 2) / v.scale)
  }

  function fit(): boolean {
    const c = canvas.current
    const doc = store.doc
    if (!c || doc.nodes.size === 0) return false
    if (c.getBoundingClientRect().width === 0) return false // карта скрыта (режим 3D)
    let b = doc.bounds
    if (!b) {
      let minlat = 90, minlon = 180, maxlat = -90, maxlon = -180
      for (const n of doc.nodes.values()) {
        minlat = Math.min(minlat, n.lat); maxlat = Math.max(maxlat, n.lat)
        minlon = Math.min(minlon, n.lon); maxlon = Math.max(maxlon, n.lon)
      }
      b = { minlat, minlon, maxlat, maxlon }
    }
    const a = project(b.minlat, b.minlon)
    const z = project(b.maxlat, b.maxlon)
    const r = c.getBoundingClientRect()
    view.current = {
      cx: (a.x + z.x) / 2,
      cy: (a.y + z.y) / 2,
      scale: Math.min(r.width / (z.x - a.x), r.height / (z.y - a.y)) * 0.92,
    }
    fitScale.current = view.current.scale
    return true
  }

  /** Масштаб кнопками ± вокруг центра карты. */
  function zoomBy(k: number) {
    const v = view.current
    v.scale = Math.max(0.005, Math.min(40, v.scale * k))
    redraw()
  }

  /** Масштабная линейка, миникарта (видна только при приближении) — обновляются из draw(). */
  function updateOverlays(w: number, h: number, dpr: number) {
    const v = view.current
    const sb = scaleBar(v)
    if (barEl.current && barLabel.current) {
      barEl.current.style.width = `${Math.round(sb.px)}px`
      barLabel.current.textContent = sb.label
    }
    const m = mini.current
    m.update(store.doc, store.docVersion, dpr, props.current.theme)
    // показываем миникарту, когда окно покрывает заметно меньше половины сети
    const zoomedIn = fitScale.current > 0 && v.scale > fitScale.current * 1.5
    if (miniBox.current) miniBox.current.style.display = zoomedIn && m.ready ? 'block' : 'none'
    if (zoomedIn && m.ready && miniCanvas.current) m.draw(miniCanvas.current, v, w, h, dpr)
  }

  const miniMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const p = mini.current.toWorld(e.clientX - r.left, e.clientY - r.top)
    view.current.cx = p.x
    view.current.cy = p.y
    redraw()
  }

  function draw() {
    const c = canvas.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const r = c.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
      c.width = Math.round(r.width * dpr)
      c.height = Math.round(r.height * dpr)
    }
    const ctx = c.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const w = r.width, h = r.height
    const pal = PALETTES[props.current.theme]
    ctx.fillStyle = pal.mapBg
    ctx.fillRect(0, 0, w, h)
    drawTiles(ctx, view.current, w, h, props.current.tileUrl, redraw, pal.tileFilter !== 'none')
    if (props.current.tileUrl) {
      ctx.fillStyle = pal.tileOverlay
      ctx.fillRect(0, 0, w, h)
    }

    const doc = store.doc
    const zoomK = Math.max(0.5, Math.min(3, Math.sqrt(view.current.scale / 0.15)))
    const cache = getRenderCache()
    const v0 = view.current
    const pos = (id: number) => {
      const dp = dragPos.current
      const m = dp && dp.id === id ? project(dp.lat, dp.lon) : cache.merc.get(id)
      if (!m) return null
      return { x: (m.x - v0.cx) * v0.scale + w / 2, y: (v0.cy - m.y) * v0.scale + h / 2 }
    }
    // видимая область (метры Меркатора) с запасом — всё, что за экраном, не рисуем
    const pad = 80 / v0.scale
    const vx0 = v0.cx - w / 2 / v0.scale - pad, vx1 = v0.cx + w / 2 / v0.scale + pad
    const vy0 = v0.cy - h / 2 / v0.scale - pad, vy1 = v0.cy + h / 2 / v0.scale + pad
    const dragged = dragPos.current?.id
    const onScreen = (way: OsmWay) => {
      const b = cache.box.get(way.id)
      if (!b) return false
      if (b[2] >= vx0 && b[0] <= vx1 && b[3] >= vy0 && b[1] <= vy1) return true
      return dragged !== undefined && way.nodes.includes(dragged)
    }

    // порядок: пешеходные → служебные → основные
    const L = props.current.layers
    const ways = cache.ways.filter(onScreen)
    const trams = L.tram ? cache.trams.filter(onScreen) : []

    // масштаб в реальных метрах: Меркатор растягивает расстояния на широте, поэтому делим на cos(широты)
    const LANE_M = 3.2
    const ppm = view.current.scale / Math.cos((unproject(view.current.cx, view.current.cy).lat * Math.PI) / 180) // px на метр
    const laneW = LANE_M * ppm
    const laneMode = laneW >= 4.5 // достаточно крупно, чтобы рисовать полосы
    /** Ширина дороги на экране: не уже обычной линии и не уже реальной ширины полос. */
    const roadPx = (way: OsmWay) => {
      const st = roadStyle(way.tags.highway)
      const base = (st.width + ((Number(way.tags.lanes) || 1) - 1) * 0.8) * zoomK
      const li = cache.lanes.get(way.id) ?? laneInfo(way)
      // пешеходная дорожка на крупном плане — реальные ~2 м, а не тонкая линия
      return li ? Math.max(base, li.total * laneW) : Math.max(base, 1.8 * ppm)
    }

    // парковки: площадь с буквой P (под дорогами)
    if (L.parking) {
      const fill = pal.glow ? 'rgba(56,189,248,0.14)' : 'rgba(37,99,235,0.12)', edge = pal.glow ? 'rgba(56,189,248,0.6)' : 'rgba(37,99,235,0.55)'
      ctx.save()
      ctx.lineWidth = 1.5
      for (const pk of cache.parkings) {
        if (!onScreen(pk)) continue
        const pts = pk.nodes.map(pos).filter((p): p is { x: number; y: number } => !!p)
        if (pts.length < 3) continue
        ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath()
        const under = pk.tags.parking === 'underground'
        ctx.fillStyle = fill; ctx.fill()
        ctx.setLineDash(under ? [5, 4] : []); ctx.strokeStyle = edge; ctx.stroke(); ctx.setLineDash([])
        // «P» в центре, если площадь заметна на экране
        let cx = 0, cy = 0, x0 = Infinity, x1 = -Infinity
        for (const p of pts) { cx += p.x; cy += p.y; x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x) }
        cx /= pts.length; cy /= pts.length
        if (x1 - x0 > 22) {
          const r = Math.min(11, (x1 - x0) / 4)
          ctx.fillStyle = pal.glow ? '#0284c7' : '#2563eb'
          ctx.beginPath(); ctx.roundRect(cx - r, cy - r, r * 2, r * 2, r * 0.3); ctx.fill()
          ctx.fillStyle = '#fff'; ctx.font = `700 ${Math.round(r * 1.3)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillText(under ? 'P↓' : pk.tags.parking === 'multi-storey' ? 'P≡' : 'P', cx, cy + 0.5)
        }
      }
      for (const id of cache.parkingNodes) {
        const p = pos(id)
        if (!p || p.x < -10 || p.y < -10 || p.x > w + 10 || p.y > h + 10) continue
        ctx.fillStyle = pal.glow ? '#0284c7' : '#2563eb'
        ctx.beginPath(); ctx.roundRect(p.x - 8, p.y - 8, 16, 16, 3); ctx.fill()
        ctx.fillStyle = '#fff'; ctx.font = '700 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText('P', p.x, p.y + 0.5)
      }
      ctx.restore()
    }

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const sel = store.selection
    // дороги одного стиля обводятся одним вызовом stroke (их тысячи — по отдельности это и тормозило)
    let batch = { key: '', width: 0, color: '', dash: false, glow: false }
    const flush = () => {
      if (!batch.key) return
      ctx.setLineDash(batch.dash ? [3, 3] : [])
      if (batch.glow) { ctx.globalAlpha = 0.25; ctx.lineWidth = batch.width + 7; ctx.strokeStyle = batch.color; ctx.stroke(); ctx.globalAlpha = 1 }
      ctx.lineWidth = batch.width; ctx.strokeStyle = batch.color; ctx.stroke()
      ctx.setLineDash([])
      batch = { key: '', width: 0, color: '', dash: false, glow: false }
    }
    const arrows: { x: number; y: number; a: number }[] = []
    for (const way of ways) {
      const drivable = isDrivable(way)
      if (!drivable && !props.current.showPedestrian) continue
      if (drivable && !L.car) continue
      const li = cache.lanes.get(way.id)
      const screenPts: { x: number; y: number }[] = []
      for (const nid of way.nodes) { const p = pos(nid); if (p) screenPts.push(p) }
      if (screenPts.length < 2) continue
      const W = roadPx(way)
      const roadColor = pal.road(way.tags.highway)
      const lanesVisible = drivable && L.lanes && laneMode && !!li
      // тёмная тема: магистрали светятся (широкая полупрозрачная обводка вместо дорогого размытия)
      const glowing = pal.glow && !lanesVisible && GLOW_CLASSES.has(way.tags.highway ?? '')

      const level = wayLevel(way)
      if (!lanesVisible && level === 'ground') {
        const width = Math.round(W * 2) / 2
        const key = `${roadColor}|${width}|${drivable ? 0 : 1}|${glowing ? 1 : 0}`
        if (key !== batch.key) { flush(); ctx.beginPath(); batch = { key, width, color: roadColor, dash: !drivable, glow: glowing } }
        screenPts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
      } else {
        flush()
        ctx.beginPath()
        screenPts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
        ctx.lineWidth = W
        ctx.strokeStyle = roadColor
        if (!drivable) ctx.setLineDash([3, 3]); else ctx.setLineDash([])
        if (level === 'bridge') {
          // мост: заметный кант с обеих сторон (видно и у тонкой пешеходной дорожки)
          ctx.save(); ctx.setLineDash([]); ctx.lineCap = 'butt'
          ctx.lineWidth = W + 6; ctx.strokeStyle = pal.glow ? '#cbd5e1' : '#1f2937'; ctx.stroke()
          ctx.lineWidth = W + 3; ctx.strokeStyle = pal.mapBg; ctx.stroke()
          ctx.restore()
        } else if (level === 'tunnel') {
          // тоннель: пунктирный кант и бледная дорога
          ctx.save(); ctx.setLineDash([4, 3]); ctx.lineCap = 'butt'
          ctx.lineWidth = W + 4; ctx.strokeStyle = pal.glow ? 'rgba(203,213,225,0.7)' : 'rgba(31,41,55,0.6)'; ctx.stroke()
          ctx.restore()
          ctx.globalAlpha = 0.45
        }
        if (lanesVisible) {
          // крупный план: цветной кант класса дороги и «асфальт» внутри, чтобы разметка читалась на любом цвете
          ctx.save(); ctx.lineWidth = W + 4; ctx.stroke(); ctx.restore()
          ctx.strokeStyle = pal.asphalt
        }
        if (glowing) { ctx.save(); ctx.globalAlpha = 0.25; ctx.lineWidth = W + 7; ctx.stroke(); ctx.restore() }
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = 1

        // разметка: пунктир между полосами; встречная линия двусторонней дороги жёлтая
        if (lanesVisible && li!.total >= 2) {
          ctx.save()
          ctx.lineCap = 'butt'
          ctx.setLineDash([Math.max(4, 3 * ppm), Math.max(4, 5 * ppm)])
          ctx.lineWidth = Math.max(1.2, 0.16 * ppm)
          const total = li!.total * laneW
          for (let i = 1; i < li!.total; i++) {
            ctx.strokeStyle = li!.centerAfter === i ? '#ffd54f' : 'rgba(255,255,255,0.95)'
            ctx.beginPath()
            offsetPolyline(screenPts, -total / 2 + i * laneW).forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)))
            ctx.stroke()
          }
          ctx.restore()
        }
      }

      // стрелки направления — собираем и рисуем одним проходом поверх дорог
      const dir = onewayDirection(way)
      if (dir !== 0 && drivable && zoomK > 0.8) {
        for (let i = 1; i < screenPts.length; i++) {
          const a = screenPts[i - 1], b = screenPts[i]
          const len = Math.hypot(b.x - a.x, b.y - a.y)
          if (len < 18) continue
          arrows.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, a: Math.atan2(b.y - a.y, b.x - a.x) + (dir === -1 ? Math.PI : 0) })
        }
      }
    }
    flush()
    if (arrows.length) {
      ctx.fillStyle = pal.glow ? '#0b1324' : '#222'
      ctx.beginPath()
      for (const ar of arrows) {
        const c = Math.cos(ar.a), sn = Math.sin(ar.a)
        const pt = (dx: number, dy: number) => [ar.x + dx * c - dy * sn, ar.y + dx * sn + dy * c] as const
        const [x1, y1] = pt(4, 0), [x2, y2] = pt(-3, -3), [x3, y3] = pt(-3, 3)
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.closePath()
      }
      ctx.fill()
    }

    // трамвайные пути поверх улиц: тёмная линия с белыми «шпалами» (классическое обозначение рельсов)
    for (const way of trams) {
      const pts = way.nodes.map(pos).filter((p): p is { x: number; y: number } => !!p)
      if (pts.length < 2) continue
      const W = Math.max(3, 2.4 * ppm)
      ctx.save()
      ctx.beginPath()
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
      ctx.lineCap = 'butt'
      ctx.strokeStyle = pal.tram; ctx.lineWidth = W; ctx.stroke()
      ctx.setLineDash([Math.max(4, W * 1.6), Math.max(4, W * 1.6)])
      ctx.strokeStyle = pal.tramTies; ctx.lineWidth = W * 0.45; ctx.stroke()
      ctx.restore()
    }

    // светофоры и узлы
    const showNodes = view.current.scale > 0.5
    const used = new Set<number>()
    for (const way of ways) if ((isDrivable(way) && L.car) || (!isDrivable(way) && props.current.showPedestrian)) for (const n of way.nodes) used.add(n)
    if (showNodes) {
      ctx.beginPath()
      for (const id of used) {
        const n = doc.nodes.get(id)
        if (!n || hasSignal(n.tags) || hasCrossing(n.tags)) continue // светофоры и переходы — иконками ниже
        const p = pos(id)
        if (!p || p.x < -10 || p.y < -10 || p.x > w + 10 || p.y > h + 10) continue
        ctx.moveTo(p.x + 2.5, p.y); ctx.arc(p.x, p.y, 2.5, 0, 7)
      }
      ctx.fillStyle = pal.nodeFill; ctx.strokeStyle = pal.nodeStroke; ctx.lineWidth = 1
      ctx.fill(); ctx.stroke()
    }

    // светофоры и переходы рисуются по тегам узлов (highway=traffic_signals / crossing)
    const iconSize = Math.max(16, Math.min(28, 10 * zoomK + 8))
    const crossLen = (hw: string | undefined) => roadStyle(hw).width * zoomK * 2.4
    const drawnIcons = new Set<number>()
    for (const way of ways) {
      if (!isDrivable(way) && !props.current.showPedestrian) continue
      if (isDrivable(way) && !L.car) continue
      way.nodes.forEach((nid, i) => {
        const n = doc.nodes.get(nid)
        const sig = !!n && L.signals && hasSignal(n.tags), cro = !!n && L.crossings && hasCrossing(n.tags)
        if (!n || (!sig && !cro) || drawnIcons.has(nid)) return
        if (!sig && view.current.scale < 0.25) return // на мелком масштабе зебры только мусорят
        const p = pos(nid)!
        if (p.x < -20 || p.y < -20 || p.x > w + 20 || p.y > h + 20) return
        drawnIcons.add(nid)
        if (cro && view.current.scale >= 0.25) {
          const a = pos(way.nodes[Math.max(0, i - 1)]), b = pos(way.nodes[Math.min(way.nodes.length - 1, i + 1)])
          drawCrossingIcon(ctx, p.x, p.y, a && b ? Math.atan2(b.y - a.y, b.x - a.x) : 0, crossLen(way.tags.highway))
        }
        if (sig) drawSignalIcon(ctx, p.x, p.y, iconSize)
      })
    }

    // проблемы
    for (const is of L.issues ? props.current.issues : []) {
      const pts: { lat: number; lon: number }[] = []
      if (is.at) pts.push(is.at)
      for (const wid of is.wayIds ?? []) {
        const way = doc.ways.get(wid)
        const n = way && doc.nodes.get(way.nodes[0])
        if (n) pts.push(n)
      }
      for (const nid of is.nodeIds ?? []) { const n = doc.nodes.get(nid); if (n) pts.push(n) }
      const color = is.severity === 'error' ? '#d32f2f' : '#ef6c00'
      for (const q of pts.slice(0, 1)) {
        const p = toScreen(q.lat, q.lon, w, h)
        ctx.strokeStyle = color; ctx.lineWidth = 2.5
        ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, 7); ctx.stroke()
      }
    }

    // рисуемая дорога: уже поставленные точки и «резинка» до курсора
    const tool = props.current.tool
    if (tool === 'draw' || tool === 'parking') {
      const pts = draft.current.map(pointLatLon).filter((p): p is { lat: number; lon: number } => !!p)
        .map((p) => toScreen(p.lat, p.lon, w, h))
      const hv = hover.current
      if (pts.length) {
        const tail = hv?.snap ? toScreen(hv.snap.lat, hv.snap.lon, w, h) : hv ? { x: hv.x, y: hv.y } : null
        ctx.strokeStyle = '#e91e63'; ctx.lineWidth = 3
        ctx.beginPath()
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
        ctx.stroke()
        if (tail) {
          ctx.setLineDash([6, 4]); ctx.beginPath()
          ctx.moveTo(pts.at(-1)!.x, pts.at(-1)!.y); ctx.lineTo(tail.x, tail.y)
          ctx.stroke(); ctx.setLineDash([])
        }
        ctx.fillStyle = '#e91e63'
        for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 7); ctx.fill() }
      }
    }
    // маркер привязки: зелёный — узел, синий — точка на дороге
    if (tool !== 'select' && tool !== 'parking' && hover.current) {
      const hv = hover.current
      if (hv.snap) {
        const p = toScreen(hv.snap.lat, hv.snap.lon, w, h)
        ctx.strokeStyle = hv.snap.kind === 'node' ? '#2e7d32' : '#1565c0'; ctx.lineWidth = 2.5
        ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, 7); ctx.stroke()
      } else if (tool === 'draw') {
        ctx.fillStyle = 'rgba(233,30,99,0.5)'
        ctx.beginPath(); ctx.arc(hv.x, hv.y, 3.5, 0, 7); ctx.fill()
      }
    }

    // Остановки из OSM, ещё не привязанные к дороге: светлый значок, по нему можно кликнуть инструментом «Остановка»
    if (L.stops && (view.current.scale > 0.25 || tool === 'stop')) {
      for (const id of cache.stopPlatforms) {
        if (cache.linkedPlatforms.has(id)) continue
        const p = pos(id)
        if (!p) continue
        if (p.x < -12 || p.y < -12 || p.x > w + 12 || p.y > h + 12) continue
        ctx.save()
        ctx.fillStyle = '#ffffff'; ctx.strokeStyle = pal.stop; ctx.lineWidth = 2
        ctx.fillRect(p.x - 8, p.y - 8, 16, 16); ctx.strokeRect(p.x - 8, p.y - 8, 16, 16)
        ctx.fillStyle = pal.stop; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'
        ctx.fillText('А', p.x, p.y + 3.5)
        ctx.restore()
      }
    }

    // Остановка связана с дорожной сетью через опорный узел.
    for (const relation of L.stops ? doc.relations.values() : []) {
      const stop = linkedStop(relation)
      if (!stop) continue
      const anchor = pos(stop.anchor), platform = pos(stop.platform)
      if (!anchor || !platform) continue
      ctx.save()
      ctx.strokeStyle = pal.stop
      ctx.lineWidth = 2
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(anchor.x, anchor.y); ctx.lineTo(platform.x, platform.y); ctx.stroke()
      ctx.fillStyle = pal.stop
      ctx.fillRect(platform.x - 10, platform.y - 10, 20, 20)
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'
      ctx.fillText('А', platform.x, platform.y + 4)
      ctx.restore()
    }
    if (tool === 'stop' && stopAnchor.current) {
      const anchor = stopAnchor.current
      const p = toScreen(anchor.lat, anchor.lon, w, h)
      ctx.strokeStyle = pal.stop; ctx.lineWidth = 3
      ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.stroke()
    }
    // номера узлов: только у узлов видимой сети (дороги, пути, остановки), плашками и без наложения друг на друга
    if (props.current.showNodeIds) {
      const ids = new Set<number>()
      for (const way of ways) {
        const visible = isDrivable(way) ? L.car : props.current.showPedestrian
        if (visible) for (const id of way.nodes) ids.add(id)
      }
      for (const way of trams) for (const id of way.nodes) ids.add(id)
      for (const r of doc.relations.values()) { const st = linkedStop(r); if (st) { ids.add(st.anchor); ids.add(st.platform) } }
      if (L.stops) for (const n of doc.nodes.values()) if (isStopPlatform(n.tags)) ids.add(n.id)
      const selectedNode = sel?.kind === 'node' ? sel.id : undefined
      const zoomedOut = view.current.scale < 0.35
      ctx.save()
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'
      const placed: { x: number; y: number; w: number; h: number }[] = []
      const order = [...ids].sort((a, b) => (a === selectedNode ? -1 : b === selectedNode ? 1 : 0))
      for (const id of order) {
        const p = pos(id)
        if (!p || p.x < 0 || p.x > w || p.y < 0 || p.y > h) continue
        // на мелком масштабе подписей слишком много — только выбранный узел
        if (zoomedOut && id !== selectedNode) continue
        const label = String(id)
        const bw = ctx.measureText(label).width + 8, bh = 14
        const box = { x: p.x + 5, y: p.y - bh - 3, w: bw, h: bh }
        const overlaps = placed.some((q) => box.x < q.x + q.w && q.x < box.x + box.w && box.y < q.y + q.h && q.y < box.y + box.h)
        if (overlaps && id !== selectedNode) continue
        placed.push(box)
        ctx.fillStyle = id === selectedNode ? '#00b0ff' : pal.labelBg
        ctx.strokeStyle = id === selectedNode ? '#0284c7' : pal.labelBorder
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.roundRect(box.x, box.y, box.w, box.h, 4); ctx.fill(); ctx.stroke()
        ctx.fillStyle = id === selectedNode ? '#ffffff' : pal.labelText
        ctx.textBaseline = 'middle'
        ctx.fillText(label, box.x + 4, box.y + bh / 2 + 0.5)
      }
      if (zoomedOut) {
        ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
        ctx.strokeStyle = pal.textHalo; ctx.lineWidth = 4; ctx.fillStyle = pal.text
        ctx.strokeText('Приблизьте карту, чтобы увидеть номера узлов', w / 2, h - 16)
        ctx.fillText('Приблизьте карту, чтобы увидеть номера узлов', w / 2, h - 16)
      }
      ctx.restore()
    }
    // маршрут общественного транспорта: черновик или выбранный в списке
    {
      const rd = routeUi.draft
      const rel = !rd && routeUi.selected !== undefined ? doc.relations.get(routeUi.selected) : undefined
      const info = rd ? { ...rd, editable: true, ways: [] as number[] } : rel ? readRoute(doc, rel) : undefined
      if (info) {
        const casing = pal.glow ? 'rgba(7,13,24,0.92)' : 'rgba(255,255,255,0.95)'
        const lines: { x: number; y: number }[][] = []
        const path = info.editable ? routeUi.path(info.stops, info.kind) : undefined
        if (path && path.nodes.length > 1) lines.push(path.nodes.map(pos).filter((p): p is { x: number; y: number } => !!p))
        else if (!info.editable) for (const wid of info.ways) { const wy = doc.ways.get(wid); if (wy) lines.push(wy.nodes.map(pos).filter((p): p is { x: number; y: number } => !!p)) }
        ctx.save()
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'
        for (const [color, width] of [[casing, 12], [info.colour, 6]] as const) {
          ctx.strokeStyle = color; ctx.lineWidth = width
          ctx.beginPath()
          for (const ln of lines) ln.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
          ctx.stroke()
        }
        // стрелки направления движения по маршруту
        ctx.fillStyle = '#ffffff'
        for (const ln of lines) {
          let acc = 0
          for (let i = 1; i < ln.length; i++) {
            const a = ln[i - 1], b = ln[i]
            const seg = Math.hypot(b.x - a.x, b.y - a.y)
            acc += seg
            if (acc < 90 || seg < 1) continue
            acc = 0
            const ang = Math.atan2(b.y - a.y, b.x - a.x), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
            ctx.save(); ctx.translate(mx, my); ctx.rotate(ang)
            ctx.beginPath(); ctx.moveTo(3.5, 0); ctx.lineTo(-2.5, -3); ctx.lineTo(-2.5, 3); ctx.closePath(); ctx.fill()
            ctx.restore()
          }
        }
        // остановки по порядку
        info.stops.forEach((st, i) => {
          const p = pos(st.node)
          if (!p) return
          const broken = path?.broken.includes(i) || path?.broken.includes(i - 1)
          ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, 7)
          ctx.fillStyle = pal.glow ? '#0b1324' : '#ffffff'; ctx.fill()
          ctx.lineWidth = 3; ctx.strokeStyle = broken ? '#ef4444' : info.colour; ctx.stroke()
          ctx.fillStyle = pal.glow ? '#e2e8f0' : '#111827'
          ctx.font = '700 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillText(String(i + 1), p.x, p.y + 0.5)
        })
        ctx.restore()
      }
      // при выборе трамвайных остановок показываем узлы-остановки на путях
      if (rd && routeUi.picking && rd.kind === 'tram') {
        ctx.save()
        for (const tw of cache.trams) for (const id of tw.nodes) {
          const n = doc.nodes.get(id)
          if (!n || (n.tags.railway !== 'tram_stop' && n.tags.public_transport !== 'stop_position')) continue
          const p = pos(id)
          if (!p) continue
          ctx.fillStyle = pal.stop; ctx.fillRect(p.x - 8, p.y - 8, 16, 16)
          ctx.fillStyle = '#fff'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillText('Т', p.x, p.y + 0.5)
        }
        ctx.restore()
      }
    }

    // направления выбранного светофора с планом — стрелки в цветах сигнальных групп (как в панели)
    if (sel?.kind === 'node') {
      const sn = doc.nodes.get(sel.id)
      const plan = sn && readPlan(sn.tags)
      const c = sn && pos(sn.id)
      if (plan && c) {
        const groupOf = new Map<string, number>()
        plan.groups.forEach((g, gi) => g.turns.forEach((k) => groupOf.set(k, gi)))
        const R = 34
        for (const t of turnsAt(doc, sel.id)) {
          const gi = groupOf.get(t.key)
          // экран: ось y вниз, поэтому y векторов Меркатора меняет знак
          const a = { x: c.x - t.inDir.x * R, y: c.y + t.inDir.y * R }
          const b = { x: c.x + t.outDir.x * R, y: c.y - t.outDir.y * R }
          ctx.save()
          ctx.strokeStyle = gi === undefined ? '#9aa0a6' : GROUP_COLORS[gi % GROUP_COLORS.length]
          ctx.fillStyle = ctx.strokeStyle
          ctx.lineWidth = 3
          if (gi === undefined) ctx.setLineDash([4, 3])
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); ctx.stroke()
          ctx.setLineDash([])
          const ang = Math.atan2(b.y - c.y, b.x - c.x)
          ctx.translate(b.x, b.y); ctx.rotate(ang)
          ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -5); ctx.lineTo(-4, 5); ctx.closePath(); ctx.fill()
          ctx.restore()
        }
      }
    }

    // выделение
    if (sel?.kind === 'way') {
      const way = doc.ways.get(sel.id)
      if (way) {
        ctx.beginPath()
        way.nodes.forEach((nid, i) => { const p = pos(nid); if (p) (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)) })
        ctx.strokeStyle = '#00b0ff'; ctx.lineWidth = Math.max(8 * zoomK * 0.7, roadPx(way) + 6); ctx.globalAlpha = 0.45; ctx.stroke(); ctx.globalAlpha = 1
      }
    } else if (sel?.kind === 'node') {
      const p = pos(sel.id)
      if (p) { ctx.strokeStyle = '#00b0ff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, 7); ctx.stroke() }
    }

    // знак скоростного ограничения у выбранной дороги
    if (sel?.kind === 'way' && props.current.tool === 'select') {
      const way = doc.ways.get(sel.id)
      if (way && isDrivable(way)) { // у трамвайных путей и пешеходных дорожек знака скорости нет
        if (signAt.current?.wayId !== sel.id) {
          const m = wayMidpoint(doc, way) // выбрана не кликом (например, из списка проблем) — ставим на середину
          signAt.current = m ? { wayId: sel.id, ...m } : null
        }
        const at = signAt.current
        if (at) {
          const p = toScreen(at.lat, at.lon, w, h)
          const sx = Math.max(24, Math.min(w - 24, p.x)), sy = Math.max(40, Math.min(h - 24, p.y - 26))
          ctx.strokeStyle = pal.text; ctx.lineWidth = 1.5
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(sx, sy + 15); ctx.stroke()
          drawSpeedSign(ctx, sx, sy, speedLimit(way))
        }
      }
    }

    updateOverlays(w, h, dpr)
  }

  /**
   * Слой машин: прозрачный холст поверх карты. Машины одного цвета (скорости) рисуются одним путём,
   * координаты берутся сразу в метрах Меркатора, каждая машина сдвинута на свою полосу.
   */
  function drawCars() {
    const c = dynCanvas.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const r = c.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
      c.width = Math.round(r.width * dpr)
      c.height = Math.round(r.height * dpr)
    }
    const ctx = c.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const w = r.width, h = r.height
    ctx.clearRect(0, 0, w, h)
    const sim = traffic.sim
    if (!sim) return
    const pal = PALETTES[props.current.theme]
    const v0 = view.current
    const ppm = v0.scale / Math.cos((unproject(v0.cx, v0.cy).lat * Math.PI) / 180)
    const sx = (x: number) => (x - v0.cx) * v0.scale + w / 2
    const sy = (y: number) => (v0.cy - y) * v0.scale + h / 2

    // сигналы на подходах к светофорам
    const lights = { green: [] as number[], yellow: [] as number[], red: [] as number[] }
    for (const l of sim.approachLights()) {
      const p = project(l.lat, l.lon)
      const x = sx(p.x), y = sy(p.y)
      if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue
      lights[l.state].push(x, y)
    }
    const lr = Math.max(3, Math.min(6, 1.2 * ppm))
    for (const [state, color] of [['green', '#22c55e'], ['yellow', '#facc15'], ['red', '#ef4444']] as const) {
      const pts = lights[state]
      if (!pts.length) continue
      ctx.beginPath()
      for (let i = 0; i < pts.length; i += 2) { ctx.moveTo(pts[i] + lr, pts[i + 1]); ctx.arc(pts[i], pts[i + 1], lr, 0, 7) }
      if (pal.glow) { ctx.globalAlpha = 0.3; ctx.fillStyle = color; ctx.lineWidth = lr * 2.2; ctx.strokeStyle = color; ctx.stroke(); ctx.globalAlpha = 1 }
      ctx.fillStyle = color; ctx.fill()
    }

    // машины: 6 оттенков от красного (стоит) до зелёного (едет)
    const BUCKETS = 6
    const paths: Path2D[] = Array.from({ length: BUCKETS }, () => new Path2D())
    const len = Math.max(6, 4.5 * ppm), wid = Math.max(3, 1.9 * ppm)
    for (const v of sim.vehicles) {
      const p = sim.position(v)
      const cx = sx(p.x), cy = sy(p.y)
      if (cx < -20 || cy < -20 || cx > w + 20 || cy > h + 20) continue
      // на экране ось y вниз: курс меняет знак; «вправо по ходу» = (−sin, cos)
      const fx = Math.cos(-p.heading), fy = Math.sin(-p.heading)
      const rx = -fy, ry = fx
      const ox = cx + rx * p.offset * ppm, oy = cy + ry * p.offset * ppm
      const hl = len / 2, hw = wid / 2
      const k = Math.min(BUCKETS - 1, Math.floor((Math.max(0, Math.min(1, v.v / sim.vmax(v.edge)))) * BUCKETS))
      const path = paths[k]
      path.moveTo(ox + fx * hl + rx * hw, oy + fy * hl + ry * hw)
      path.lineTo(ox + fx * hl - rx * hw, oy + fy * hl - ry * hw)
      path.lineTo(ox - fx * hl - rx * hw, oy - fy * hl - ry * hw)
      path.lineTo(ox - fx * hl + rx * hw, oy - fy * hl + ry * hw)
      path.closePath()
    }
    ctx.lineWidth = 0.8
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'
    paths.forEach((path, k) => {
      ctx.fillStyle = `hsl(${Math.round((120 * (k + 0.5)) / BUCKETS)}, 85%, ${pal.glow ? 58 : 45}%)`
      ctx.fill(path)
      ctx.stroke(path)
    })
  }

  /** Режим «Маршруты → Выбирать на карте»: клик добавляет остановку в черновик маршрута. */
  function pickRouteStop(sx: number, sy: number, w: number, h: number) {
    const d = routeUi.draft!
    const doc = store.doc
    const cache = getRenderCache()
    const v = view.current
    const near = (ids: Iterable<number>) => {
      let best: { id: number; dd: number } | undefined
      for (const id of ids) {
        const m = cache.merc.get(id)
        if (!m) continue
        const x = (m.x - v.cx) * v.scale + w / 2, y = (v.cy - m.y) * v.scale + h / 2
        const dd = Math.hypot(x - sx, y - sy)
        if (dd <= 14 && (!best || dd < best.dd)) best = { id, dd }
      }
      return best?.id
    }
    let stop: RouteStop | undefined
    if (d.kind === 'bus') {
      const platform = near(cache.stopPlatforms)
      if (platform !== undefined) {
        stop = resolveStop(doc, platform, 'bus')
        if (!stop) {
          // остановка из файла ещё не привязана к дороге — привязываем к ближайшему свободному узлу
          const n = doc.nodes.get(platform)!
          const anchor = nearestFreeRoadNode(doc, n.lat, n.lon)
          if (anchor !== undefined) {
            try { linkStopToNode(store, platform, anchor); stop = resolveStop(store.doc, platform, 'bus') } catch (e) { props.current.onHint((e as Error).message) }
          }
        }
      } else {
        const s = snap(sx, sy, w, h)
        const id = s?.kind === 'node' ? s.id : s?.kind === 'way' ? nearestWayNode(doc, s.wayId, s.lat, s.lon) : undefined
        if (id !== undefined) stop = resolveStop(doc, id, 'bus')
      }
    } else {
      const ids: number[] = []
      for (const tw of cache.trams) ids.push(...tw.nodes)
      const id = near(ids)
      if (id !== undefined) stop = resolveStop(doc, id, 'tram')
    }
    if (stop) {
      routeUi.addStop(stop)
      props.current.onHint(`Остановка ${routeUi.draft?.stops.length}: ${stop.name}. Следующая — кликом, Esc — закончить выбор`)
    } else {
      props.current.onHint(d.kind === 'bus' ? 'Кликните по остановке «А» или по дороге' : 'Кликните по трамвайным путям (узел остановки)')
    }
  }

  // ----- поиск объекта под курсором -----
  function pick(sx: number, sy: number, w: number, h: number) {
    const doc = store.doc
    // The visible stop marker takes priority over the road and its anchor.
    for (const relation of doc.relations.values()) {
      const stop = linkedStop(relation)
      const platform = stop && doc.nodes.get(stop.platform)
      if (!platform) continue
      const point = toScreen(platform.lat, platform.lon, w, h)
      if (Math.abs(point.x - sx) <= 12 && Math.abs(point.y - sy) <= 12) {
        return { kind: 'node' as const, id: platform.id }
      }
    }
    const ped = props.current.showPedestrian
    let bestN: { id: number; d: number } | null = null
    let bestW: { id: number; d: number; x: number; y: number } | null = null
    for (const way of doc.ways.values()) {
      if (!wayVisible(way, ped)) continue
      let prev: { x: number; y: number } | null = null
      for (const nid of way.nodes) {
        const n = doc.nodes.get(nid)
        if (!n) { prev = null; continue }
        const p = toScreen(n.lat, n.lon, w, h)
        const dn = Math.hypot(p.x - sx, p.y - sy)
        // узлы выбираем только когда они нарисованы (при приближении); светофоры и уже выбранный узел — всегда
        const nodeVisible = view.current.scale > 0.5 || n.tags.highway === 'traffic_signals' ||
          (store.selection?.kind === 'node' && store.selection.id === nid)
        if (nodeVisible && dn < HIT && (!bestN || dn < bestN.d)) bestN = { id: nid, d: dn }
        if (prev) {
          const dx = p.x - prev.x, dy = p.y - prev.y
          const l2 = dx * dx + dy * dy || 1
          const t = Math.max(0, Math.min(1, ((sx - prev.x) * dx + (sy - prev.y) * dy) / l2))
          const px = prev.x + t * dx, py = prev.y + t * dy
          const d = Math.hypot(px - sx, py - sy)
          if (d < HIT && (!bestW || d < bestW.d)) bestW = { id: way.id, d, x: px, y: py }
        }
        prev = p
      }
    }
    for (const n of doc.nodes.values()) {
      // остановки (в т.ч. из OSM только с highway=bus_stop) можно выбрать и перетащить всегда
      if (!props.current.showNodeIds && !isStopPlatform(n.tags) && n.tags.public_transport !== 'stop_position') continue
      const p = toScreen(n.lat, n.lon, w, h)
      const d = Math.hypot(p.x - sx, p.y - sy)
      if (d < HIT && (!bestN || d < bestN.d)) bestN = { id: n.id, d }
    }
    if (bestN) return { kind: 'node' as const, id: bestN.id }
    if (bestW) return { kind: 'way' as const, id: bestW.id, at: fromScreen(bestW.x, bestW.y, w, h) }
    // клик внутри парковки
    if (props.current.layers.parking) {
      const c = getRenderCache()
      for (const pk of c.parkings) {
        const pts = pk.nodes.map((id) => doc.nodes.get(id)).filter((n): n is NonNullable<typeof n> => !!n).map((n) => toScreen(n.lat, n.lon, w, h))
        let inside = false
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          if ((pts[i].y > sy) !== (pts[j].y > sy) && sx < ((pts[j].x - pts[i].x) * (sy - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x) inside = !inside
        }
        if (inside) return { kind: 'way' as const, id: pk.id, at: fromScreen(sx, sy, w, h) }
      }
    }
    return null
  }

  /** Видна ли линия на карте (по слоям): дороги для машин, пешеходные, трамвайные пути. */
  function wayVisible(way: OsmWay, ped: boolean): boolean {
    const L = props.current.layers
    if (isTram(way)) return L.tram
    if (!way.tags.highway) return false
    return isDrivable(way) ? L.car : ped
  }

  /** Существующая (не привязанная) остановка под курсором. */
  function stopNear(sx: number, sy: number, w: number, h: number): number | undefined {
    let best: { id: number; d: number } | undefined
    for (const n of store.doc.nodes.values()) {
      if (!isStopPlatform(n.tags) || stopsAt(store.doc, n.id).length) continue
      const p = toScreen(n.lat, n.lon, w, h)
      const d = Math.max(Math.abs(p.x - sx), Math.abs(p.y - sy))
      if (d <= 12 && (!best || d < best.d)) best = { id: n.id, d }
    }
    return best?.id
  }

  // ----- привязка (snap) для рисования и склейки -----
  /** Ближайший узел или отрезок дороги в радиусе HIT пикселей. exclude — узел, который не учитываем. */
  function snap(sx: number, sy: number, w: number, h: number, exclude?: number): Snap | null {
    const doc = store.doc
    const ped = props.current.showPedestrian
    let bestN: { id: number; d: number } | null = null
    let bestS: { wayId: number; d: number; x: number; y: number } | null = null
    for (const way of doc.ways.values()) {
      if (!wayVisible(way, ped) || (props.current.tool === 'stop' && !isDrivable(way))) continue
      let prev: { x: number; y: number } | null = null
      for (const nid of way.nodes) {
        const n = doc.nodes.get(nid)
        if (!n) { prev = null; continue }
        const p = toScreen(n.lat, n.lon, w, h)
        const dn = Math.hypot(p.x - sx, p.y - sy)
        if (nid !== exclude && dn < HIT && (!bestN || dn < bestN.d)) bestN = { id: nid, d: dn }
        if (prev) {
          const dx = p.x - prev.x, dy = p.y - prev.y
          const l2 = dx * dx + dy * dy || 1
          const t = Math.max(0, Math.min(1, ((sx - prev.x) * dx + (sy - prev.y) * dy) / l2))
          const x = prev.x + t * dx, y = prev.y + t * dy
          const d = Math.hypot(x - sx, y - sy)
          if (d < HIT && (!bestS || d < bestS.d)) bestS = { wayId: way.id, d, x, y }
        }
        prev = p
      }
    }
    if (bestN) {
      const n = doc.nodes.get(bestN.id)!
      return { kind: 'node', id: bestN.id, lat: n.lat, lon: n.lon }
    }
    if (bestS) {
      const ll = fromScreen(bestS.x, bestS.y, w, h)
      return { kind: 'way', wayId: bestS.wayId, lat: ll.lat, lon: ll.lon }
    }
    return null
  }

  const pointLatLon = (p: DrawPoint) => {
    if (p.kind === 'node') { const n = store.doc.nodes.get(p.id); return n ? { lat: n.lat, lon: n.lon } : null }
    return { lat: p.lat, lon: p.lon }
  }

  function cancelDraft(msg?: string) {
    draft.current = []
    if (msg) props.current.onHint(msg)
    redraw()
  }

  function finishDraft() {
    const pts = draft.current
    draft.current = []
    if (props.current.tool === 'parking') {
      try {
        const id = drawArea(store, pts.map((p) => pointLatLon(p)).filter((p): p is { lat: number; lon: number } => !!p), props.current.drawTags)
        store.select({ kind: 'way', id })
        props.current.onHint(`Парковка создана (${pts.length} точек). Ctrl+Z — отменить`)
      } catch (e) { props.current.onHint((e as Error).message); redraw() }
      return
    }
    if (pts.length < 2) { props.current.onHint('Нужно минимум две точки — дорога не создана'); redraw(); return }
    const id = drawRoad(store, pts, props.current.drawTags)
    if (id) {
      store.select({ kind: 'way', id })
      props.current.onHint(`Дорога создана (${pts.length} точек). Ctrl+Z — отменить`)
    }
  }

  function addDraftPoint(sx: number, sy: number, w: number, h: number) {
    // контур парковки не цепляется к дорогам: площадь — отдельный объект
    const s = props.current.tool === 'parking' ? null : snap(sx, sy, w, h)
    const ll = fromScreen(sx, sy, w, h)
    const pt: DrawPoint = s
      ? s.kind === 'node' ? { kind: 'node', id: s.id } : { kind: 'way', wayId: s.wayId, lat: s.lat, lon: s.lon }
      : { kind: 'new', lat: ll.lat, lon: ll.lon }
    const last = draft.current.at(-1)
    if (last) {
      const a = pointLatLon(last), b = pointLatLon(pt)
      const same = (last.kind === 'node' && pt.kind === 'node' && last.id === pt.id) ||
        (a && b && (() => {
          const pa = toScreen(a.lat, a.lon, w, h), pb = toScreen(b.lat, b.lon, w, h)
          return Math.hypot(pa.x - pb.x, pa.y - pb.y) < 6
        })())
      if (same) { finishDraft(); return } // повторный клик в последней точке = закончить
    }
    draft.current = [...draft.current, pt]
    props.current.onHint(`Точек: ${draft.current.length}. Клик по последней точке или Enter — закончить, Backspace — убрать точку, Esc — отмена`)
    redraw()
  }

  // ----- события -----
  useEffect(() => {
    const c = canvas.current!
    const rect = () => c.getBoundingClientRect()

    const onDown = (e: PointerEvent) => {
      const r = rect()
      const sx = e.clientX - r.left, sy = e.clientY - r.top
      const hit = props.current.tool === 'select' ? pick(sx, sy, r.width, r.height) : null
      try { c.setPointerCapture(e.pointerId) } catch { /* синтетические события без активного указателя */ }
      if (hit?.kind === 'node') {
        store.select({ kind: 'node', id: hit.id })
        drag.current = { kind: 'node', id: hit.id, sx, sy, moved: false }
      } else {
        drag.current = { kind: 'pan', sx, sy, moved: false }
      }
    }
    const onMove = (e: PointerEvent) => {
      const d = drag.current
      if (coordsEl.current) {
        const r = rect()
        const ll = fromScreen(e.clientX - r.left, e.clientY - r.top, r.width, r.height)
        coordsEl.current.textContent = `${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}`
      }
      if (!d) {
        // наведение без нажатия: показываем, к чему привяжется точка
        if (props.current.tool !== 'select') {
          const r = rect()
          const sx = e.clientX - r.left, sy = e.clientY - r.top
          hover.current = { x: sx, y: sy, snap: snap(sx, sy, r.width, r.height) }
          redraw()
        }
        return
      }
      const r = rect()
      const sx = e.clientX - r.left, sy = e.clientY - r.top
      if (Math.hypot(sx - d.sx, sy - d.sy) > 3) d.moved = true
      if (!d.moved) return
      if (d.kind === 'pan') {
        const v = view.current
        v.cx -= (sx - d.sx) / v.scale
        v.cy += (sy - d.sy) / v.scale
        d.sx = sx; d.sy = sy
      } else {
        const ll = fromScreen(sx, sy, r.width, r.height)
        dragPos.current = { id: d.id!, lat: ll.lat, lon: ll.lon }
      }
      redraw()
    }
    const onUp = (e: PointerEvent) => {
      const d = drag.current
      drag.current = null
      if (!d) return
      const r = rect()
      const sx = e.clientX - r.left, sy = e.clientY - r.top
      if (d.kind === 'node' && d.moved && dragPos.current) {
        const p = dragPos.current
        dragPos.current = null
        // отпустили над другим узлом — склеиваем (так соединяют разорванные перекрёстки)
        const target = snap(sx, sy, r.width, r.height, p.id)
        const pt = store.doc.nodes.get(p.id)
        const platform = !!pt && isStopPlatform(pt.tags)
        if (!platform && target?.kind === 'node') {
          mergeNodes(store, target.id, p.id)
          store.select({ kind: 'node', id: target.id })
          props.current.onHint('Узлы склеены. Ctrl+Z — отменить')
        } else {
          moveNode(store, p.id, p.lat, p.lon)
        }
      } else if (!d.moved && routeUi.picking && routeUi.draft) {
        pickRouteStop(sx, sy, r.width, r.height)
      } else if (!d.moved) {
        const tool = props.current.tool
        if (tool === 'select') {
          const hit = pick(sx, sy, r.width, r.height)
          // знак скорости появится в точке клика по дороге
          signAt.current = hit?.kind === 'way' ? { wayId: hit.id, lat: hit.at.lat, lon: hit.at.lon } : null
          store.select(hit ? { kind: hit.kind, id: hit.id } : null)
        } else if (tool === 'draw' || tool === 'parking') {
          addDraftPoint(sx, sy, r.width, r.height)
        } else if (tool === 'stop') {
          const anchor = stopAnchor.current
          if (!anchor) {
            // опорный узел — только существующий: клик по отрезку берёт ближайший узел этой дороги
            const s = snap(sx, sy, r.width, r.height)
            const nodeId = s?.kind === 'node' ? s.id : s?.kind === 'way' ? nearestWayNode(store.doc, s.wayId, s.lat, s.lon) : undefined
            const n = nodeId !== undefined ? store.doc.nodes.get(nodeId) : undefined
            stopAnchor.current = n ? { kind: 'node', id: n.id, lat: n.lat, lon: n.lon } : null
            props.current.onHint(n
              ? `Опорный узел № ${n.id}. Теперь кликните по существующей остановке или по месту посадки рядом с дорогой`
              : 'Выберите автомобильную дорогу')
          } else {
            try {
              // клик по существующей остановке — привязываем её, иначе создаём место посадки в точке клика
              const existing = stopNear(sx, sy, r.width, r.height)
              const id = placeBusStop(store, anchor, existing !== undefined ? { id: existing } : fromScreen(sx, sy, r.width, r.height))
              store.select({ kind: 'node', id })
              props.current.onHint((existing !== undefined ? `Остановка № ${existing} привязана` : 'Остановка создана') + ' · опорный узел № ' + id)
              props.current.onStopCreated()
            } catch (error) {
              props.current.onHint((error as Error).message)
            }
            stopAnchor.current = null
          }
          redraw()
        } else if (tool === 'signal' || tool === 'crossing') {
          // клик по узлу — тег на этом узле, клик по отрезку дороги — новый узел с тегом; это обычная правка OSM
          const s = snap(sx, sy, r.width, r.height)
          const target = s?.kind === 'node' ? ({ kind: 'node', id: s.id } as const)
            : s?.kind === 'way' ? ({ kind: 'way', wayId: s.wayId, lat: s.lat, lon: s.lon } as const) : null
          if (target) {
            const id = placeRoadFeature(store, target, tool)
            store.select({ kind: 'node', id })
            props.current.onHint(`${tool === 'signal' ? 'Светофор' : 'Переход'} добавлен (узел ${id}) — попадёт в .osm. Ctrl+Z — отменить`)
          } else {
            props.current.onHint('Кликните по дороге или по её узлу')
          }
        } else if (tool === 'node') {
          const s = snap(sx, sy, r.width, r.height)
          if (s?.kind === 'way') {
            const id = insertNodeOnWay(store, s.wayId, s.lat, s.lon)
            store.select({ kind: 'node', id })
            props.current.onHint('Узел добавлен на дорогу')
          } else {
            props.current.onHint('Наведите курсор на дорогу, чтобы поставить на неё узел')
          }
        }
      }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = rect()
      const sx = e.clientX - r.left, sy = e.clientY - r.top
      const before = fromScreen(sx, sy, r.width, r.height)
      const v = view.current
      v.scale = Math.max(0.005, Math.min(40, v.scale * Math.exp(-e.deltaY * 0.0015)))
      const after = toScreen(before.lat, before.lon, r.width, r.height)
      v.cx += (after.x - sx) / v.scale
      v.cy -= (after.y - sy) / v.scale
      redraw()
    }
    c.addEventListener('pointerdown', onDown)
    c.addEventListener('pointermove', onMove)
    c.addEventListener('pointerup', onUp)
    const cancelDrag = () => {
      drag.current = null
      dragPos.current = null
      redraw()
    }
    c.addEventListener('pointercancel', cancelDrag)
    c.addEventListener('wheel', onWheel, { passive: false })
    const ro = new ResizeObserver(() => {
      if (fitPending.current && fit()) { fitPending.current = false; lastFile.current = store.fileName }
      redraw()
    })
    ro.observe(c)
    return () => {
      c.removeEventListener('pointerdown', onDown)
      c.removeEventListener('pointermove', onMove)
      c.removeEventListener('pointerup', onUp)
      c.removeEventListener('pointercancel', cancelDrag)
      c.removeEventListener('wheel', onWheel)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // демо-движение: перерисовка на каждый кадр
  useEffect(() => traffic.onFrame(redrawCars), []) // eslint-disable-line react-hooks/exhaustive-deps
  // маршруты: черновик, выбранный маршрут, режим выбора остановок
  useEffect(() => routeUi.subscribe(redraw), []) // eslint-disable-line react-hooks/exhaustive-deps

  // новый файл → показать всю карту
  const lastFile = useRef('')
  const fitPending = useRef(false)
  useEffect(() => {
    if (store.fileName !== lastFile.current && store.doc.nodes.size) {
      if (fit()) lastFile.current = store.fileName
      else fitPending.current = true // карта сейчас скрыта (3D): подгоним, когда покажут
    }
    redraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, tileUrl, issues, layers, theme])

  // переход к проблеме
  useEffect(() => {
    if (!focus) return
    const p = project(focus.lat, focus.lon)
    view.current = { cx: p.x, cy: p.y, scale: Math.max(view.current.scale, 1.5) }
    redraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  useEffect(() => {
    stopAnchor.current = null
    if (tool !== 'stop') return
    const cancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        stopAnchor.current = null
        props.current.onHint('Выберите узел на дороге')
        redraw()
      }
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [tool, store.doc, store.docVersion])

  // смена инструмента: сбрасываем незаконченную дорогу; в режиме рисования работают Enter / Esc / Backspace
  useEffect(() => {
    draft.current = []
    hover.current = null
    redraw()
    if (tool !== 'draw' && tool !== 'parking') return
    props.current.onHint(tool === 'parking'
      ? 'Парковка: обведите площадь кликами. Закончить — клик по последней точке или Enter'
      : 'Рисование дороги: кликайте по карте. Клик по узлу присоединяет, клик по дороге делает перекрёсток')
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return
      if (e.key === 'Enter') { e.preventDefault(); finishDraft() }
      else if (e.key === 'Escape') cancelDraft('Рисование отменено')
      else if (e.key === 'Backspace' && draft.current.length) {
        e.preventDefault()
        draft.current = draft.current.slice(0, -1)
        redraw()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool])

  return (
    <div className="map-wrap">
      <canvas ref={canvas} className={tool === 'select' && !routeUi.picking ? 'map' : 'map tool'} />
      <canvas ref={dynCanvas} className="map-dyn" aria-hidden="true" />

      <div className="zoom-ctl">
        <button onClick={() => zoomBy(1.5)} title="Приблизить"><Icon name="plus" /></button>
        <button onClick={() => zoomBy(1 / 1.5)} title="Отдалить"><Icon name="minus" /></button>
        <button onClick={() => { fit(); redraw() }} title="Показать всю сеть"><Icon name="fit" /></button>
      </div>

      <div className="map-hud">
        <div ref={miniBox} className="minimap" style={{ display: 'none' }}>
          <canvas
            ref={miniCanvas}
            title="Миникарта: клик или перетаскивание — переместить вид"
            onPointerDown={(e) => {
              miniDrag.current = true
              try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* без активного указателя */ }
              miniMove(e)
            }}
            onPointerMove={(e) => { if (miniDrag.current) miniMove(e) }}
            onPointerUp={() => { miniDrag.current = false }}
          />
        </div>
        <div className="scalebar">
          <div ref={barEl} className="bar" />
          <span ref={barLabel} />
        </div>
      </div>

      <div ref={coordsEl} className="coords" />
    </div>
  )
}
