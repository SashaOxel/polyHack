import { useEffect, useRef, useSyncExternalStore } from 'react'
import { offsetPolyline, project, unproject } from '../core/geo'
import { Icon } from './icons'
import { Minimap, scaleBar } from './overlays'
import { drawCrossingIcon, drawSignalIcon } from './roadIcons'
import { drawSpeedSign } from './speedSign'
import { drawRoad, placeRoadFeature, insertNodeOnWay, mergeNodes, moveNode, type DrawPoint } from '../core/ops'
import { hasCrossing, hasSignal, isDrivable, laneInfo, onewayDirection, roadStyle, speedLimit, wayMidpoint } from '../core/roads'
import { store } from '../core/store'
import type { OsmWay, Tags } from '../core/types'
import type { Issue } from '../validate'
import { drawTiles, type View } from './tiles'

export type Tool = 'select' | 'draw' | 'node' | 'signal' | 'crossing'

interface Props {
  tileUrl: string
  issues: Issue[]
  showPedestrian: boolean
  focus: { lat: number; lon: number; n: number } | null
  tool: Tool
  /** теги новой дороги в режиме рисования */
  drawTags: Tags
  /** подсказки/сообщения в строку состояния */
  onHint: (msg: string) => void
}

const HIT = 8

/** Результат привязки курсора: к узлу, к отрезку дороги или никуда. */
type Snap =
  | { kind: 'node'; id: number; lat: number; lon: number }
  | { kind: 'way'; wayId: number; lat: number; lon: number }

