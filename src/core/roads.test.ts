import { describe, expect, it } from 'vitest'
import { laneInfo, speedLimit, wayMidpoint } from './roads'
import { emptyDocument, type OsmWay, type Tags } from './types'

const way = (tags: Tags): OsmWay => ({ id: 1, nodes: [], tags: { highway: 'residential', ...tags }, meta: {} })

describe('speedLimit', () => {
  it('число из maxspeed', () => {
    expect(speedLimit(way({ maxspeed: '60' }))).toMatchObject({ kmh: 60, source: 'tag' })
    expect(speedLimit(way({ maxspeed: '40 km/h' }))).toMatchObject({ kmh: 40, source: 'tag' })
  })

  it('мили в км/ч', () => {
    expect(speedLimit(way({ maxspeed: '30 mph' }))).toMatchObject({ kmh: 48, source: 'tag' })
  })

  it('зоны OSM: RU:urban = 60', () => {
    expect(speedLimit(way({ maxspeed: 'RU:urban' }))).toMatchObject({ kmh: 60, source: 'zone', raw: 'RU:urban' })
    expect(speedLimit(way({ maxspeed: 'RU:rural' })).kmh).toBe(90)
    expect(speedLimit(way({ maxspeed: 'XX:unknown' })).source).toBe('default') // непонятное значение — как будто не задано
  })

  it('none = без ограничения', () => {
    expect(speedLimit(way({ maxspeed: 'none' }))).toMatchObject({ kmh: null, source: 'tag', raw: 'none' })
  })

  it('не задано — скорость по классу, как у SUMO', () => {
    expect(speedLimit(way({}))).toMatchObject({ kmh: 50, source: 'default' })
    expect(speedLimit(way({ highway: 'primary' })).kmh).toBe(100)
    expect(speedLimit(way({ highway: 'service' })).kmh).toBe(20)
    expect(speedLimit(way({ highway: 'unknown_class' })).kmh).toBeNull()
  })

  it('maxspeed:forward / backward', () => {
    const s = speedLimit(way({ 'maxspeed:forward': '50', 'maxspeed:backward': '30' }))
    expect(s).toMatchObject({ kmh: 50, source: 'tag', forward: 50, backward: 30 })
    expect(speedLimit(way({ maxspeed: '60', 'maxspeed:backward': '40' }))).toMatchObject({ kmh: 60, backward: 40 })
  })
})

describe('wayMidpoint', () => {
  it('середина по длине, а не по числу узлов', () => {
    const doc = emptyDocument()
    // три узла на восток: расстояния 1 и 3 единицы, середина по длине лежит во втором отрезке
    const lons = [104, 104.001, 104.004]
    lons.forEach((lon, i) => doc.nodes.set(i + 1, { id: i + 1, lat: 52, lon, tags: {}, meta: {} }))
    const w: OsmWay = { id: 1, nodes: [1, 2, 3], tags: { highway: 'residential' }, meta: {} }
    const m = wayMidpoint(doc, w)!
    expect(m.lon).toBeCloseTo(104.002, 5)
  })

  it('пустая дорога — null', () => {
    expect(wayMidpoint(emptyDocument(), { id: 1, nodes: [], tags: {}, meta: {} })).toBeNull()
  })
})

describe('laneInfo', () => {
  it('3 полосы и 2 полосы по тегу lanes', () => {
    expect(laneInfo(way({ lanes: '3' }))).toMatchObject({ total: 3, twoWay: true, explicit: true, centerAfter: null })
    expect(laneInfo(way({ lanes: '2' }))).toMatchObject({ total: 2, twoWay: true, centerAfter: 1 })
    expect(laneInfo(way({ lanes: '4' }))?.centerAfter).toBe(2)
  })

  it('односторонняя: полосы есть, встречной линии нет', () => {
    expect(laneInfo(way({ lanes: '3', oneway: 'yes' }))).toMatchObject({ total: 3, twoWay: false, centerAfter: null })
    expect(laneInfo(way({ junction: 'roundabout', lanes: '2' }))?.centerAfter).toBeNull()
  })

  it('lanes:forward / backward определяют место встречной линии (правостороннее движение)', () => {
    // 3 полосы: 2 попутные справа, 1 встречная слева → линия после 1-й полосы слева
    expect(laneInfo(way({ lanes: '3', 'lanes:forward': '2', 'lanes:backward': '1' }))?.centerAfter).toBe(1)
    expect(laneInfo(way({ lanes: '3', 'lanes:forward': '1' }))?.centerAfter).toBe(2)
    expect(laneInfo(way({ 'lanes:forward': '2', 'lanes:backward': '2' }))).toMatchObject({ total: 4, centerAfter: 2, explicit: true })
  })

  it('без тегов: двусторонняя = 2 полосы, односторонняя и служебная = 1', () => {
    expect(laneInfo(way({}))).toMatchObject({ total: 2, explicit: false, centerAfter: 1 })
    expect(laneInfo(way({ oneway: 'yes' }))?.total).toBe(1)
    expect(laneInfo(way({ highway: 'service' }))?.total).toBe(1)
  })

  it('не автомобильные дороги — null, мусор в lanes игнорируется', () => {
    expect(laneInfo(way({ highway: 'footway' }))).toBeNull()
    expect(laneInfo(way({ lanes: 'abc' }))?.total).toBe(2)
    expect(laneInfo(way({ lanes: '40' }))?.total).toBe(10)
  })
})
