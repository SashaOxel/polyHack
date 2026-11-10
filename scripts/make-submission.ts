// Подготовка файла для сервера проверки:  npm run make:submission -- <исходный.osm> <имя-команды> [папка]
// Делает то же, что редактор: проверка → автоисправление → запись .osm (со зданиями, трамваями, остановками — как в примере организаторов).
// Файл называется <имя-команды>.osm — это требование сервера.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseOsm } from '../src/core/parse'
import { serializeOsm } from '../src/core/serialize'
import { Store } from '../src/core/store'
import { validate } from '../src/validate'
import { applyAutoFixes } from '../src/validate/fixes'

const [input, team, outArg] = process.argv.slice(2)
if (!input || !team) { console.error('Использование: npm run make:submission -- <файл.osm> <имя-команды> [папка]'); process.exit(2) }
const out = resolve(outArg ?? 'out/submit')
mkdirSync(out, { recursive: true })

const store = new Store()
store.load(parseOsm(readFileSync(input, 'utf8')), input)
const before = validate(store.doc)
const fixed = applyAutoFixes(store, before)
const after = validate(store.doc)
const count = (l: { severity: string }[], s: string) => l.filter((i) => i.severity === s).length
const text = serializeOsm(store.doc, { onlyRoads: false, includePedestrian: true, keepMeta: true })
writeFileSync(join(out, `${team}.osm`), text)
console.log(`Файл для сервера: ${join(out, team + '.osm')} (${(text.length / 1e6).toFixed(1)} МБ)`)
console.log(`Было: ошибок ${count(before, 'error')}, предупреждений ${count(before, 'warning')}; исправлено автоматически: ${fixed}`)
console.log(`Осталось: ошибок ${count(after, 'error')}, предупреждений ${count(after, 'warning')}`)
