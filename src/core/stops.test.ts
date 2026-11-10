import { describe, expect, it } from 'vitest'
import { emptyDocument } from './types'
import { Store } from './store'
import { deleteNode, moveNode, placeBusStop } from './ops'
import { parseOsm } from './parse'
import { serializeOsm } from './serialize'
import { stopsAt } from './stops'

function road() {
  const doc = emptyDocument()
  doc.nodes.set(1, { id: 1, lat: 52, lon: 104, tags: { highway: 'traffic_signals' }, meta: {} })
  doc.nodes.set(2, { id: 2, lat: 52.001, lon: 104, tags: {}, meta: {} })
  doc.ways.set(10, { id: 10, nodes: [1, 2], tags: { highway: 'residential' }, meta: {} })
  const store = new Store()
  store.load(doc, 'road.osm')
  return store
}
const platform = { lat: 52, lon: 104.0001 }

describe('Автобусная остановка', () => {
  it('привязывает три объекта к дорожному узлу одним действием', () => {
    const store = road()
    placeBusStop(store, { kind: 'node', id: 1 }, platform)
    const [stop] = stopsAt(store.doc, 1)
    expect(stop.anchor).toBe(1)
    expect(store.doc.nodes.get(1)?.tags.highway).toBe('traffic_signals')
    expect(store.doc.nodes.get(stop.platform)?.tags.highway).toBe('bus_stop')
    expect(store.doc.relations.get(stop.area)?.tags.public_transport).toBe('stop_area')
    expect(() => placeBusStop(store, { kind: 'node', id: 1 }, platform)).toThrow()
    store.undo()
    expect(store.doc.nodes.size).toBe(2)
    expect(store.doc.relations.size).toBe(0)
    store.redo()
    expect(stopsAt(store.doc, stop.platform)).toEqual([stop])
    moveNode(store, 1, 52.002, 104)
    expect(store.doc.nodes.get(stop.platform)?.lat).toBeCloseTo(52.002, 8)
    deleteNode(store, 1)
    expect(store.doc.nodes.has(stop.platform)).toBe(false)
    expect(store.doc.relations.size).toBe(0)
    store.undo()
    expect(stopsAt(store.doc, 1)).toEqual([stop])
  })
  it('сохраняет привязку при экспорте только дорог и выделяет новые номера после загрузки', () => {
    const store = road()
    const anchor = placeBusStop(store, { kind: 'way', wayId: 10, lat: 52.0005, lon: 104 }, platform)
    const [first] = stopsAt(store.doc, anchor)
    expect(store.doc.ways.get(10)?.nodes).toEqual([1, anchor, 2])
    store.load(parseOsm(serializeOsm(store.doc, { onlyRoads: true, keepMeta: false })), 'edited.osm')
    expect(stopsAt(store.doc, anchor)).toEqual([first])
    expect(store.doc.nodes.has(first.platform)).toBe(true)
    placeBusStop(store, { kind: 'node', id: 2 }, platform)
    expect(store.doc.relations.size).toBe(2)
    expect(stopsAt(store.doc, anchor)).toEqual([first])
  })
})
