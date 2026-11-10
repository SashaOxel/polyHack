import { distanceM } from './geo'
import { isDrivable } from './roads'
import type { OsmDocument, OsmRelation, Tags } from './types'

/** Stops placed by this editor share a road node and one passenger platform. */
export function linkedStop(relation: OsmRelation) {
  if (relation.tags.public_transport !== 'stop_area' ||
      relation.tags['polyhack:linked'] !== 'yes' || relation.members.length !== 2) return
  const anchor = relation.members.find(m => m.type === 'node' && m.role === 'stop')
  const platform = relation.members.find(m => m.type === 'node' && m.role === 'platform')
  if (anchor && platform) return { anchor: anchor.ref, platform: platform.ref, area: relation.id }
}

export function stopsAt(doc: OsmDocument, nodeId: number) {
  const stops = []
  for (const relation of doc.relations.values()) {
    const stop = linkedStop(relation)
    if (stop && (stop.anchor === nodeId || stop.platform === nodeId)) stops.push(stop)
  }
  return stops
}

/** Узел — место посадки (остановка из OSM или созданная редактором). */
export const isStopPlatform = (t: Tags) => t.highway === 'bus_stop' || t.public_transport === 'platform'

/**
 * Автобусная (троллейбусная) остановка — её надо привязать к узлу автомобильной дороги.
 * Трамвайные и ж/д платформы сюда не относятся: они стоят у путей.
 */
export const isBusPlatform = (t: Tags) =>
  t.highway === 'bus_stop' ||
  (t.public_transport === 'platform' && t.railway === undefined && t.tram !== 'yes' && t.train !== 'yes')

/**
 * Ближайший СУЩЕСТВУЮЩИЙ узел дороги к точке. Остановка привязывается к нему,
 * новый узел в дорогу не вставляется.
 */
export function nearestWayNode(doc: OsmDocument, wayId: number, lat: number, lon: number): number | undefined {
  const way = doc.ways.get(wayId)
  if (!way) return
  let best: { id: number; d: number } | undefined
  for (const id of way.nodes) {
    const n = doc.nodes.get(id)
    if (!n) continue
    const d = distanceM(lat, lon, n.lat, n.lon)
    if (!best || d < best.d) best = { id, d }
  }
  return best?.id
}

/** Ближайший узел дороги для машин, к которому ещё не привязана остановка. */
export function nearestFreeRoadNode(doc: OsmDocument, lat: number, lon: number): number | undefined {
  const anchors = new Set<number>()
  for (const r of doc.relations.values()) { const s = linkedStop(r); if (s) anchors.add(s.anchor) }
  let best: { id: number; d: number } | undefined
  const seen = new Set<number>()
  for (const w of doc.ways.values()) {
    if (!isDrivable(w)) continue
    for (const id of w.nodes) {
      if (seen.has(id) || anchors.has(id)) continue
      seen.add(id)
      const n = doc.nodes.get(id)
      if (!n) continue
      const d = distanceM(lat, lon, n.lat, n.lon)
      if (!best || d < best.d) best = { id, d }
    }
  }
  return best?.id
}
