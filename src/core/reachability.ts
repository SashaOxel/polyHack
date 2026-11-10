import { distanceM } from './geo'
import { analyze, graphFor, type GEdge, type RoadGraph } from './graph'
import type { OsmDocument } from './types'

/**
 * Достижимость для машин: какие участки сети нельзя проехать «отовсюду куда угодно».
 * Главная сеть — наибольшая сильно связная часть графа (в ней из любого места можно доехать в любое).
 * Остальное делится по причине:
 *  - trap     — въехать можно, выехать нельзя (односторонка в тупик, нет встречного направления);
 *  - noEntry  — выехать можно, попасть сюда нельзя;
 *  - detached — ни въезда, ни выезда (остров, не связанный с сетью проезжими связями).
 * Участки у края карты помечаются border: там дороги обрезаны рамкой выгрузки, и это скорее всего не ошибка данных.
 * Именно такие участки в SUMO дают «машина не нашла маршрут», а в MatSim — обрывы спроса.
 */
export type ReachRole = 'trap' | 'noEntry' | 'detached'

export interface ReachGroup {
  id: number
  role: ReachRole
  /** рядом с краем карты — вероятно, обрезка выгрузки, а не ошибка */
  border: boolean
  nodes: number[]
  edgeIds: string[]
  wayIds: number[]
  km: number
  /** узлы остальной сети, к которым группа примыкает (места, где можно добавить проезд) */
  links: number[]
  at: { lat: number; lon: number }
}

export interface Reachability {
  groups: ReachGroup[]
  /** id ребра графа → группа (только для ребёр вне главной сети) */
  edgeGroup: Map<string, ReachGroup>
  mainEdges: number
  totalEdges: number
  /** км вне главной сети без учёта «пограничных» групп */
  realKm: number
  borderKm: number
}

export const BORDER_M = 80

export function reachability(g: RoadGraph): Reachability {
  const a = analyze(g)
  const empty: Reachability = { groups: [], edgeGroup: new Map(), mainEdges: 0, totalEdges: g.edges.length, realKm: 0, borderKm: 0 }
  if (!a.main.size) return empty

  // рамка выгрузки — по узлам дорог
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity
  for (const nd of g.nodes.values()) { s = Math.min(s, nd.lat); n = Math.max(n, nd.lat); w = Math.min(w, nd.lon); e = Math.max(e, nd.lon) }
  const nearBorder = (lat: number, lon: number) =>
    Math.min(distanceM(lat, lon, s, lon), distanceM(lat, lon, n, lon), distanceM(lat, lon, lat, w), distanceM(lat, lon, lat, e)) < BORDER_M

  const out: Reachability = { ...empty, groups: [], edgeGroup: new Map() }
  const edgesOfNode = (id: number) => { const nd = g.nodes.get(id)!; return [...nd.out, ...nd.in] }
  let gid = 0
  const add = (groups: number[][], role: ReachRole) => {
    for (const nodes of groups) {
      const set = new Set(nodes)
      const edges = new Map<string, GEdge>()
      const links = new Set<number>()
      for (const id of nodes) for (const ed of edgesOfNode(id)) {
        // ребро принадлежит группе, если хотя бы один его конец в группе и не в главной сети
        if (set.has(ed.from) || set.has(ed.to)) edges.set(ed.id, ed)
        // место стыка с остальной сетью — узел по ту сторону границы группы
        if (set.has(id)) { if (!set.has(ed.from)) links.add(ed.from); if (!set.has(ed.to)) links.add(ed.to) }
      }
      const list = [...edges.values()].filter((ed) => !(a.main.has(ed.from) && a.main.has(ed.to)))
      const first = g.nodes.get(nodes[0])!
      const grp: ReachGroup = {
        id: ++gid, role, border: nodes.some((id) => { const nd = g.nodes.get(id)!; return nearBorder(nd.lat, nd.lon) }),
        nodes, edgeIds: list.map((x) => x.id), wayIds: [...new Set(list.map((x) => x.wayId))],
        km: list.reduce((acc, x) => acc + x.length, 0) / 1000, links: [...links].slice(0, 8), at: { lat: first.lat, lon: first.lon },
      }
      out.groups.push(grp)
      for (const ed of list) if (!out.edgeGroup.has(ed.id)) out.edgeGroup.set(ed.id, grp)
    }
  }
  add(a.traps, 'trap'); add(a.noEntry, 'noEntry'); add(a.detached, 'detached')
  out.groups.sort((x, y) => Number(x.border) - Number(y.border) || y.km - x.km)
  out.mainEdges = g.edges.filter((ed) => a.main.has(ed.from) && a.main.has(ed.to)).length
  for (const grp of out.groups) { if (grp.border) out.borderKm += grp.km; else out.realKm += grp.km }
  return out
}

let cache: { doc: OsmDocument; version: number; r: Reachability } | null = null
export function reachabilityFor(doc: OsmDocument, version: number): Reachability {
  if (cache && cache.doc === doc && cache.version === version) return cache.r
  const r = reachability(graphFor(doc, version))
  cache = { doc, version, r }
  return r
}

export const ROLE_LABEL: Record<ReachRole, string> = {
  trap: 'Ловушка: въехать можно, выехать нельзя',
  noEntry: 'Нет въезда: выехать можно, попасть нельзя',
  detached: 'Остров: нет проезда ни туда, ни обратно',
}
