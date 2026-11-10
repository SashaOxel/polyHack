import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildGraph } from './graph'
import { defaultPlan, turnsAt } from './signals'
import { buildSumoSignals } from './sumoSignals'
import { resolveStop } from './routes'
import { validate } from '../validate'
import { applyFix } from '../validate/fixes'
import { setSignalPlan } from './ops'
import { drawRoad, moveNode, placeRoadFeature, reverseWay, saveRoute, setElevationRamp } from './ops'
import { parseOsm } from './parse'
import { isDrivable } from './roads'
import { serializeOsm } from './serialize'
import { Store } from './store'

/** Ищем netconvert: SUMO_HOME, pip-окружение ~/sumo-venv. Нет SUMO — тест пропускается. */
const candidates = [
  process.env.SUMO_HOME && join(process.env.SUMO_HOME, 'bin/netconvert'),
  join(homedir(), 'sumo-venv/lib/python3.9/site-packages/sumo/bin/netconvert'),
].filter(Boolean) as string[]
const netconvert = candidates.find((c) => existsSync(c))

describe.skipIf(!netconvert)('сохранённый файл проходит через SUMO netconvert', () => {
  it('после правок и экспорта «только дороги»', () => {
    const s = new Store()
    s.load(parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8')), 'example.osm')
    const w = [...s.doc.ways.values()].find((x) => isDrivable(x) && x.nodes.length > 3)!
    reverseWay(s, w.id)
    const n = s.doc.nodes.get(w.nodes[1])!
    moveNode(s, n.id, n.lat + 0.00002, n.lon)

    const dir = mkdtempSync(join(tmpdir(), 'uds-'))
    const osm = join(dir, 'edited.osm')
    writeFileSync(osm, serializeOsm(s.doc, { onlyRoads: true, keepMeta: false }))
    execFileSync(netconvert!, ['--osm-files', osm, '-o', join(dir, 'out.net.xml')], { stdio: 'pipe' })

    const net = readFileSync(join(dir, 'out.net.xml'), 'utf8')
    expect(net).toContain('<edge ')
  }, 60000)

  it('поставленный светофор становится светофорным перекрёстком в сети SUMO', () => {
    const load = () => {
      const s = new Store()
      s.load(parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8')), 'example.osm')
      return s
    }
    const tls = (s: Store) => {
      const dir = mkdtempSync(join(tmpdir(), 'uds-tls-'))
      const osm = join(dir, 't.osm')
      writeFileSync(osm, serializeOsm(s.doc, { onlyRoads: true, keepMeta: false }))
      execFileSync(netconvert!, ['--osm-files', osm, '-o', join(dir, 'out.net.xml')], { stdio: 'pipe' })
      return (readFileSync(join(dir, 'out.net.xml'), 'utf8').match(/type="traffic_light"/g) ?? []).length
    }
    const s = load()
    const baseline = tls(s)
    // перекрёсток без светофора, где сходятся минимум три двусторонние дороги
    const g = buildGraph(s.doc)
    const junction = [...g.nodes.values()].find((n) => n.in.length >= 3 && n.out.length >= 3 && s.doc.nodes.get(n.id)!.tags.highway === undefined)!
    placeRoadFeature(s, { kind: 'node', id: junction.id }, 'signal')
    expect(tls(s)).toBeGreaterThan(baseline)
  }, 120000)

  it('нарисованные пешеходные дорожки и переход проходят через SUMO', () => {
    const s = new Store()
    s.load(parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8')), 'example.osm')
    const road = [...s.doc.ways.values()].find((x) => isDrivable(x) && x.nodes.length > 3 && x.tags.highway === 'residential')!
    const a = s.doc.nodes.get(road.nodes[1])!, b = s.doc.nodes.get(road.nodes[2])!
    const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }
    // дорожка от проезжей части в сторону и дорожка-«зебра» через неё
    const walk = drawRoad(s, [{ kind: 'way', wayId: road.id, ...mid }, { kind: 'new', lat: mid.lat + 0.0004, lon: mid.lon }], { highway: 'footway' })
    const zebra = drawRoad(s, [
      { kind: 'new', lat: mid.lat + 0.00005, lon: mid.lon - 0.00004 },
      { kind: 'way', wayId: road.id, ...mid },
      { kind: 'new', lat: mid.lat - 0.00005, lon: mid.lon + 0.00004 },
    ], { highway: 'footway', footway: 'crossing' })

    const dir = mkdtempSync(join(tmpdir(), 'uds-foot-'))
    const osm = join(dir, 'foot.osm')
    writeFileSync(osm, serializeOsm(s.doc, { onlyRoads: true, includePedestrian: true, keepMeta: false }))
    expect(readFileSync(osm, 'utf8')).toContain(`<way id="${walk}"`)
    expect(readFileSync(osm, 'utf8')).toContain(`<way id="${zebra}"`)
    execFileSync(netconvert!, ['--osm-files', osm, '-o', join(dir, 'out.net.xml')], { stdio: 'pipe' })
    expect(readFileSync(join(dir, 'out.net.xml'), 'utf8')).toContain('<edge ')
  }, 120000)

  it('трамвайные пути (из файла и нарисованные) попадают в сеть SUMO', () => {
    const s = new Store()
    s.load(parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8')), 'example.osm')
    const id = drawRoad(s, [{ kind: 'new', lat: 52.262, lon: 104.259 }, { kind: 'new', lat: 52.263, lon: 104.259 }, { kind: 'new', lat: 52.264, lon: 104.2595 }],
      { railway: 'tram', gauge: '1524', electrified: 'contact_line' })
    const dir = mkdtempSync(join(tmpdir(), 'uds-tram-'))
    const osm = join(dir, 'tram.osm')
    writeFileSync(osm, serializeOsm(s.doc, { onlyRoads: true, keepMeta: false }))
    execFileSync(netconvert!, ['--osm-files', osm, '-o', join(dir, 'out.net.xml')], { stdio: 'pipe' })
    const net = readFileSync(join(dir, 'out.net.xml'), 'utf8')
    expect(net).toContain('railway.tram')
    expect(net).toContain(`id="${id}`)
  }, 120000)

  it('план светофора превращается в программу SUMO, и SUMO её запускает', () => {
    const s = new Store()
    s.load(parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8')), 'example.osm')
    const g = buildGraph(s.doc)
    const junction = [...g.nodes.values()].find((n) => n.in.length >= 3 && n.out.length >= 3 && s.doc.nodes.get(n.id)!.tags.highway === undefined)!
    placeRoadFeature(s, { kind: 'node', id: junction.id }, 'signal')
    const plan = { ...defaultPlan(s.doc, junction.id, 70), offset: 11 }
    setSignalPlan(s, junction.id, plan)

    const dir = mkdtempSync(join(tmpdir(), 'uds-sig-'))
    const osm = join(dir, 'map.osm'), net = join(dir, 'map.net.xml'), add = join(dir, 'signals.add.xml')
    writeFileSync(osm, serializeOsm(s.doc, { onlyRoads: true, keepMeta: false }))
    execFileSync(netconvert!, ['--osm-files', osm, '-o', net], { stdio: 'pipe' })
    const { programs, xml, warnings } = buildSumoSignals(s.doc, readFileSync(net, 'utf8'))
    expect(programs).toHaveLength(1)
    const p = programs[0]
    expect(p.unmatched).toBe(0) // каждое соединение SUMO нашло своё направление в плане
    expect(warnings).toEqual([])
    expect(p.offset).toBe(11)
    expect(p.phases.reduce((a, x) => a + x.duration, 0)).toBeCloseTo(70, 6) // фазы покрывают ровно цикл
    expect(p.phases.some((x) => x.state.includes('y'))).toBe(true)
    expect(p.phases.every((x) => x.state.length === p.links)).toBe(true)
    // все направления плана реально присутствуют в соединениях: число сигналов не меньше числа направлений
    expect(p.links).toBeGreaterThanOrEqual(turnsAt(s.doc, junction.id).length)
    writeFileSync(add, xml)
    // SUMO загружает сеть с нашей программой и проигрывает 2 цикла без ошибок
    const sumo = join(netconvert!, '..', 'sumo')
    execFileSync(sumo, ['-n', net, '-a', add, '--end', '140', '--no-step-log', '--error-log', join(dir, 'err.log')], { stdio: 'pipe' })
    expect(readFileSync(join(dir, 'err.log'), 'utf8').trim()).toBe('')
  }, 120000)

  it('маршрут автобуса попадает в линии общественного транспорта SUMO', () => {
    const s = new Store()
    s.load(parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8')), 'example.osm')
    // привязываем остановки из файла к ближайшим узлам дорог (автоисправление проверки)
    for (const i of validate(s.doc).filter((x) => x.code === 'unlinked-stop' && x.fix)) applyFix(s, i.fix!)
    const linked = [...s.doc.relations.values()].filter((r) => r.tags['polyhack:linked'] === 'yes')
      .map((r) => resolveStop(s.doc, r.members[0].ref, 'bus')!)
    // ищем пару остановок, между которыми есть путь
    let id: number | undefined
    for (let i = 0; i < linked.length && id === undefined; i++) for (let j = 0; j < linked.length && id === undefined; j++) {
      if (i === j) continue
      try { id = saveRoute(s, { kind: 'bus', ref: '80', stops: [linked[i], linked[j]] }) } catch { /* нет пути — следующая пара */ }
    }
    expect(id).toBeDefined()
    const dir = mkdtempSync(join(tmpdir(), 'uds-pt-'))
    const osm = join(dir, 'pt.osm')
    writeFileSync(osm, serializeOsm(s.doc, { onlyRoads: true, keepMeta: false }))
    execFileSync(netconvert!, ['--osm-files', osm, '-o', join(dir, 'n.xml'), '--ptstop-output', join(dir, 'stops.xml'), '--ptline-output', join(dir, 'lines.xml')], { stdio: 'pipe' })
    const lines = readFileSync(join(dir, 'lines.xml'), 'utf8')
    expect(lines).toMatch(/<ptLine [^>]*line="80"/)
    expect(lines).toContain('type="bus"')
  }, 120000)

  it('файл с высотами (тег ele) проходит через SUMO', () => {
    const s = new Store()
    s.load(parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8')), 'example.osm')
    const w = [...s.doc.ways.values()].find((x) => isDrivable(x) && x.nodes.length > 4)!
    setElevationRamp(s, w.id, 100, 112)
    const dir = mkdtempSync(join(tmpdir(), 'uds-ele-'))
    const osm = join(dir, 'ele.osm')
    writeFileSync(osm, serializeOsm(s.doc, { onlyRoads: true, keepMeta: false }))
    expect(readFileSync(osm, 'utf8')).toContain('k="ele"')
    execFileSync(netconvert!, ['--osm-files', osm, '-o', join(dir, 'out.net.xml')], { stdio: 'pipe' })
    expect(readFileSync(join(dir, 'out.net.xml'), 'utf8')).toContain('<edge ')
  }, 60000)

  it('нарисованная дорога с перекрёстком попадает в сеть SUMO', () => {
    const s = new Store()
    s.load(parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8')), 'example.osm')
    const target = [...s.doc.ways.values()].find((x) => isDrivable(x) && x.tags.highway === 'secondary' && x.nodes.length > 3)!
    const a = s.doc.nodes.get(target.nodes[1])!
    const b = s.doc.nodes.get(target.nodes[2])!
    const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }
    // новая дорога от середины существующей уходит в пустое место и там заканчивается
    const id = drawRoad(s, [
      { kind: 'way', wayId: target.id, ...mid },
      { kind: 'new', lat: mid.lat + 0.0006, lon: mid.lon + 0.0006 },
    ], { highway: 'residential', lanes: '2', maxspeed: '40' })

    const dir = mkdtempSync(join(tmpdir(), 'uds-draw-'))
    const osm = join(dir, 'drawn.osm')
    writeFileSync(osm, serializeOsm(s.doc, { onlyRoads: true, keepMeta: false }))
    execFileSync(netconvert!, ['--osm-files', osm, '-o', join(dir, 'out.net.xml')], { stdio: 'pipe' })
    // SUMO называет рёбра по id дороги.
    expect(readFileSync(join(dir, 'out.net.xml'), 'utf8')).toContain(`id="${id}`)
  }, 60000)
})
