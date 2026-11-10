// Экспорт для SUMO: сеть + программы светофоров по планам из редактора.
//   npm run export:sumo -- <файл.osm> [папка-результата]
// В папке появятся: map.osm, map.net.xml, signals.add.xml, simulation.sumocfg (запуск: sumo-gui -c simulation.sumocfg)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseOsm } from '../src/core/parse'
import { serializeOsm } from '../src/core/serialize'
import { buildSumoSignals } from '../src/core/sumoSignals'
import { buildSumoPriorities, edgePatchXml, nodePatchXml } from '../src/core/sumoPriority'

const [input, outArg] = process.argv.slice(2)
if (!input) { console.error('Использование: npm run export:sumo -- <файл.osm> [папка]'); process.exit(2) }
const out = resolve(outArg ?? 'out/sumo')
mkdirSync(out, { recursive: true })

const sumoBin = [process.env.SUMO_HOME && join(process.env.SUMO_HOME, 'bin'), join(homedir(), 'sumo-venv/lib/python3.9/site-packages/sumo/bin')]
  .filter(Boolean).find((d) => existsSync(join(d!, 'netconvert')))
if (!sumoBin) { console.error('netconvert не найден: pip install eclipse-sumo или задайте SUMO_HOME'); process.exit(2) }

const doc = parseOsm(readFileSync(input, 'utf8'))
writeFileSync(join(out, 'map.osm'), serializeOsm(doc, { onlyRoads: true, keepMeta: false }))
execFileSync(join(sumoBin, 'netconvert'), ['--osm-files', join(out, 'map.osm'), '-o', join(out, 'map.net.xml')], { stdio: 'pipe' })

// знаки приоритета (главная / уступи / стоп): netconvert их из OSM не читает — правим готовую сеть
const netconvert = (args: string[]) => execFileSync(join(sumoBin, 'netconvert'), args, { stdio: 'pipe' })
const prio = buildSumoPriorities(doc, readFileSync(join(out, 'map.net.xml'), 'utf8'))
if (prio.edges.length) {
  writeFileSync(join(out, 'priority.edg.xml'), edgePatchXml(prio.edges))
  netconvert(['-s', join(out, 'map.net.xml'), '-e', join(out, 'priority.edg.xml'), '-o', join(out, 'map.net.xml')])
}
if (prio.nodes.length) {
  writeFileSync(join(out, 'stops.nod.xml'), nodePatchXml(prio.nodes))
  netconvert(['-s', join(out, 'map.net.xml'), '-n', join(out, 'stops.nod.xml'), '-o', join(out, 'map.net.xml')])
}

const { programs, xml, warnings } = buildSumoSignals(doc, readFileSync(join(out, 'map.net.xml'), 'utf8'))
writeFileSync(join(out, 'signals.add.xml'), xml)
writeFileSync(join(out, 'simulation.sumocfg'), `<configuration>
  <input>
    <net-file value="map.net.xml"/>
    <additional-files value="signals.add.xml"/>
  </input>
</configuration>
`)
console.log(`Готово: ${out}`)
console.log(`Светофоров с планом: ${programs.length}; знаков приоритета учтено: ${prio.edges.length}, стоп-перекрёстков: ${prio.nodes.length}`)
for (const w of prio.warnings) console.log('  ! ' + w)
for (const p of programs) console.log(`  узел ${p.node} → светофор SUMO «${p.tlId}»: ${p.phases.length} фаз, цикл ${p.phases.reduce((a, x) => a + x.duration, 0)} с, сдвиг ${p.offset} с`)
for (const w of warnings) console.log('  ! ' + w)
