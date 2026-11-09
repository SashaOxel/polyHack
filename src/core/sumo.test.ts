import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { moveNode, reverseWay } from './ops'
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
})
