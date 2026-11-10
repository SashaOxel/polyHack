import type { ElementKind, OsmDocument } from './types'

/** Reserve references too, so a clipped OSM relation cannot acquire an unrelated new member. */
export function createIdGenerator(doc: OsmDocument): () => number {
  const reserved = new Set<number>()
  let lastId = 0
  const reserve = (id: number) => {
    if (!Number.isSafeInteger(id) || id <= 0) return
    reserved.add(id)
    lastId = Math.max(lastId, id)
  }
  for (const elements of [doc.nodes, doc.ways, doc.relations]) {
    for (const id of elements.keys()) reserve(id)
  }
  for (const way of doc.ways.values()) {
    for (const id of way.nodes) reserve(id)
  }
  for (const relation of doc.relations.values()) {
    for (const member of relation.members) reserve(member.ref)
  }
  return () => {
    do {
      lastId = lastId === Number.MAX_SAFE_INTEGER ? 1 : lastId + 1
    } while (reserved.has(lastId))
    reserved.add(lastId)
    return lastId
  }
}

/** Migrate temporary IDs from earlier editor versions, preserving every reference. */
export function positiveIds(doc: OsmDocument, allocate: () => number): OsmDocument {
  const replacements: Record<ElementKind, Map<number, number>> = {
    node: new Map(), way: new Map(), relation: new Map(),
  }
  for (const [kind, elements] of [
    ['node', doc.nodes], ['way', doc.ways], ['relation', doc.relations],
  ] as const) {
    for (const id of elements.keys()) {
      if (id < 0) replacements[kind].set(id, allocate())
    }
  }
  if (Object.values(replacements).every(map => map.size === 0)) return doc
  const mapped = (kind: ElementKind, id: number) => replacements[kind].get(id) ?? id
  return {
    ...doc,
    nodes: new Map([...doc.nodes.values()].map(node => {
      const id = mapped('node', node.id)
      return [id, { ...node, id }]
    })),
    ways: new Map([...doc.ways.values()].map(way => {
      const id = mapped('way', way.id)
      return [id, { ...way, id, nodes: way.nodes.map(node => mapped('node', node)) }]
    })),
    relations: new Map([...doc.relations.values()].map(relation => {
      const id = mapped('relation', relation.id)
      const members = relation.members.map(member => ({ ...member, ref: mapped(member.type, member.ref) }))
      return [id, { ...relation, id, members }]
    })),
  }
}
