import { isDrivable, onewayDirection } from './roads'
import { readSign } from './signs'
import type { OsmDocument, OsmWay } from './types'

/**
 * Знаки приоритета → правки сети SUMO. netconvert сам теги give_way/stop/RU:2.1 из OSM не использует,
 * приоритет у него определяется классом дороги. Поэтому после импорта правим готовую сеть:
 *  - 2.4 «Уступи» — понижаем приоритет подходящего к перекрёстку ребра (оно становится второстепенным);
 *  - 2.5 «Стоп» — то же + перекрёсток получает тип priority_stop (второстепенные подходы останавливаются);
 *  - 2.1 «Главная» — повышаем приоритет ребра, идущего к перекрёстку.
 */
export interface EdgePatch { id: string; priority: number }
export interface NodePatch { id: string; x: number; y: number; type: 'priority_stop' }
export interface SumoPriorities { edges: EdgePatch[]; nodes: NodePatch[]; warnings: string[] }

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]

/** Первый перекрёсток (узел, общий с другой автомобильной дорогой) от узла в направлении dir; иначе конец дороги, если он общий. */
function junctionAhead(doc: OsmDocument, way: OsmWay, nodeId: number, dir: 1 | -1): number | undefined {
  const shared = new Set<number>()
  for (const w of doc.ways.values()) if (w !== way && isDrivable(w)) for (const id of w.nodes) shared.add(id)
  for (let i = way.nodes.indexOf(nodeId) + dir; i >= 0 && i < way.nodes.length; i += dir) {
    if (shared.has(way.nodes[i])) return way.nodes[i]
  }
  return undefined
}

export function buildSumoPriorities(doc: OsmDocument, netXml: string): SumoPriorities {
  const edges: { id: string; from: string; to: string; priority: number }[] = []
  for (const m of netXml.matchAll(/<edge\b[^>]*>/g)) {
    const t = m[0]
    if (attr(t, 'function') === 'internal') continue
    const id = attr(t, 'id'), from = attr(t, 'from'), to = attr(t, 'to')
    if (id && from && to) edges.push({ id, from, to, priority: Number(attr(t, 'priority') ?? 0) })
  }
  const junction = (id: string) => {
    for (const m of netXml.matchAll(/<junction\b[^>]*>/g)) if (attr(m[0], 'id') === id) return { x: Number(attr(m[0], 'x')), y: Number(attr(m[0], 'y')) }
    return undefined
  }
  const patched = new Map<string, number>()
  const nodes = new Map<string, NodePatch>()
  const warnings: string[] = []

  for (const way of doc.ways.values()) {
    if (!isDrivable(way)) continue
    const ow = onewayDirection(way)
    for (const nid of way.nodes) {
      const n = doc.nodes.get(nid)
      const sign = n && readSign(n.tags)
      if (!sign) continue
      const dir: 1 | -1 = ow !== 0 ? (ow as 1 | -1) : sign.direction === 'backward' ? -1 : 1
      const jn = junctionAhead(doc, way, nid, dir)
      const edge = jn === undefined ? undefined
        : edges.find((e) => e.to === String(jn) && e.id.replace(/^-/, '').replace(/#\d+$/, '') === String(way.id))
      if (!edge) { warnings.push(`знак на узле ${nid}: нет перекрёстка впереди — пропущен`); continue }
      const base = patched.get(edge.id) ?? edge.priority
      if (sign.kind === 'priority') patched.set(edge.id, Math.max(base, edge.priority + 2))
      else {
        patched.set(edge.id, Math.min(base, Math.max(0, edge.priority - 2)))
        if (sign.kind === 'stop' && !nodes.has(String(jn))) {
          const pos = junction(String(jn))
          if (pos) nodes.set(String(jn), { id: String(jn), ...pos, type: 'priority_stop' })
        }
      }
    }
  }
  return { edges: [...patched].map(([id, priority]) => ({ id, priority })), nodes: [...nodes.values()], warnings }
}

export const edgePatchXml = (p: EdgePatch[]) => `<edges>\n${p.map((e) => `  <edge id="${e.id}" priority="${e.priority}"/>`).join('\n')}\n</edges>\n`
export const nodePatchXml = (p: NodePatch[]) => `<nodes>\n${p.map((n) => `  <node id="${n.id}" x="${n.x}" y="${n.y}" type="${n.type}"/>`).join('\n')}\n</nodes>\n`
