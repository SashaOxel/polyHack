import { distanceM } from './geo'
import { isDrivable, isTram, onewayDirection } from './roads'
import { linkedStop } from './stops'
import type { OsmDocument, OsmMember, OsmRelation, OsmWay, Tags } from './types'

/**
 * МАРШРУТЫ ОБЩЕСТВЕННОГО ТРАНСПОРТА (автобус, трамвай) — по схеме OSM Public Transport v2:
 *   relation type=route, route=bus|tram, ref=80, name, colour, public_transport:version=2;
 *   участники: сначала остановки по порядку (узел остановки на дороге — роль stop, место посадки — platform),
 *   затем дороги (ways) по порядку следования — роль пустая.
 * Путь между соседними остановками строится автоматически: автобус — по дорогам для машин с учётом oneway,
 * трамвай — только по трамвайным путям.
 */

export type RouteKind = 'bus' | 'tram'

export const ROUTE_KIND_RU: Record<RouteKind, string> = { bus: 'Автобус', tram: 'Трамвай' }
export const ROUTE_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d']

/** Остановка маршрута: узел на дороге/путях (где останавливается транспорт) и, если есть, место посадки. */
export interface RouteStop {
  node: number
  platform?: number
  name: string
}

export interface RouteInfo {
  id: number
  kind: RouteKind
  ref: string
  name: string
  colour: string
  stops: RouteStop[]
  ways: number[]
  /** маршрут создан в редакторе (его можно править); маршруты из файла — только просмотр */
  editable: boolean
}

// ---------- маршрутизация ----------

interface Arc { to: number; way: number; len: number }

const usable = (w: OsmWay, kind: RouteKind) => (kind === 'tram' ? isTram(w) : isDrivable(w))

/** Граф по узлам для вида транспорта (рёбра — соседние узлы одной дороги, направление по oneway). */
function arcs(doc: OsmDocument, kind: RouteKind): Map<number, Arc[]> {
  const adj = new Map<number, Arc[]>()
  const add = (a: number, b: number, way: number, len: number) => {
    if (!adj.has(a)) adj.set(a, [])
    adj.get(a)!.push({ to: b, way, len })
  }
  for (const w of doc.ways.values()) {
    if (!usable(w, kind)) continue
    const dir = onewayDirection(w)
    for (let i = 1; i < w.nodes.length; i++) {
      const a = doc.nodes.get(w.nodes[i - 1]), b = doc.nodes.get(w.nodes[i])
      if (!a || !b) continue
      const len = distanceM(a.lat, a.lon, b.lat, b.lon)
      if (dir >= 0) add(a.id, b.id, w.id, len)
      if (dir <= 0) add(b.id, a.id, w.id, len)
    }
  }
  return adj
}

/** Кратчайший путь (Дейкстра с двоичной кучей). */
function shortest(adj: Map<number, Arc[]>, from: number, to: number): { nodes: number[]; ways: number[]; meters: number } | null {
  if (from === to) return { nodes: [from], ways: [], meters: 0 }
  const dist = new Map<number, number>([[from, 0]])
  const prev = new Map<number, { node: number; way: number }>()
  const heap: [number, number][] = [[0, from]]
  const push = (d: number, n: number) => {
    heap.push([d, n])
    let i = heap.length - 1
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p }
  }
  const pop = () => {
    const top = heap[0], last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]; i = m
      }
    }
    return top
  }
  while (heap.length) {
    const [d, u] = pop()
    if (d > (dist.get(u) ?? Infinity)) continue
    if (u === to) break
    for (const a of adj.get(u) ?? []) {
      const nd = d + a.len
      if (nd < (dist.get(a.to) ?? Infinity)) { dist.set(a.to, nd); prev.set(a.to, { node: u, way: a.way }); push(nd, a.to) }
    }
  }
  if (!dist.has(to)) return null
  const nodes = [to], ways: number[] = []
  for (let n = to; n !== from;) { const p = prev.get(n)!; ways.push(p.way); nodes.push(p.node); n = p.node }
  nodes.reverse(); ways.reverse()
  return { nodes, ways: ways.filter((w, i) => i === 0 || w !== ways[i - 1]), meters: dist.get(to)! }
}

export interface RoutePath {
  /** узлы по ходу маршрута */
  nodes: number[]
  /** дороги по ходу маршрута (подряд без повторов) */
  ways: number[]
  meters: number
  /** номера перегонов (между остановками i и i+1), для которых пути нет */
  broken: number[]
}

/** Путь маршрута через все остановки по порядку. */
export function routePath(doc: OsmDocument, kind: RouteKind, stopNodes: number[]): RoutePath {
  const adj = arcs(doc, kind)
  const out: RoutePath = { nodes: [], ways: [], meters: 0, broken: [] }
  for (let i = 1; i < stopNodes.length; i++) {
    const leg = shortest(adj, stopNodes[i - 1], stopNodes[i])
    if (!leg) { out.broken.push(i - 1); continue }
    out.nodes.push(...(out.nodes.length && out.nodes.at(-1) === leg.nodes[0] ? leg.nodes.slice(1) : leg.nodes))
    for (const w of leg.ways) if (out.ways.at(-1) !== w) out.ways.push(w)
    out.meters += leg.meters
  }
  if (stopNodes.length === 1) out.nodes = [stopNodes[0]]
  return out
}

