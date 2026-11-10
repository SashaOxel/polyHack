// Чек-лист мест, где карта, вероятно, расходится с реальностью:  npm run checklist -- файл.osm [out/checklist.md]
import { readFileSync, writeFileSync } from 'node:fs'
import { buildGraph } from '../src/core/graph'
import { findCrossings } from '../src/core/crossings'
import { parseOsm } from '../src/core/parse'
import { ROLE_LABEL, reachability } from '../src/core/reachability'
import { HIGHWAY_LABELS, hasCrossing, hasSignal, isDrivable, onewayDirection } from '../src/core/roads'
import type { OsmWay } from '../src/core/types'

const [input, outFile = 'out/checklist.md'] = process.argv.slice(2)
if (!input) { console.error('Использование: npm run checklist -- файл.osm [out/checklist.md]'); process.exit(2) }
const doc = parseOsm(readFileSync(input, 'utf8'))
const cars = [...doc.ways.values()].filter(isDrivable)
const mid = (w: OsmWay) => { const n = doc.nodes.get(w.nodes[Math.floor(w.nodes.length / 2)]); return n ? { lat: n.lat, lon: n.lon } : { lat: 0, lon: 0 } }
const nm = (w: OsmWay) => w.tags.name ?? `(без названия, ${HIGHWAY_LABELS[w.tags.highway] ?? w.tags.highway})`
const link = (w: OsmWay) => `[${w.id}](https://www.openstreetmap.org/way/${w.id})`
const at = (p: { lat: number; lon: number }) => `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`
const lines: string[] = ['# Чек-лист: где карта может расходиться с реальностью', '',
  'Откройте слой «Подложка → Спутник», по каждому пункту решите: ошибка данных (правим) или так и есть (оставляем). В редакторе — Ctrl+K и номер дороги.', '']

// 1. Достижимость
const r = reachability(buildGraph(doc))
lines.push(`## 1. Недостижимые для машин участки (${r.groups.filter((g) => !g.border).length} внутри карты)`, '',
  'Из-за них в SUMO «машина не нашла маршрут». Проверьте: нет ли в жизни встречного направления/съезда/проезда.', '')
for (const g of r.groups.filter((x) => !x.border)) {
  const ws = g.wayIds.map((id) => doc.ways.get(id)!).filter(Boolean)
  lines.push(`- **${ROLE_LABEL[g.role]}** · ${g.km.toFixed(2)} км · ${[...new Set(ws.map(nm))].slice(0, 3).join(', ')} · около ${at(g.at)} · дороги: ${ws.slice(0, 5).map(link).join(', ')}`)
}
const border = r.groups.filter((g) => g.border)
lines.push('', `У края карты ещё ${border.length} групп (${r.borderKm.toFixed(1)} км) — скорее всего обрезка выгрузки: ${border.map((g) => ROLE_LABEL[g.role].split(':')[0]).join(', ')}.`, '')

// 2. Главные дороги без полос/скорости
lines.push('## 2. Магистрали и улицы без числа полос или скорости', '', 'Полосы и скорость видны на всех трёх уровнях. Задайте по факту.', '')
const major = cars.filter((w) => ['primary', 'secondary', 'tertiary', 'primary_link', 'secondary_link'].includes(w.tags.highway) && (!w.tags.lanes && !w.tags['lanes:forward']))
for (const w of major.slice(0, 40)) lines.push(`- ${nm(w)} · ${link(w)} · около ${at(mid(w))} · ${w.tags.highway}${w.tags.maxspeed ? `, maxspeed=${w.tags.maxspeed}` : ', нет maxspeed'}`)
if (major.length > 40) lines.push(`- … и ещё ${major.length - 40}`)
lines.push('')

// 3. Нечисловые maxspeed
const odd = cars.filter((w) => w.tags.maxspeed && !/^\d+( ?(mph|km\/h))?$/.test(w.tags.maxspeed))
lines.push(`## 3. Нечисловые ограничения скорости (${odd.length})`, '', 'RU:urban в России = 60 км/ч (SUMO и MATSim нечисловое значение не понимают).', '')
for (const w of odd) lines.push(`- ${nm(w)} · ${link(w)} · maxspeed=${w.tags.maxspeed}`)
lines.push('')

// 4. Светофоры и переходы
const sig = [...doc.nodes.values()].filter((n) => hasSignal(n.tags)), cross = [...doc.nodes.values()].filter((n) => hasCrossing(n.tags))
lines.push(`## 4. Светофоры (${sig.length}) и переходы (${cross.length})`, '', 'Сверьте со спутником/картой: все ли светофоры на месте, нет ли лишних, у всех ли светофоров есть переходы.', '')
for (const n of sig) lines.push(`- светофор · узел ${n.id} · ${at(n)}`)
lines.push('')

// 5. Пересечения дорог без общего узла (на одном уровне)
const bad = findCrossings(doc)
lines.push(`## 5. Дороги пересекаются без общего узла (${bad.length})`, '', 'Если в жизни это перекрёсток, машины не смогут повернуть. Мост/тоннель — оставить. В редакторе у каждой такой проблемы есть кнопка «Создать перекрёсток».', '')
for (const b of bad.slice(0, 40)) {
  const p = doc.ways.get(b.a)!, q = doc.ways.get(b.b)!
  lines.push(`- ${nm(p)} (${link(p)}) × ${nm(q)} (${link(q)}) · место пересечения ${at(b)}`)
}
if (!bad.length) lines.push('Таких пересечений нет.')
lines.push('')

// 6. Односторонние дороги: сколько и какие длинные
const ow = cars.filter((w) => onewayDirection(w) !== 0 && w.tags.highway !== 'motorway')
lines.push(`## 6. Односторонние дороги (${ow.length})`, '', 'Часто путают направление. Проверьте самые значимые (primary/secondary/tertiary):', '')
for (const w of ow.filter((x) => ['primary', 'secondary', 'tertiary'].includes(x.tags.highway)).slice(0, 25)) lines.push(`- ${nm(w)} · ${link(w)} · ${w.tags.oneway ?? 'по умолчанию'} · ${at(mid(w))}`)

writeFileSync(outFile, lines.join('\n') + '\n')
console.log(`Записано: ${outFile} (разделов 6; пересечений без узла: ${bad.length}; недостижимых групп внутри: ${r.groups.filter((g) => !g.border).length})`)
