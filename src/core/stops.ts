import type { OsmDocument, OsmRelation } from './types'

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
