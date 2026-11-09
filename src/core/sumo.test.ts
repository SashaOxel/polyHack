import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildGraph } from './graph'
import { drawRoad, moveNode, placeRoadFeature, reverseWay, setElevationRamp } from './ops'
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
    // SUMO называет рёбра по id дороги; новая дорога имеет отрицательный id
    expect(readFileSync(join(dir, 'out.net.xml'), 'utf8')).toContain(`id="${id}`)
  }, 60000)
})
