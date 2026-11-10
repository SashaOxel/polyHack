// Отчёт о достижимости для машин:  npm run reach -- файл.osm
import { readFileSync } from 'node:fs'
import { buildGraph } from '../src/core/graph'
import { parseOsm } from '../src/core/parse'
import { ROLE_LABEL, reachability } from '../src/core/reachability'

const input = process.argv[2]
if (!input) { console.error('Использование: npm run reach -- файл.osm'); process.exit(2) }
const doc = parseOsm(readFileSync(input, 'utf8'))
const r = reachability(buildGraph(doc))
console.log(`Рёбер для машин: ${r.totalEdges}; в главной сети: ${r.mainEdges}; вне неё: ${r.totalEdges - r.mainEdges}`)
console.log(`Вне главной сети: ${r.realKm.toFixed(1)} км (вероятные ошибки) + ${r.borderKm.toFixed(1)} км у края карты (обрезка выгрузки)`)
for (const g of r.groups.slice(0, 25)) {
  const names = [...new Set(g.wayIds.map((w) => doc.ways.get(w)?.tags.name).filter(Boolean))].slice(0, 3).join(', ') || '—'
  console.log(`#${g.id} ${g.border ? '[край]' : '[внутри]'} ${ROLE_LABEL[g.role]} · ${g.km.toFixed(2)} км · улицы: ${names} · стык с сетью: узел ${g.links.join(', ') || '—'}`)
}
