import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { wayElevations } from './elevation'
import { drawArea, drawRoad, setWayLevel } from './ops'
import { parseOsm } from './parse'
import { isParkingArea, wayKindLabel, wayLevel } from './roads'
import { serializeOsm } from './serialize'
import { Store } from './store'
import { DRAW_TEMPLATES, LEVEL_TAGS } from './templates'
import { emptyDocument } from './types'

const way = (tags: Record<string, string>) => ({ id: 1, nodes: [], meta: {}, tags })

describe('мосты и тоннели', () => {
  it('уровень дороги: проход сквозь здание — на земле', () => {
    expect(wayLevel(way({ highway: 'footway', bridge: 'yes' }))).toBe('bridge')
    expect(wayLevel(way({ highway: 'primary', bridge: 'viaduct' }))).toBe('bridge')
    expect(wayLevel(way({ highway: 'footway', tunnel: 'yes' }))).toBe('tunnel')
    expect(wayLevel(way({ highway: 'footway', tunnel: 'building_passage' }))).toBe('ground')
    expect(wayLevel(way({ highway: 'footway', bridge: 'no' }))).toBe('ground')
  })

  it('проход сквозь здание не уходит под землю в 3D', () => {
    const doc = emptyDocument()
    for (let i = 0; i < 3; i++) doc.nodes.set(i, { id: i, lat: 52, lon: 104 + i * 0.001, tags: {}, meta: {} })
    doc.ways.set(1, { id: 1, nodes: [0, 1, 2], tags: { highway: 'footway', tunnel: 'building_passage' }, meta: {} })
    expect(wayElevations(doc, doc.ways.get(1)!)).toEqual([0, 0, 0])
    doc.ways.get(1)!.tags.tunnel = 'yes'
    expect(wayElevations(doc, doc.ways.get(1)!)[1]).toBeLessThan(0)
  })

  it('надземный и подземный переходы — шаблоны с правильными тегами и названиями', () => {
    const over = DRAW_TEMPLATES.find((t) => t.name === 'Надземный переход')!
    const under = DRAW_TEMPLATES.find((t) => t.name === 'Подземный переход')!
    expect(over.tags).toEqual({ highway: 'footway', bridge: 'yes', layer: '1' })
    expect(under.tags).toEqual({ highway: 'footway', tunnel: 'yes', layer: '-1' })
    expect(wayKindLabel(way(over.tags))).toBe('Надземный переход')
    expect(wayKindLabel(way(under.tags))).toBe('Подземный переход')
  })

  it('любую дорогу можно сделать мостом, тоннелем и вернуть на землю', () => {
    const s = new Store()
    s.load(emptyDocument(), 'x.osm')
    const id = drawRoad(s, [{ kind: 'new', lat: 52, lon: 104 }, { kind: 'new', lat: 52, lon: 104.001 }], { highway: 'residential', ...LEVEL_TAGS.bridge })
    expect(s.doc.ways.get(id)!.tags).toMatchObject({ bridge: 'yes', layer: '1' })
    setWayLevel(s, id, 'tunnel')
    expect(s.doc.ways.get(id)!.tags).toEqual({ highway: 'residential', tunnel: 'yes', layer: '-1' })
    setWayLevel(s, id, 'bridge', 2)
    expect(s.doc.ways.get(id)!.tags).toEqual({ highway: 'residential', bridge: 'yes', layer: '2' })
    setWayLevel(s, id, 'ground')
    expect(s.doc.ways.get(id)!.tags).toEqual({ highway: 'residential' })
    s.undo()
    expect(s.doc.ways.get(id)!.tags.layer).toBe('2')
  })
})

describe('парковки', () => {
  it('рисуется замкнутым контуром и попадает в экспорт «только дороги»', () => {
    const s = new Store()
    s.load(emptyDocument(), 'p.osm')
    const id = drawArea(s, [{ lat: 52, lon: 104 }, { lat: 52.0005, lon: 104 }, { lat: 52.0005, lon: 104.001 }, { lat: 52, lon: 104.001 }],
      { amenity: 'parking', parking: 'surface', capacity: '40' })
    const w = s.doc.ways.get(id)!
    expect(w.nodes).toHaveLength(5)
    expect(w.nodes[0]).toBe(w.nodes[4])
    expect(isParkingArea(w)).toBe(true)
    expect(wayKindLabel(w)).toBe('Парковка')
    const back = parseOsm(serializeOsm(s.doc, { onlyRoads: true }))
    expect(back.ways.get(id)?.tags).toMatchObject({ amenity: 'parking', parking: 'surface', capacity: '40' })
    expect(() => drawArea(s, [{ lat: 52, lon: 104 }, { lat: 52.1, lon: 104 }], { amenity: 'parking' })).toThrow(/три точки/)
    s.undo()
    expect(s.doc.ways.has(id)).toBe(false)
  })

  it('парковки из файла сохраняются при экспорте', () => {
    const doc = parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8'))
    const parkings = [...doc.ways.values()].filter(isParkingArea).length
    expect(parkings).toBeGreaterThan(10)
    const back = parseOsm(serializeOsm(doc, { onlyRoads: true }))
    expect([...back.ways.values()].filter(isParkingArea).length).toBe(parkings)
  })
})
