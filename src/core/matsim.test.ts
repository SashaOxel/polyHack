import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findPt2matsim, runMatsim, utmEpsg } from './matsim'
import { drawArea, drawRoad, placeRoadFeature } from './ops'
import { parseOsm } from './parse'
import { serializeOsm } from './serialize'
import { Store } from './store'

describe('система координат для MATSim', () => {
  it('UTM-зона по долготе: Иркутск — 48N, Москва — 37N, Буэнос-Айрес — 21S', () => {
    expect(utmEpsg('<node lat="52.26" lon="104.26"/>')).toBe('EPSG:32648')
    expect(utmEpsg('<node lat="55.75" lon="37.62"/>')).toBe('EPSG:32637')
    expect(utmEpsg('<node lat="-34.6" lon="-58.4"/>')).toBe('EPSG:32721')
  })
})

const jar = findPt2matsim()

describe.skipIf(!jar)('файл из редактора открывается в MATSim (pt2matsim)', () => {
  it('после правок: новая дорога, светофор, парковка', async () => {
    const s = new Store()
    s.load(parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8')), 'example.osm')
    const road = drawRoad(s, [{ kind: 'new', lat: 52.262, lon: 104.259 }, { kind: 'new', lat: 52.263, lon: 104.2595 }], { highway: 'residential', lanes: '2', maxspeed: '40' })
    placeRoadFeature(s, { kind: 'node', id: s.doc.ways.get(road)!.nodes[0] }, 'signal')
    drawArea(s, [{ lat: 52.2601, lon: 104.26 }, { lat: 52.2603, lon: 104.26 }, { lat: 52.2603, lon: 104.2604 }], { amenity: 'parking' })

    const dir = mkdtempSync(join(tmpdir(), 'uds-matsim-'))
    const osm = join(dir, 'map.osm')
    writeFileSync(osm, serializeOsm(s.doc, { onlyRoads: true, keepMeta: false }))
    const r = runMatsim(osm, join(dir, 'out'), jar)
    expect(r.epsg).toBe('EPSG:32648')
    expect(r.links).toBeGreaterThan(2000)
    expect(r.nodes).toBeGreaterThan(1000)
  }, 180000)
})