// ---------- какие узлы могут быть остановками ----------

/** Узел лежит на сети этого вида транспорта. */
export function onNetwork(doc: OsmDocument, nodeId: number, kind: RouteKind): boolean {
  for (const w of doc.ways.values()) if (usable(w, kind) && w.nodes.includes(nodeId)) return true
  return false
}

function nameOf(doc: OsmDocument, ...ids: (number | undefined)[]): string | undefined {
  for (const id of ids) { const n = id !== undefined ? doc.nodes.get(id) : undefined; if (n?.tags.name) return n.tags.name }
  return undefined
}

/**
 * Превратить выбранный узел в остановку маршрута:
 *  - автобус: опорный узел привязанной остановки (или само место посадки «А» — берётся его опорный узел);
 *  - трамвай: узел трамвайных путей (обычно railway=tram_stop).
 * undefined — узел не годится.
 */
export function resolveStop(doc: OsmDocument, nodeId: number, kind: RouteKind): RouteStop | undefined {
  if (kind === 'bus') {
    for (const r of doc.relations.values()) {
      const s = linkedStop(r)
      if (s && (s.anchor === nodeId || s.platform === nodeId)) {
        return { node: s.anchor, platform: s.platform, name: nameOf(doc, s.platform, s.anchor) ?? `Остановка у узла ${s.anchor}` }
      }
    }
    // просто узел дороги — тоже можно (остановка «по требованию»), без места посадки
    if (onNetwork(doc, nodeId, 'bus')) return { node: nodeId, name: nameOf(doc, nodeId) ?? `Узел ${nodeId}` }
    return undefined
  }
  if (onNetwork(doc, nodeId, 'tram')) return { node: nodeId, name: nameOf(doc, nodeId) ?? `Трамвайная остановка ${nodeId}` }
  return undefined
}

// ---------- чтение и запись relation ----------

export const isRouteRelation = (r: OsmRelation) => r.tags.type === 'route' && (r.tags.route === 'bus' || r.tags.route === 'tram')

export function readRoute(doc: OsmDocument, r: OsmRelation, index = 0): RouteInfo {
  const stops: RouteStop[] = []
  const stopMembers = r.members.filter((m) => m.type === 'node' && m.role.startsWith('stop'))
  const platforms = r.members.filter((m) => m.type === 'node' && m.role.startsWith('platform')).map((m) => m.ref)
  stopMembers.forEach((m, i) => {
    const platform = platforms[i]
    stops.push({ node: m.ref, platform, name: nameOf(doc, platform, m.ref) ?? `Узел ${m.ref}` })
  })
  return {
    id: r.id,
    kind: r.tags.route as RouteKind,
    ref: r.tags.ref ?? '',
    name: r.tags.name ?? '',
    colour: r.tags.colour ?? ROUTE_COLORS[index % ROUTE_COLORS.length],
    stops,
    ways: r.members.filter((m) => m.type === 'way' && m.role === '').map((m) => m.ref),
    editable: r.tags['polyhack:route'] === 'yes',
  }
}

export function listRoutes(doc: OsmDocument): RouteInfo[] {
  return [...doc.relations.values()].filter(isRouteRelation).map((r, i) => readRoute(doc, r, i))
    .sort((a, b) => Number(b.editable) - Number(a.editable) || a.ref.localeCompare(b.ref, 'ru', { numeric: true }))
}

export interface RouteDraft {
  kind: RouteKind
  ref: string
  name?: string
  colour?: string
  stops: RouteStop[]
}

/** Собрать relation маршрута: теги, остановки (stop + platform) по порядку, затем дороги. */
export function buildRouteRelation(doc: OsmDocument, id: number, draft: RouteDraft, meta: Tags = {}): { relation: OsmRelation; path: RoutePath } {
  const path = routePath(doc, draft.kind, draft.stops.map((s) => s.node))
  const first = draft.stops[0]?.name, last = draft.stops.at(-1)?.name
  const tags: Tags = {
    type: 'route',
    route: draft.kind,
    ref: draft.ref.trim(),
    name: draft.name?.trim() || `${ROUTE_KIND_RU[draft.kind]} ${draft.ref.trim()}${first && last ? `: ${first} — ${last}` : ''}`,
    'public_transport:version': '2',
    'polyhack:route': 'yes',
    ...(draft.colour ? { colour: draft.colour } : {}),
    ...(first ? { from: first } : {}),
    ...(last ? { to: last } : {}),
  }
  const members: OsmMember[] = []
  for (const s of draft.stops) {
    members.push({ type: 'node', ref: s.node, role: 'stop' })
    if (s.platform !== undefined) members.push({ type: 'node', ref: s.platform, role: 'platform' })
  }
  for (const w of path.ways) members.push({ type: 'way', ref: w, role: '' })
  return { relation: { id, tags: { ...meta, ...tags }, members, meta: {} }, path }
}
