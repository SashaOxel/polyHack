import { cumulativeDistance } from './elevation'
import { analyze, buildGraph } from './graph'
import { HIGHWAY_LABELS, PEDESTRIAN, hasCrossing, hasSignal, isDrivable, isTram, laneInfo, speedLimit } from './roads'
import { readPlan } from './signals'
import { isBusPlatform, linkedStop } from './stops'
import type { OsmDocument } from './types'

/** Показатели дорожной сети для дашборда. Длины — в километрах. */
export interface NetworkStats {
  roadKm: number
  laneKm: number
  pedKm: number
  tramKm: number
  roads: number
  junctions: number
  signals: number
  signalsWithPlan: number
  crossings: number
  stops: number
  stopsLinked: number
  /** доля перекрёстков в основной сильно связной компоненте, 0…1 */
  connectivity: number
  /** длина дорог для машин по классам, по убыванию */
  byClass: { key: string; label: string; km: number }[]
  /** длина по ограничению скорости (по убыванию длины); «не задано» — отдельно */
  bySpeed: { key: string; label: string; km: number }[]
}

const km = (doc: OsmDocument, wayId: number) => {
  const w = doc.ways.get(wayId)!
  return (cumulativeDistance(doc, w).at(-1) ?? 0) / 1000
}

export function networkStats(doc: OsmDocument): NetworkStats {
  let roadKm = 0, laneKm = 0, pedKm = 0, tramKm = 0, roads = 0
  const byClass = new Map<string, number>(), bySpeed = new Map<string, number>()
  const roadNodes = new Set<number>()
  for (const w of doc.ways.values()) {
    if (isTram(w)) { tramKm += km(doc, w.id); continue }
    const hw = w.tags.highway
    if (!hw) continue
    if (isDrivable(w)) {
      const len = km(doc, w.id)
      roads++
      roadKm += len
      laneKm += len * (laneInfo(w)?.total ?? 1)
      byClass.set(hw, (byClass.get(hw) ?? 0) + len)
      const sp = speedLimit(w)
      const key = sp.source === 'default' ? 'unset' : sp.kmh === null ? 'none' : String(sp.kmh)
      bySpeed.set(key, (bySpeed.get(key) ?? 0) + len)
      for (const n of w.nodes) roadNodes.add(n)
    } else if (PEDESTRIAN.has(hw)) pedKm += km(doc, w.id)
  }

  const g = buildGraph(doc)
  // перекрёсток — узел графа, где сходятся хотя бы три соседних узла
  let junctions = 0
  for (const n of g.nodes.values()) {
    const nb = new Set([...n.in.map((e) => e.from), ...n.out.map((e) => e.to)])
    if (nb.size >= 3) junctions++
  }
  const a = analyze(g)

  let signals = 0, signalsWithPlan = 0, crossings = 0
  for (const id of roadNodes) {
    const n = doc.nodes.get(id)
    if (!n) continue
    if (hasSignal(n.tags)) { signals++; if (readPlan(n.tags)) signalsWithPlan++ }
    if (hasCrossing(n.tags)) crossings++
  }
  const platforms = new Set<number>()
  for (const r of doc.relations.values()) { const s = linkedStop(r); if (s) platforms.add(s.platform) }
  let stops = 0, stopsLinked = 0
  for (const n of doc.nodes.values()) if (isBusPlatform(n.tags)) { stops++; if (platforms.has(n.id)) stopsLinked++ }

  const speedLabel = (k: string) => (k === 'unset' ? 'не задано' : k === 'none' ? 'без огр.' : `${k} км/ч`)
  return {
    roadKm, laneKm, pedKm, tramKm, roads, junctions, signals, signalsWithPlan, crossings, stops, stopsLinked,
    connectivity: g.nodes.size ? a.main.size / g.nodes.size : 0,
    byClass: [...byClass].map(([key, v]) => ({ key, label: HIGHWAY_LABELS[key] ?? key, km: v })).sort((x, y) => y.km - x.km),
    bySpeed: [...bySpeed].map(([key, v]) => ({ key, label: speedLabel(key), km: v })).sort((x, y) => y.km - x.km),
  }
}
