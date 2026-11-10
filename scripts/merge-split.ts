// Склеить обратно дороги, нарезанные на куски:  npm run merge:split -- вход.osm выход.osm
// Соединяет подряд идущие дороги с одинаковыми тегами через узел, который никого больше не касается (не перекрёсток),
// если ни одна из них не участвует в отношениях (запреты поворотов, маршруты).
import { readFileSync, writeFileSync } from 'node:fs'
import { parseOsm } from '../src/core/parse'
import { serializeOsm } from '../src/core/serialize'
import { isDrivable, onewayDirection } from '../src/core/roads'
import type { OsmWay } from '../src/core/types'

const [input, output] = process.argv.slice(2)
if (!input || !output) { console.error('Использование: npm run merge:split -- вход.osm выход.osm'); process.exit(2) }
const doc = parseOsm(readFileSync(input, 'utf8'))

const inRelation = new Set<number>()
for (const r of doc.relations.values()) for (const m of r.members) if (m.type === 'way') inRelation.add(m.ref)
const key = (w: OsmWay) => JSON.stringify(Object.entries(w.tags).sort())
const uses = new Map<number, OsmWay[]>() // узел → дороги, в которых он есть (в любом месте)
for (const w of doc.ways.values()) for (const n of w.nodes) { const l = uses.get(n) ?? []; l.push(w); uses.set(n, l) }

let merged = 0
let changed = true
while (changed) {
  changed = false
  for (const a of [...doc.ways.values()]) {
    if (!doc.ways.has(a.id) || !isDrivable(a) || inRelation.has(a.id)) continue
    for (const end of [a.nodes[a.nodes.length - 1], a.nodes[0]]) {
      const at = uses.get(end) ?? []
      if (at.length !== 2 || end === a.nodes[0] && end === a.nodes[a.nodes.length - 1]) continue
      const b = at.find((w) => w !== a)!
      if (!doc.ways.has(b.id) || inRelation.has(b.id) || !isDrivable(b) || key(a) !== key(b) || (doc.nodes.get(end)?.tags.highway)) continue
      // концы должны быть в `end`, и направление односторонней дороги не должно ломаться
      const aEnd = a.nodes[a.nodes.length - 1] === end, bStart = b.nodes[0] === end, bEnd = b.nodes[b.nodes.length - 1] === end
      if (!(aEnd ? bStart || bEnd : (a.nodes[0] === end && (bStart || bEnd)))) continue
      const ow = onewayDirection(a) !== 0
      let an = [...a.nodes], bn = [...b.nodes]
      if (ow) { if (!(aEnd && bStart)) continue } // у односторонних порядок узлов уже совпадает с движением
      else { if (!aEnd) an = an.reverse(); if (bEnd && !bStart) bn = bn.reverse() }
      const nodes = [...an, ...bn.slice(1)]
      if (new Set(nodes).size !== nodes.length) continue // кольцо — не трогаем
      for (const n of b.nodes) uses.set(n, (uses.get(n) ?? []).filter((w) => w !== b))
      const na = { ...a, nodes }
      doc.ways.set(a.id, na); doc.ways.delete(b.id)
      for (const n of nodes) { const l = (uses.get(n) ?? []).filter((w) => w !== a && w !== b); l.push(na); uses.set(n, l) }
      merged++; changed = true
      break
    }
  }
}
writeFileSync(output, serializeOsm(doc, { onlyRoads: false, includePedestrian: true, keepMeta: true }))
console.log(`Склеено дорог: ${merged}; дорог для машин теперь ${[...doc.ways.values()].filter(isDrivable).length}. Записано: ${output}`)
