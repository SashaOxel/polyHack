// Статистика транспортного графа для .osm: npm run stats -- data/example.osm
import { readFileSync } from 'node:fs'
import { analyze, buildGraph } from '../src/core/graph'
import { parseOsm } from '../src/core/parse'
import { validate } from '../src/validate'

const file = process.argv[2] ?? 'data/example.osm'
const doc = parseOsm(readFileSync(file, 'utf8'))
const t0 = performance.now()
const g = buildGraph(doc)
const a = analyze(g)
const ms = Math.round(performance.now() - t0)

console.log(`${file}: узлов графа ${g.nodes.size}, рёбер ${g.edges.length}, время ${ms} мс`)
console.log(`основная сеть: ${a.main.size} узлов из ${g.nodes.size}`)
console.log(`ловушек: ${a.traps.length}, нет въезда: ${a.noEntry.length}, отдельных кусков: ${a.detached.length}`)
const byCode: Record<string, number> = {}
for (const i of validate(doc)) byCode[i.code] = (byCode[i.code] ?? 0) + 1
console.log('проблем по типам:', byCode)