export function MapView({ tileUrl, issues, showPedestrian, focus, tool, drawTags, onHint }: Props) {
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const canvas = useRef<HTMLCanvasElement>(null)
  const view = useRef<View>({ cx: 0, cy: 0, scale: 0.1 })
  const drag = useRef<null | { kind: 'pan' | 'node'; id?: number; sx: number; sy: number; moved: boolean }>(null)
  const dragPos = useRef<{ id: number; lat: number; lon: number } | null>(null)
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
  const props = useRef({ tileUrl, issues, showPedestrian, tool, drawTags, onHint })
  props.current = { tileUrl, issues, showPedestrian, tool, drawTags, onHint }

  const redraw = () => {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(draw)
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
    m.update(store.doc, store.docVersion, dpr)
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
    ctx.fillStyle = '#f4f1ea'
    ctx.fillRect(0, 0, w, h)
    drawTiles(ctx, view.current, w, h, props.current.tileUrl, redraw)
    if (props.current.tileUrl) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillRect(0, 0, w, h)
    }

    const doc = store.doc
    const zoomK = Math.max(0.5, Math.min(3, Math.sqrt(view.current.scale / 0.15)))
    const pos = (id: number) => {
      const n = doc.nodes.get(id)
      if (!n) return null
      const dp = dragPos.current
      return toScreen(dp && dp.id === id ? dp.lat : n.lat, dp && dp.id === id ? dp.lon : n.lon, w, h)
    }

    // порядок: пешеходные → служебные → основные
    const ways = [...doc.ways.values()].filter((x) => x.tags.highway)
    const order = (hw: string | undefined) => roadStyle(hw).width
    ways.sort((a, b) => order(a.tags.highway) - order(b.tags.highway))

    // масштаб в реальных метрах: Меркатор растягивает расстояния на широте, поэтому делим на cos(широты)
    const LANE_M = 3.2
    const ppm = view.current.scale / Math.cos((unproject(view.current.cx, view.current.cy).lat * Math.PI) / 180) // px на метр
    const laneW = LANE_M * ppm
    const laneMode = laneW >= 4.5 // достаточно крупно, чтобы рисовать полосы
    /** Ширина дороги на экране: не уже обычной линии и не уже реальной ширины полос. */
    const roadPx = (way: OsmWay) => {
      const st = roadStyle(way.tags.highway)
      const base = (st.width + ((Number(way.tags.lanes) || 1) - 1) * 0.8) * zoomK
      const li = laneInfo(way)
      return li ? Math.max(base, li.total * laneW) : base
    }

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const sel = store.selection
    for (const way of ways) {
      const drivable = isDrivable(way)
      if (!drivable && !props.current.showPedestrian) continue
      const st = roadStyle(way.tags.highway)
      const li = laneInfo(way)
      const screenPts: { x: number; y: number }[] = []
      for (const nid of way.nodes) { const p = pos(nid); if (p) screenPts.push(p) }
      ctx.beginPath()
      screenPts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
      const W = roadPx(way)
      ctx.lineWidth = W
      ctx.strokeStyle = st.color
      if (!drivable) ctx.setLineDash([3, 3]); else ctx.setLineDash([])
      if (way.tags.bridge) { ctx.save(); ctx.lineWidth += 3; ctx.strokeStyle = '#333'; ctx.stroke(); ctx.restore() }
      const lanesVisible = drivable && laneMode && !!li && screenPts.length >= 2
      if (lanesVisible) {
        // крупный план: цветной кант класса дороги и «асфальт» внутри, чтобы разметка читалась на любом цвете
        ctx.save(); ctx.lineWidth = W + 4; ctx.stroke(); ctx.restore()
        ctx.strokeStyle = '#59626f'
      }
      ctx.stroke()
      ctx.setLineDash([])

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

      // стрелки направления
      const dir = onewayDirection(way)
      if (dir !== 0 && drivable && zoomK > 0.8) {
        for (let i = 1; i < way.nodes.length; i++) {
          const a = pos(way.nodes[i - 1]), b = pos(way.nodes[i])
          if (!a || !b) continue
          const len = Math.hypot(b.x - a.x, b.y - a.y)
          if (len < 18) continue
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
          const ang = Math.atan2(b.y - a.y, b.x - a.x) + (dir === -1 ? Math.PI : 0)
          ctx.save()
          ctx.translate(mx, my); ctx.rotate(ang)
          ctx.fillStyle = '#222'
          ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(-3, -3); ctx.lineTo(-3, 3); ctx.closePath(); ctx.fill()
          ctx.restore()
        }
      }
    }

    // светофоры и узлы
    const showNodes = view.current.scale > 0.5
    const used = new Set<number>()
    for (const way of ways) if (isDrivable(way) || props.current.showPedestrian) for (const n of way.nodes) used.add(n)
    for (const id of used) {
      const n = doc.nodes.get(id)
      if (!n) continue
      const p = pos(id)!
      if (p.x < -10 || p.y < -10 || p.x > w + 10 || p.y > h + 10) continue
      if (hasSignal(n.tags) || hasCrossing(n.tags)) {
        // рисуется иконкой в проходе ниже
      } else if (showNodes) {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#444'; ctx.lineWidth = 1
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, 7); ctx.fill(); ctx.stroke()
      }
    }

    // светофоры и переходы рисуются по тегам узлов (highway=traffic_signals / crossing)
    const iconSize = Math.max(16, Math.min(28, 10 * zoomK + 8))
    const crossLen = (hw: string | undefined) => roadStyle(hw).width * zoomK * 2.4
    const drawnIcons = new Set<number>()
    for (const way of ways) {
      if (!isDrivable(way) && !props.current.showPedestrian) continue
      way.nodes.forEach((nid, i) => {
        const n = doc.nodes.get(nid)
        const sig = !!n && hasSignal(n.tags), cro = !!n && hasCrossing(n.tags)
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
    for (const is of props.current.issues) {
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
    if (tool === 'draw') {
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
    if (tool !== 'select' && hover.current) {
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
      if (way) {
        if (signAt.current?.wayId !== sel.id) {
          const m = wayMidpoint(doc, way) // выбрана не кликом (например, из списка проблем) — ставим на середину
          signAt.current = m ? { wayId: sel.id, ...m } : null
        }
        const at = signAt.current
        if (at) {
          const p = toScreen(at.lat, at.lon, w, h)
          const sx = Math.max(24, Math.min(w - 24, p.x)), sy = Math.max(40, Math.min(h - 24, p.y - 26))
          ctx.strokeStyle = '#263041'; ctx.lineWidth = 1.5
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(sx, sy + 15); ctx.stroke()
          drawSpeedSign(ctx, sx, sy, speedLimit(way))
        }
      }
    }

    updateOverlays(w, h, dpr)
  }

  // ----- поиск объекта под курсором -----
  function pick(sx: number, sy: number, w: number, h: number) {
    const doc = store.doc
    const ped = props.current.showPedestrian
    let bestN: { id: number; d: number } | null = null
    let bestW: { id: number; d: number; x: number; y: number } | null = null
    for (const way of doc.ways.values()) {
      if (!way.tags.highway) continue
      if (!isDrivable(way) && !ped) continue
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
    if (bestN) return { kind: 'node' as const, id: bestN.id }
    if (bestW) return { kind: 'way' as const, id: bestW.id, at: fromScreen(bestW.x, bestW.y, w, h) }
    return null
  }

  // ----- привязка (snap) для рисования и склейки -----
  /** Ближайший узел или отрезок дороги в радиусе HIT пикселей. exclude — узел, который не учитываем. */
  function snap(sx: number, sy: number, w: number, h: number, exclude?: number): Snap | null {
    const doc = store.doc
    const ped = props.current.showPedestrian
    let bestN: { id: number; d: number } | null = null
    let bestS: { wayId: number; d: number; x: number; y: number } | null = null
    for (const way of doc.ways.values()) {
      if (!way.tags.highway) continue
      if (!isDrivable(way) && !ped) continue
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
    if (pts.length < 2) { props.current.onHint('Нужно минимум две точки — дорога не создана'); redraw(); return }
    const id = drawRoad(store, pts, props.current.drawTags)
    if (id) {
      store.select({ kind: 'way', id })
      props.current.onHint(`Дорога создана (${pts.length} точек). Ctrl+Z — отменить`)
    }
  }

  function addDraftPoint(sx: number, sy: number, w: number, h: number) {
    const s = snap(sx, sy, w, h)
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
      if (hit?.kind === 'node' && store.selection?.kind === 'node' && store.selection.id === hit.id) {
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
        if (target?.kind === 'node') {
          mergeNodes(store, target.id, p.id)
          store.select({ kind: 'node', id: target.id })
          props.current.onHint('Узлы склеены. Ctrl+Z — отменить')
        } else {
          moveNode(store, p.id, p.lat, p.lon)
        }
      } else if (!d.moved) {
        const tool = props.current.tool
        if (tool === 'select') {
          const hit = pick(sx, sy, r.width, r.height)
          // знак скорости появится в точке клика по дороге
          signAt.current = hit?.kind === 'way' ? { wayId: hit.id, lat: hit.at.lat, lon: hit.at.lon } : null
          store.select(hit ? { kind: hit.kind, id: hit.id } : null)
        } else if (tool === 'draw') {
          addDraftPoint(sx, sy, r.width, r.height)
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
      c.removeEventListener('wheel', onWheel)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
  }, [version, tileUrl, issues, showPedestrian])

  // переход к проблеме
  useEffect(() => {
    if (!focus) return
    const p = project(focus.lat, focus.lon)
    view.current = { cx: p.x, cy: p.y, scale: Math.max(view.current.scale, 1.5) }
    redraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  // смена инструмента: сбрасываем незаконченную дорогу; в режиме рисования работают Enter / Esc / Backspace
  useEffect(() => {
    draft.current = []
    hover.current = null
    redraw()
    if (tool !== 'draw') return
    props.current.onHint('Рисование дороги: кликайте по карте. Клик по узлу присоединяет, клик по дороге делает перекрёсток')
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
      <canvas ref={canvas} className={tool === 'select' ? 'map' : 'map tool'} />

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
