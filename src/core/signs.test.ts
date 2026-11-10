import { describe, expect, it } from 'vitest'
import { placeSign } from './ops'
import { readSign } from './signs'
import { Store } from './store'
import type { OsmDocument } from './types'

// Т-образный перекрёсток: главная улица 1—2—3 по оси X, второстепенная 4—2 снизу.
function tDoc(): OsmDocument {
  const nodes = new Map([
    [1, { id: 1, lat: 55, lon: 37.000, tags: {}, meta: {} }],
    [2, { id: 2, lat: 55, lon: 37.002, tags: {}, meta: {} }],
    [3, { id: 3, lat: 55, lon: 37.004, tags: {}, meta: {} }],
    [4, { id: 4, lat: 54.998, lon: 37.002, tags: {}, meta: {} }],
  ])
  const ways = new Map([
    [10, { id: 10, nodes: [1, 2, 3], tags: { highway: 'primary' }, meta: {} }],
    [11, { id: 11, nodes: [4, 2], tags: { highway: 'residential' }, meta: {} }],
    [12, { id: 12, nodes: [3, 5], tags: { highway: 'residential', oneway: 'yes' }, meta: {} }],
  ])
  nodes.set(5, { id: 5, lat: 55, lon: 37.006, tags: {}, meta: {} })
  return { nodes, ways, relations: new Map(), meta: {} } as unknown as OsmDocument
}

describe('знаки приоритета', () => {
  it('«Уступи дорогу» на второстепенной у перекрёстка — highway=give_way, направление к перекрёстку', () => {
    const store = new Store(); store.load(tDoc(), 't.osm')
    const id = placeSign(store, { kind: 'way', wayId: 11, lat: 54.9985, lon: 37.002 }, 'giveway')
    const t = store.doc.nodes.get(id)!.tags
    expect(t).toMatchObject({ highway: 'give_way', traffic_sign: 'RU:2.4', direction: 'forward' }) // 4→2: к перекрёстку по ходу узлов
    expect(store.doc.ways.get(11)!.nodes).toEqual([4, id, 2])
    expect(readSign(t)).toEqual({ kind: 'giveway', direction: 'forward' })
  })
  it('знак по другую сторону перекрёстка смотрит на него с обратным направлением', () => {
    const store = new Store(); store.load(tDoc(), 't.osm')
    const id = placeSign(store, { kind: 'way', wayId: 10, lat: 55, lon: 37.0025 }, 'stop')
    expect(store.doc.nodes.get(id)!.tags).toMatchObject({ highway: 'stop', direction: 'backward' }) // от 3 к 2 — против порядка
  })
  it('главная дорога — только traffic_sign=RU:2.1, без highway', () => {
    const store = new Store(); store.load(tDoc(), 't.osm')
    const id = placeSign(store, { kind: 'way', wayId: 10, lat: 55, lon: 37.0007 }, 'priority')
    const t = store.doc.nodes.get(id)!.tags
    expect(t.traffic_sign).toBe('RU:2.1'); expect(t.highway).toBeUndefined(); expect(t.direction).toBe('forward')
  })
  it('на односторонней дороге направление не пишем; на перекрёстке и поверх светофора — отказ', () => {
    const store = new Store(); store.load(tDoc(), 't.osm')
    const id = placeSign(store, { kind: 'way', wayId: 12, lat: 55, lon: 37.005 }, 'giveway')
    expect(store.doc.nodes.get(id)!.tags.direction).toBeUndefined()
    expect(() => placeSign(store, { kind: 'node', id: 2 }, 'giveway')).toThrow(/перекрёсток/)
    store.commit('светофор', (tx) => tx.setNode({ ...store.doc.nodes.get(1)!, tags: { highway: 'traffic_signals' } }))
    expect(() => placeSign(store, { kind: 'node', id: 1 }, 'stop')).toThrow(/светофор/)
  })
  it('отмена возвращает дорогу как была', () => {
    const store = new Store(); store.load(tDoc(), 't.osm')
    placeSign(store, { kind: 'way', wayId: 11, lat: 54.9985, lon: 37.002 }, 'giveway')
    store.undo()
    expect(store.doc.ways.get(11)!.nodes).toEqual([4, 2])
  })
})
