import { useEffect, useRef, useSyncExternalStore } from 'react'
import { project, unproject } from '../core/geo'
import { moveNode } from '../core/ops'
import { isDrivable, onewayDirection, roadStyle } from '../core/roads'
import { store } from '../core/store'
import type { Issue } from '../validate'
import { drawTiles, type View } from './tiles'

interface Props {
  tileUrl: string
  issues: Issue[]
  showPedestrian: boolean
  focus: { lat: number; lon: number; n: number } | null
}

const HIT = 8

export function MapView({ tileUrl, issues, showPedestrian, focus }: Props) {
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const canvas = useRef<HTMLCanvasElement>(null)
  const view = useRef<View>({ cx: 0, cy: 0, scale: 0.1 })
  const drag = useRef<null | { kind: 'pan' | 'node'; id?: number; sx: number; sy: number; moved: boolean }>(null)
  const dragPos = useRef<{ id: number; lat: number; lon: number } | null>(null)
  const raf = useRef(0)
  const props = useRef({ tileUrl, issues, showPedestrian })
  props.current = { tileUrl, issues, showPedestrian }

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

  function fit() {
    const c = canvas.current
    const doc = store.doc
    if (!c || doc.nodes.size === 0) return
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
  }

  function draw() {
    const c = canvas.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const r = c.getBoundingClientRect()
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

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const sel = store.selection
    for (const way of ways) {
      const drivable = isDrivable(way)
      if (!drivable && !props.current.showPedestrian) continue
      const st = roadStyle(way.tags.highway)
      const lanes = Number(way.tags.lanes) || 1
      ctx.beginPath()
      let started = false
      for (const nid of way.nodes) {
        const p = pos(nid)
        if (!p) continue
        if (!started) { ctx.moveTo(p.x, p.y); started = true } else ctx.lineTo(p.x, p.y)
      }
      ctx.lineWidth = (st.width + (lanes - 1) * 0.8) * zoomK
      ctx.strokeStyle = st.color
      if (!drivable) ctx.setLineDash([3, 3]); else ctx.setLineDash([])
      if (way.tags.bridge) { ctx.save(); ctx.lineWidth += 3; ctx.strokeStyle = '#333'; ctx.stroke(); ctx.restore() }
      ctx.stroke()
      ctx.setLineDash([])

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
      if (n.tags.highway === 'traffic_signals') {
        ctx.fillStyle = '#2e7d32'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1
        ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 7); ctx.fill(); ctx.stroke()
      } else if (showNodes) {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#444'; ctx.lineWidth = 1
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, 7); ctx.fill(); ctx.stroke()
      }
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

    // выделение
    if (sel?.kind === 'way') {
      const way = doc.ways.get(sel.id)
      if (way) {
        ctx.beginPath()
        way.nodes.forEach((nid, i) => { const p = pos(nid); if (p) (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)) })
        ctx.strokeStyle = '#00b0ff'; ctx.lineWidth = 8 * zoomK * 0.7; ctx.globalAlpha = 0.45; ctx.stroke(); ctx.globalAlpha = 1
      }
    } else if (sel?.kind === 'node') {
      const p = pos(sel.id)
      if (p) { ctx.strokeStyle = '#00b0ff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, 7); ctx.stroke() }
    }
  }

  // ----- поиск объекта под курсором -----
  function pick(sx: number, sy: number, w: number, h: number) {
    const doc = store.doc
    const ped = props.current.showPedestrian
    let bestN: { id: number; d: number } | null = null
    let bestW: { id: number; d: number } | null = null
    for (const way of doc.ways.values()) {
      if (!way.tags.highway) continue
      if (!isDrivable(way) && !ped) continue
      let prev: { x: number; y: number } | null = null
      for (const nid of way.nodes) {
        const n = doc.nodes.get(nid)
        if (!n) { prev = null; continue }
        const p = toScreen(n.lat, n.lon, w, h)
        const dn = Math.hypot(p.x - sx, p.y - sy)
        // узлы выбираем только когда они нарисованы (при приближении), светофоры — всегда
        const nodeVisible = view.current.scale > 0.5 || n.tags.highway === 'traffic_signals'
        if (nodeVisible && dn < HIT && (!bestN || dn < bestN.d)) bestN = { id: nid, d: dn }
        if (prev) {
          const dx = p.x - prev.x, dy = p.y - prev.y
          const l2 = dx * dx + dy * dy || 1
          const t = Math.max(0, Math.min(1, ((sx - prev.x) * dx + (sy - prev.y) * dy) / l2))
          const d = Math.hypot(prev.x + t * dx - sx, prev.y + t * dy - sy)
          if (d < HIT && (!bestW || d < bestW.d)) bestW = { id: way.id, d }
        }
        prev = p
      }
    }
    if (bestN) return { kind: 'node' as const, id: bestN.id }
    if (bestW) return { kind: 'way' as const, id: bestW.id }
    return null
  }

  // ----- события -----
  useEffect(() => {
    const c = canvas.current!
    const rect = () => c.getBoundingClientRect()

    const onDown = (e: PointerEvent) => {
      const r = rect()
      const sx = e.clientX - r.left, sy = e.clientY - r.top
      const hit = pick(sx, sy, r.width, r.height)
      c.setPointerCapture(e.pointerId)
      if (hit?.kind === 'node' && store.selection?.kind === 'node' && store.selection.id === hit.id) {
        drag.current = { kind: 'node', id: hit.id, sx, sy, moved: false }
      } else {
        drag.current = { kind: 'pan', sx, sy, moved: false }
      }
    }
    const onMove = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
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
        moveNode(store, p.id, p.lat, p.lon)
      } else if (!d.moved) {
        const hit = pick(sx, sy, r.width, r.height)
        store.select(hit)
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
    const ro = new ResizeObserver(redraw)
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
  useEffect(() => {
    if (store.fileName !== lastFile.current && store.doc.nodes.size) {
      lastFile.current = store.fileName
      fit()
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

  return <canvas ref={canvas} className="map" />
}
