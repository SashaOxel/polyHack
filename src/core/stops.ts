import { distanceM } from './geo'
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
