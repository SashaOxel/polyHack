import { HIGHWAY_LABELS, isTram } from './roads'
import { isRouteRelation, readRoute, ROUTE_KIND_RU } from './routes'
import { isStopPlatform } from './stops'
import type { ElementRef, OsmDocument } from './types'

/** Результат поиска для командной палитры. */
export interface SearchHit {
  kind: 'street' | 'stop' | 'route' | 'node' | 'way'
  label: string
  sub: string
  lat: number
  lon: number
  /** что выделить на карте */
  ref?: ElementRef
  routeId?: number
  score: number
}

export const normalize = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()

interface Indexed { label: string; key: string; sub: string; lat: number; lon: number; ref?: ElementRef; routeId?: number; kind: SearchHit['kind'] }

let cache: { doc: OsmDocument; version: number; items: Indexed[] } | null = null

/** Индекс по документу: улицы (по названию, одна запись на улицу), остановки, маршруты. Пересобирается при правке. */
function index(doc: OsmDocument, version: number): Indexed[] {
  if (cache && cache.doc === doc && cache.version === version) return cache.items
  const items: Indexed[] = []
  const streets = new Map<string, { name: string; ways: number[]; best: number; bestLen: number; cls: string }>()
  for (const w of doc.ways.values()) {
    const name = w.tags.name
    if (!name || (!w.tags.highway && !isTram(w))) continue
    const k = normalize(name)
    const e = streets.get(k) ?? { name, ways: [], best: w.id, bestLen: -1, cls: isTram(w) ? 'Трамвайные пути' : HIGHWAY_LABELS[w.tags.highway!] ?? w.tags.highway! }
    e.ways.push(w.id)
    if (w.nodes.length > e.bestLen) { e.best = w.id; e.bestLen = w.nodes.length }
    streets.set(k, e)
  }
  for (const [key, e] of streets) {
    const w = doc.ways.get(e.best)!
    const mid = doc.nodes.get(w.nodes[Math.floor(w.nodes.length / 2)])
    if (!mid) continue
    items.push({ kind: 'street', label: e.name, key, sub: `${e.cls} · отрезков ${e.ways.length}`, lat: mid.lat, lon: mid.lon, ref: { kind: 'way', id: e.best } })
  }
  for (const n of doc.nodes.values()) {
    if (!isStopPlatform(n.tags) || !n.tags.name) continue
    items.push({ kind: 'stop', label: n.tags.name, key: normalize(n.tags.name), sub: `Остановка · узел ${n.id}`, lat: n.lat, lon: n.lon, ref: { kind: 'node', id: n.id } })
  }
  for (const r of doc.relations.values()) {
    if (!isRouteRelation(r)) continue
    const info = readRoute(doc, r)
    const first = info.stops.map((s) => doc.nodes.get(s.node)).find(Boolean)
      ?? info.ways.map((id) => doc.ways.get(id)).filter(Boolean).map((w) => doc.nodes.get(w!.nodes[0])).find(Boolean)
    if (!first) continue
    const label = `${ROUTE_KIND_RU[info.kind]} ${info.ref}`.trim()
    items.push({ kind: 'route', label, key: normalize(`${label} ${info.ref} ${info.name}`), sub: info.name || 'маршрут', lat: first.lat, lon: first.lon, routeId: r.id })
  }
  cache = { doc, version, items }
  return items
}

/**
 * Поиск по документу: все слова запроса должны встречаться; выше — совпадение с начала названия,
 * потом с начала слова, потом где угодно. Число (или «узел 123») ищет узел и дорогу по номеру.
 */
export function searchDoc(doc: OsmDocument, version: number, query: string, limit = 8): SearchHit[] {
  const q = normalize(query)
  if (!q) return []
  const hits: SearchHit[] = []
  const num = /^(?:узел|node|дорога|way|#)?\s*(\d{2,})$/.exec(q)
  if (num) {
    const id = Number(num[1])
    const n = doc.nodes.get(id)
    if (n) hits.push({ kind: 'node', label: `Узел № ${id}`, sub: Object.entries(n.tags).slice(0, 2).map(([k, v]) => `${k}=${v}`).join(', ') || 'без тегов', lat: n.lat, lon: n.lon, ref: { kind: 'node', id }, score: 10 })
    const w = doc.ways.get(id)
    const m = w && doc.nodes.get(w.nodes[Math.floor(w.nodes.length / 2)])
    if (w && m) hits.push({ kind: 'way', label: `Дорога № ${id}`, sub: w.tags.name ?? w.tags.highway ?? '', lat: m.lat, lon: m.lon, ref: { kind: 'way', id }, score: 9 })
  }
  const words = q.split(' ')
  for (const it of index(doc, version)) {
    if (!words.every((wd) => it.key.includes(wd))) continue
    const score = it.key.startsWith(q) ? 3 : it.key.split(/[\s-]/).some((p) => p.startsWith(words[0])) ? 2 : 1
    hits.push({ kind: it.kind, label: it.label, sub: it.sub, lat: it.lat, lon: it.lon, ref: it.ref, routeId: it.routeId, score })
  }
  return hits.sort((a, b) => b.score - a.score || a.label.length - b.label.length).slice(0, limit)
}
