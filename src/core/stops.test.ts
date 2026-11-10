import { describe, expect, it } from 'vitest'
import { emptyDocument } from './types'
import { Store } from './store'
import { deleteNode, linkStopToNode, moveNode, placeBusStop } from './ops'
import { validate } from '../validate'
import { applyFix } from '../validate/fixes'
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
    // клик по отрезку ближе к узлу 2: остановка привязывается к нему, новый узел в дорогу не вставляется
    const anchor = placeBusStop(store, { kind: 'way', wayId: 10, lat: 52.0008, lon: 104 }, platform)
    const [first] = stopsAt(store.doc, anchor)
    expect(anchor).toBe(2)
    expect(store.doc.ways.get(10)?.nodes).toEqual([1, 2])
    store.load(parseOsm(serializeOsm(store.doc, { onlyRoads: true, keepMeta: false })), 'edited.osm')
    expect(stopsAt(store.doc, anchor)).toEqual([first])
    expect(store.doc.nodes.has(first.platform)).toBe(true)
    placeBusStop(store, { kind: 'node', id: 1 }, platform)
    expect(store.doc.relations.size).toBe(2)
    expect(stopsAt(store.doc, anchor)).toEqual([first])
  })

  it('не вставляет новый узел в дорогу: берёт ближайший существующий', () => {
    const store = road()
    const nodesBefore = store.doc.nodes.size
    const anchor = placeBusStop(store, { kind: 'way', wayId: 10, lat: 52.0001, lon: 104 }, platform)
    expect(anchor).toBe(1)
    expect(store.doc.ways.get(10)?.nodes).toEqual([1, 2])
    expect(store.doc.nodes.size).toBe(nodesBefore + 1) // +1 только место посадки
  })

  it('привязывает существующую остановку из OSM, не создавая новый узел', () => {
    const store = road()
    store.doc.nodes.set(5, { id: 5, lat: 52.0005, lon: 104.0002, meta: { version: '3' }, tags: { highway: 'bus_stop', name: 'Студгородок' } })
    const nodesBefore = store.doc.nodes.size
    const anchor = placeBusStop(store, { kind: 'node', id: 2 }, { id: 5 })
    expect(store.doc.nodes.size).toBe(nodesBefore) // ни одного нового узла
    store.undo()
    expect(store.doc.nodes.get(5)?.tags).toEqual({ highway: 'bus_stop', name: 'Студгородок' }) // откат возвращает теги
    store.redo()
    const [stop] = stopsAt(store.doc, anchor)
    expect(stop.platform).toBe(5)
    // своё название и метаданные остановка сохранила, теги дополнены
    expect(store.doc.nodes.get(5)).toMatchObject({ meta: { version: '3' }, tags: { highway: 'bus_stop', name: 'Студгородок', public_transport: 'platform', bus: 'yes' } })
    // в экспорт попадает та же остановка
    expect(serializeOsm(store.doc, { onlyRoads: true })).toContain('<node id="5"')
    // вторую остановку к ней не привязать
    expect(() => placeBusStop(store, { kind: 'node', id: 1 }, { id: 5 })).toThrow(/уже привязана/)
    // удаление опорного узла не удаляет остановку, которая была в файле, — даже после сохранения и загрузки
    store.load(parseOsm(serializeOsm(store.doc)), 'reloaded.osm')
    expect(stopsAt(store.doc, 5)).toHaveLength(1)
    deleteNode(store, 2)
    expect(store.doc.nodes.has(5)).toBe(true)
    expect(stopsAt(store.doc, 5)).toEqual([])
    store.undo()
    expect(stopsAt(store.doc, 5)).toHaveLength(1)
  })

  it('не принимает обычный узел как остановку', () => {
    const store = road()
    expect(() => placeBusStop(store, { kind: 'node', id: 1 }, { id: 2 })).toThrow(/не остановка/)
  })

  it('привязка по номеру узла: непривязанная остановка привязывается, привязанная переносится', () => {
    const store = road()
    store.doc.nodes.set(5, { id: 5, lat: 52.0005, lon: 104.0002, meta: {}, tags: { highway: 'bus_stop' } })
    linkStopToNode(store, 5, 1)
    expect(stopsAt(store.doc, 5)[0].anchor).toBe(1)
    expect(store.doc.nodes.get(1)?.tags.public_transport).toBe('stop_position')
    // перенос на узел 2: связка та же, метка со старого узла снята, светофор на нём остался
    const area = stopsAt(store.doc, 5)[0].area
    linkStopToNode(store, 5, 2)
    expect(stopsAt(store.doc, 5)).toEqual([{ anchor: 2, platform: 5, area }])
    expect(store.doc.nodes.get(1)?.tags).toEqual({ highway: 'traffic_signals' })
    expect(store.doc.nodes.get(2)?.tags).toMatchObject({ public_transport: 'stop_position', bus: 'yes' })
    store.undo()
    expect(stopsAt(store.doc, 5)[0].anchor).toBe(1)
  })

  it('привязка по номеру узла проверяет ввод', () => {
    const store = road()
    store.doc.nodes.set(5, { id: 5, lat: 52.0005, lon: 104.0002, meta: {}, tags: { highway: 'bus_stop' } })
    store.doc.nodes.set(6, { id: 6, lat: 52.0006, lon: 104.0003, meta: {}, tags: { highway: 'bus_stop' } })
    expect(() => linkStopToNode(store, 5, 999)).toThrow(/нет на карте/)
    expect(() => linkStopToNode(store, 5, 6)).toThrow(/не лежит на дороге/)
    expect(() => linkStopToNode(store, 1, 2)).toThrow(/не остановка/)
    linkStopToNode(store, 5, 1)
    expect(() => linkStopToNode(store, 6, 1)).toThrow(/уже привязана/)
  })

  it('проверка находит непривязанные остановки и исправляет их привязкой к ближайшему узлу', () => {
    const store = road()
    store.doc.nodes.set(5, { id: 5, lat: 52.0009, lon: 104.0001, meta: {}, tags: { highway: 'bus_stop', name: 'Центр' } })
    store.doc.nodes.set(7, { id: 7, lat: 52.0009, lon: 104.0001, meta: {}, tags: { railway: 'tram_stop', public_transport: 'platform', tram: 'yes' } })
    const issues = validate(store.doc).filter(i => i.code === 'unlinked-stop')
    expect(issues).toHaveLength(1) // трамвайная платформа не требует привязки к автодороге
    expect(issues[0].message).toContain('Центр')
    expect(issues[0].fix).toEqual({ kind: 'link-stop', platform: 5, anchor: 2 }) // узел 2 ближе
    expect(issues[0].auto).toBe(true)
    applyFix(store, issues[0].fix!)
    expect(validate(store.doc).filter(i => i.code === 'unlinked-stop')).toHaveLength(0)
  })
})
