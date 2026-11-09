import { distanceM } from './geo'
import { isDrivable, onewayDirection } from './roads'
import type { OsmDocument } from './types'

/**
 * ТРАНСПОРТНЫЙ ГРАФ — производная структура, строится из OsmDocument и ничего в нём не меняет.
 *
 *   узел графа  = значимый узел OSM: перекрёсток (узел в 2+ местах дорог) или конец дороги;
 *   ребро графа = отрезок дороги между двумя значимыми узлами, направленное.
 *
 * Двусторонняя дорога даёт два ребра (туда и обратно), oneway — одно.
 * Только дороги для машин (isDrivable). Пересчитывать после правок: graphFor(doc, store.version).
 */

export interface GEdge {
  /** `${wayId}:${номер отрезка}:f|b` */
  id: string
  wayId: number
  from: number
  to: number
  /** OSM-узлы вдоль ребра, включая оба конца, в направлении движения */
  nodes: number[]
  length: number
  lanes: number
  /** км/ч, если задано числом */
  maxspeed?: number
  oneway: boolean
}

export interface GNode {
  id: number
  lat: number
  lon: number
  out: GEdge[]
  in: GEdge[]
}

export interface RoadGraph {
  nodes: Map<number, GNode>
  edges: GEdge[]
}

const parseSpeed = (v?: string) => (v && /^\d+(\.\d+)?$/.test(v) ? Number(v) : undefined)

export function buildGraph(doc: OsmDocument): RoadGraph {
  const ways = [...doc.ways.values()].filter(isDrivable)

  // сколько раз узел встречается среди дорог (в разных местах) — >1 значит перекрёсток
  const occ = new Map<number, number>()
  for (const w of ways) for (const n of w.nodes) occ.set(n, (occ.get(n) ?? 0) + 1)

  const graph: RoadGraph = { nodes: new Map(), edges: [] }
  const node = (id: number): GNode => {
    let g = graph.nodes.get(id)
    if (!g) {
      const n = doc.nodes.get(id)!
      g = { id, lat: n.lat, lon: n.lon, out: [], in: [] }
      graph.nodes.set(id, g)
    }
    return g
  }

  for (const w of ways) {
    const dir = onewayDirection(w)
    const lanesAll = Number(w.tags.lanes) || undefined
    const speed = parseSpeed(w.tags.maxspeed)

    // режем way на отрезки в значимых узлах и в разрывах (узлов нет в файле)
    const segments: number[][] = []
    let cur: number[] = []
    const flush = () => { if (cur.length > 1) segments.push(cur); cur = [] }
    for (let i = 0; i < w.nodes.length; i++) {
      const id = w.nodes[i]
      if (!doc.nodes.has(id)) { flush(); continue }
      cur.push(id)
      const significant = i === w.nodes.length - 1 || (occ.get(id) ?? 0) > 1
      if (significant && cur.length > 1) { segments.push(cur); cur = [id] }
    }
    flush()

    segments.forEach((seg, si) => {
      let length = 0
      for (let i = 1; i < seg.length; i++) {
        const a = doc.nodes.get(seg[i - 1])!, b = doc.nodes.get(seg[i])!
        length += distanceM(a.lat, a.lon, b.lat, b.lon)
      }
      const make = (forward: boolean): GEdge => {
        const nodes = forward ? seg : [...seg].reverse()
        const lanesDir = Number(w.tags[forward ? 'lanes:forward' : 'lanes:backward'])
        const lanes = lanesDir || (dir === 0 && lanesAll ? Math.max(1, Math.round(lanesAll / 2)) : lanesAll) || 1
        return {
          id: `${w.id}:${si}:${forward ? 'f' : 'b'}`,
          wayId: w.id, from: nodes[0], to: nodes[nodes.length - 1],
          nodes, length, lanes, maxspeed: speed, oneway: dir !== 0,
        }
      }
      const add = (e: GEdge) => { graph.edges.push(e); node(e.from).out.push(e); node(e.to).in.push(e) }
      if (dir >= 0) add(make(true))
      if (dir <= 0) add(make(false))
    })
  }
  return graph
}

/** Кэш: граф пересчитывается только когда изменилась версия документа. */
let cache: { doc: OsmDocument; version: number; graph: RoadGraph } | null = null
export function graphFor(doc: OsmDocument, version: number): RoadGraph {
  if (cache && cache.doc === doc && cache.version === version) return cache.graph
  const graph = buildGraph(doc)
  cache = { doc, version, graph }
  return graph
}

