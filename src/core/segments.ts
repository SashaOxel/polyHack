import { project } from './geo'
import { onewayDirection } from './roads'
import type { Tx } from './store'
import type { OsmDocument, OsmMember, OsmRelation, OsmWay } from './types'

function roadLine(way: OsmWay) {
  return !!way.tags.highway && way.tags.area !== 'yes' && way.nodes.length > 2
}

/** Order a split member in the direction in which its relation traverses it. */
function orderedParts(parts: OsmWay[], member: OsmMember, previous?: OsmWay, next?: OsmWay) {
  const first = parts[0].nodes[0]
  const last = parts.at(-1)!.nodes.at(-1)!
  const backwards = member.role === 'backward' ||
    (member.role !== 'forward' && (
      (!!previous?.nodes.includes(last) && !previous.nodes.includes(first)) ||
      (!!next?.nodes.includes(first) && !next.nodes.includes(last))
    ))
  return backwards ? [...parts].reverse() : parts
}

function incident(parts: OsmWay[], node: number, incoming: boolean) {
  return parts.filter(part => {
    const direction = onewayDirection(part)
    const first = part.nodes[0], last = part.nodes.at(-1)!
    if (incoming) return (direction >= 0 && last === node) || (direction <= 0 && first === node)
    return (direction >= 0 && first === node) || (direction <= 0 && last === node)
  })
}

function matchesTurn(doc: OsmDocument, from: OsmWay, to: OsmWay, via: number, restriction: string) {
  if (restriction.endsWith('u_turn')) return from.id === to.id
  const before = doc.nodes.get(from.nodes.find(id => id !== via)!)
  const center = doc.nodes.get(via)
  const after = doc.nodes.get(to.nodes.find(id => id !== via)!)
  if (!before || !center || !after) return true
  const a = project(before.lat, before.lon), b = project(center.lat, center.lon), c = project(after.lat, after.lon)
  const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y
  const angle = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  if (restriction.endsWith('left_turn')) return angle > Math.PI / 6 && angle < Math.PI * 5 / 6
  if (restriction.endsWith('right_turn')) return angle < -Math.PI / 6 && angle > -Math.PI * 5 / 6
  if (restriction.endsWith('straight_on')) return Math.abs(angle) <= Math.PI / 6
  return true
}

function updateRestriction(
  relation: OsmRelation, original: Map<number, OsmWay>, replacements: Map<number, OsmWay[]>,
  doc: OsmDocument, tx: Tx,
) {
  const fromMember = relation.members.find(m => m.type === 'way' && m.role === 'from')
  const toMember = relation.members.find(m => m.type === 'way' && m.role === 'to')
  if (!fromMember || !toMember) return
  const from = replacements.get(fromMember.ref) ?? (original.has(fromMember.ref) ? [original.get(fromMember.ref)!] : [])
  const to = replacements.get(toMember.ref) ?? (original.has(toMember.ref) ? [original.get(toMember.ref)!] : [])
  const viaNode = relation.members.find(m => m.type === 'node' && m.role === 'via')
  if (viaNode) {
    const incoming = incident(from, viaNode.ref, true)
    const outgoing = incident(to, viaNode.ref, false)
    // A clipped relation can have one external member. Update its known side too.
    if (!incoming.length || !outgoing.length) {
      tx.setRelation({
        ...relation,
        members: relation.members.map(member => {
          if (member === fromMember && incoming.length === 1) return { ...member, ref: incoming[0].id }
          if (member === toMember && outgoing.length === 1) return { ...member, ref: outgoing[0].id }
          return member
        }),
      })
      return
    }
    const pairs = incoming.flatMap(a => outgoing.map(b => ({ from: a, to: b })))
    const selected = pairs.length > 1
      ? pairs.filter(pair => matchesTurn(doc, pair.from, pair.to, viaNode.ref, relation.tags.restriction ?? ''))
      : pairs
    selected.forEach((pair, index) => {
      tx.setRelation({
        ...relation, id: index === 0 ? relation.id : tx.newId(),
        members: relation.members.map(member => {
          if (member === fromMember) return { ...member, ref: pair.from.id }
          if (member === toMember) return { ...member, ref: pair.to.id }
          return member
        }),
      })
    })
    return
  }
  const via = relation.members.filter(m => m.type === 'way' && m.role === 'via')
  if (!via.length) return
  const path = via.flatMap((member, index) => {
    const parts = replacements.get(member.ref) ?? (original.has(member.ref) ? [original.get(member.ref)!] : [])
    if (!parts.length) return []
    return orderedParts(parts, member, original.get(index === 0 ? fromMember.ref : via[index - 1].ref),
      original.get(index === via.length - 1 ? toMember.ref : via[index + 1].ref))
  })
  if (!path.length) return
  const first = path[0], last = path.at(-1)!
  const entry = first.nodes.find(id => from.some(part => part.nodes.includes(id)))
  const exit = last.nodes.find(id => to.some(part => part.nodes.includes(id)))
  if (entry === undefined || exit === undefined) return
  const incoming = incident(from, entry, true), outgoing = incident(to, exit, false)
  if (incoming.length !== 1 || outgoing.length !== 1) return
  let inserted = false
  const members = relation.members.flatMap(member => {
    if (member === fromMember) return [{ ...member, ref: incoming[0].id }]
    if (member === toMember) return [{ ...member, ref: outgoing[0].id }]
    if (member.type !== 'way' || member.role !== 'via') return [member]
    if (inserted) return []
    inserted = true
    return path.map(part => ({ type: 'way' as const, role: 'via', ref: part.id }))
  })
  tx.setRelation({ ...relation, members })
}

/** Split linear roads at every node. Areas keep their polygon geometry. */
export function splitRoadSegments(doc: OsmDocument, tx: Tx): number {
  const original = new Map(doc.ways)
  const replacements = new Map<number, OsmWay[]>()
  for (const way of original.values()) {
    if (!roadLine(way)) continue
    const parts: OsmWay[] = []
    for (let index = 1; index < way.nodes.length; index++) {
      const id = index === 1 ? way.id : tx.newId()
      const part = { ...way, id, nodes: way.nodes.slice(index - 1, index + 1), tags: { ...way.tags }, meta: index === 1 ? way.meta : {} }
      parts.push(part)
      tx.setWay(part)
    }
    replacements.set(way.id, parts)
  }
  if (!replacements.size) return 0
  for (const relation of [...doc.relations.values()]) {
    if (!relation.members.some(member => member.type === 'way' && replacements.has(member.ref))) continue
    if (relation.tags.type === 'restriction') {
      updateRestriction(relation, original, replacements, doc, tx)
      continue
    }
    const members = relation.members.flatMap((member, index) => {
      const parts = member.type === 'way' ? replacements.get(member.ref) : undefined
      if (!parts) return [member]
      const previousMember = relation.members[index - 1], nextMember = relation.members[index + 1]
      const previous = previousMember?.type === 'way' ? original.get(previousMember.ref) : undefined
      const next = nextMember?.type === 'way' ? original.get(nextMember.ref) : undefined
      return orderedParts(parts, member, previous, next).map(part => ({ ...member, ref: part.id }))
    })
    tx.setRelation({ ...relation, members })
  }
  return replacements.size
}