/** Компоненты сильной связности (алгоритм Тарьяна, без рекурсии). Возвращает группы id узлов. */
export function stronglyConnectedComponents(g: RoadGraph): number[][] {
  const index = new Map<number, number>()
  const low = new Map<number, number>()
  const onStack = new Set<number>()
  const stack: number[] = []
  const comps: number[][] = []
  let counter = 0

  for (const start of g.nodes.keys()) {
    if (index.has(start)) continue
    const work: { v: number; i: number }[] = []
    const enter = (v: number) => {
      index.set(v, counter); low.set(v, counter); counter++
      stack.push(v); onStack.add(v)
      work.push({ v, i: 0 })
    }
    enter(start)
    while (work.length) {
      const f = work[work.length - 1]
      const outs = g.nodes.get(f.v)!.out
      if (f.i < outs.length) {
        const w = outs[f.i++].to
        if (!index.has(w)) enter(w)
        else if (onStack.has(w)) low.set(f.v, Math.min(low.get(f.v)!, index.get(w)!))
      } else {
        work.pop()
        if (low.get(f.v) === index.get(f.v)) {
          const comp: number[] = []
          let w: number
          do { w = stack.pop()!; onStack.delete(w); comp.push(w) } while (w !== f.v)
          comps.push(comp)
        }
        if (work.length) {
          const p = work[work.length - 1].v
          low.set(p, Math.min(low.get(p)!, low.get(f.v)!))
        }
      }
    }
  }
  return comps
}

/** Обход от набора узлов по направлению (forward) или против (backward). */
function reach(g: RoadGraph, from: Iterable<number>, forward: boolean): Set<number> {
  const seen = new Set<number>(from)
  const queue = [...seen]
  while (queue.length) {
    const v = queue.pop()!
    for (const e of forward ? g.nodes.get(v)!.out : g.nodes.get(v)!.in) {
      const w = forward ? e.to : e.from
      if (!seen.has(w)) { seen.add(w); queue.push(w) }
    }
  }
  return seen
}

/** Слабые компоненты внутри заданного набора узлов (рёбра считаются без направления). */
function groupWeak(g: RoadGraph, set: Set<number>): number[][] {
  const seen = new Set<number>()
  const groups: number[][] = []
  for (const s of set) {
    if (seen.has(s)) continue
    const grp: number[] = []
    const queue = [s]
    seen.add(s)
    while (queue.length) {
      const v = queue.pop()!
      grp.push(v)
      const n = g.nodes.get(v)!
      for (const e of [...n.out, ...n.in]) {
        const w = e.from === v ? e.to : e.from
        if (set.has(w) && !seen.has(w)) { seen.add(w); queue.push(w) }
      }
    }
    groups.push(grp)
  }
  return groups.sort((a, b) => b.length - a.length)
}

export interface GraphAnalysis {
  /** все компоненты сильной связности, от большой к малой */
  components: number[][]
  /** основная сеть = самая большая сильно связная компонента */
  main: Set<number>
  /** «ловушки»: из основной сети въехать можно, вернуться нельзя */
  traps: number[][]
  /** «нет въезда»: выехать в основную сеть можно, попасть сюда из неё нельзя */
  noEntry: number[][]
  /** не связаны с основной сетью вообще, ни в одну сторону */
  detached: number[][]
}

export function analyze(g: RoadGraph): GraphAnalysis {
  const components = stronglyConnectedComponents(g).sort((a, b) => b.length - a.length)
  const main = new Set(components[0] ?? [])
  if (!main.size) return { components, main, traps: [], noEntry: [], detached: [] }

  const fromMain = reach(g, main, true)   // куда можно доехать из основной сети
  const toMain = reach(g, main, false)    // откуда можно доехать до основной сети

  const traps = new Set<number>(), noEntry = new Set<number>(), detached = new Set<number>()
  for (const id of g.nodes.keys()) {
    if (main.has(id)) continue
    const f = fromMain.has(id), t = toMain.has(id)
    if (f && !t) traps.add(id)
    else if (!f && t) noEntry.add(id)
    else if (!f && !t) detached.add(id)
  }
  return {
    components, main,
    traps: groupWeak(g, traps),
    noEntry: groupWeak(g, noEntry),
    detached: groupWeak(g, detached),
  }
}

/** id дорог, рёбра которых лежат внутри группы узлов (для подсветки и перехода к проблеме). */
export function waysOfGroup(g: RoadGraph, group: number[]): number[] {
  const set = new Set(group)
  const ways = new Set<number>()
  for (const id of group) {
    const n = g.nodes.get(id)!
    for (const e of [...n.out, ...n.in]) if (set.has(e.from) && set.has(e.to)) ways.add(e.wayId)
  }
  // группа из одного узла: берём примыкающие дороги
  if (!ways.size) for (const id of group) {
    const n = g.nodes.get(id)!
    for (const e of [...n.out, ...n.in]) ways.add(e.wayId)
  }
  return [...ways]
}
