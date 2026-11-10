import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { drawRoad, insertNodeOnWay, moveNode, placeBusStop, setTags } from './ops'
import { parseOsm } from './parse'
import { serializeOsm } from './serialize'
import { stopsAt } from './stops'
import { Store } from './store'
import { emptyDocument } from './types'

function network() {
  const doc = emptyDocument()
  for (const id of [1, 2, 3, 4, 5]) {
    doc.nodes.set(id, { id, lat: 52 + id * .001, lon: 104, tags: {}, meta: {} })
  }
  doc.ways.set(10, { id: 10, nodes: [1, 2, 3], tags: { highway: 'residential', lanes: '3', oneway: 'yes' }, meta: {} })
  doc.ways.set(20, { id: 20, nodes: [3, 4, 5], tags: { highway: 'residential' }, meta: {} })
  return doc
}

describe('Автоматические отрезки редактора', () => {
  it('разбивает импорт между всеми соседними узлами, сохраняя свойства и исходный документ', () => {
    const original = network()
    const store = new Store({ autoSplitRoads: true })
    store.load(original, 'roads.osm')
    expect([...store.doc.ways.values()].map(w => w.nodes)).toEqual([[1, 2], [3, 4], [2, 3], [4, 5]])
    expect([...store.doc.ways.values()].filter(w => w.tags.oneway === 'yes')).toHaveLength(2)
    expect(original.ways.get(10)?.nodes).toEqual([1, 2, 3])
    const second = [...store.doc.ways.values()].find(w => w.nodes[0] === 2)!
    setTags(store, 'way', second.id, { ...second.tags, maxspeed: '30' })
    expect(store.doc.ways.get(10)?.tags.maxspeed).toBeUndefined()
    store.undo()
    expect(store.doc.ways.get(second.id)?.tags.maxspeed).toBeUndefined()
  })

  it('добавляет узел и два отрезка одним действием отмены', () => {
    const store = new Store({ autoSplitRoads: true })
    store.load(network(), 'roads.osm')
    const count = store.doc.ways.size
    const id = insertNodeOnWay(store, 10, 52.0015, 104)
    expect(store.doc.ways.size).toBe(count + 1)
    expect([...store.doc.ways.values()].filter(w => w.nodes.includes(id))).toHaveLength(2)
    expect([...store.doc.ways.values()].every(w => w.nodes.length === 2)).toBe(true)
    store.undo()
    expect(store.doc.ways.size).toBe(count)
    expect(store.doc.nodes.has(id)).toBe(false)
    store.redo()
    expect(store.doc.nodes.has(id)).toBe(true)
    const before = structuredClone(store.doc)
    expect(() => store.commit('Прерванное действие', tx => {
      tx.deleteWay(10)
      throw new Error('Отмена')
    })).toThrow('Отмена')
    expect(store.doc).toEqual(before)
  })

  it('новая дорога сразу состоит из отдельно редактируемых отрезков', () => {
    const store = new Store({ autoSplitRoads: true })
    store.load(emptyDocument(), 'new.osm')
    drawRoad(store, [
      { kind: 'new', lat: 52, lon: 104 }, { kind: 'new', lat: 52.001, lon: 104 },
      { kind: 'new', lat: 52.002, lon: 104 },
    ], { highway: 'service' })
    expect(store.doc.ways.size).toBe(2)
    expect([...store.doc.ways.values()].every(w => w.nodes.length === 2)).toBe(true)
    store.undo()
    expect(store.doc.ways.size).toBe(0)
    expect(store.doc.nodes.size).toBe(0)
    store.redo()
    expect(store.doc.ways.size).toBe(2)
  })

  it('обновляет from/to запрета поворота и обратный порядок маршрута', () => {
    const doc = network()
    doc.relations.set(30, { id: 30, tags: { type: 'restriction', restriction: 'no_left_turn' }, meta: {}, members: [
      { type: 'way', role: 'from', ref: 10 }, { type: 'node', role: 'via', ref: 3 }, { type: 'way', role: 'to', ref: 20 },
    ] })
    doc.relations.set(40, { id: 40, tags: { type: 'route' }, meta: {}, members: [
      { type: 'way', role: 'backward', ref: 20 }, { type: 'way', role: 'backward', ref: 20 },
    ] })
    const store = new Store({ autoSplitRoads: true })
    store.load(doc, 'restrictions.osm')
    const members = store.doc.relations.get(30)!.members
    const from = store.doc.ways.get(members[0].ref)!
    expect(from.nodes).toEqual([2, 3])
    expect(store.doc.ways.get(members[2].ref)!.nodes).toEqual([3, 4])
    const route = store.doc.relations.get(40)!.members.map(m => store.doc.ways.get(m.ref)!.nodes)
    expect(route).toEqual([[4, 5], [3, 4], [4, 5], [3, 4]])
  })

  it('сохраняет via-way запрет и замкнутые дорожные площади', () => {
    const doc = network()
    doc.ways.set(10, { ...doc.ways.get(10)!, nodes: [1, 2] })
    doc.ways.set(20, { ...doc.ways.get(20)!, nodes: [2, 3, 4] })
    doc.ways.set(50, { id: 50, nodes: [4, 5], tags: { highway: 'service' }, meta: {} })
    doc.ways.set(60, { id: 60, nodes: [1, 2, 3, 1], tags: { highway: 'pedestrian', area: 'yes' }, meta: {} })
    doc.relations.set(30, { id: 30, tags: { type: 'restriction', restriction: 'no_straight_on' }, meta: {}, members: [
      { type: 'way', role: 'from', ref: 10 }, { type: 'way', role: 'via', ref: 20 }, { type: 'way', role: 'to', ref: 50 },
    ] })
    const store = new Store({ autoSplitRoads: true })
    store.load(doc, 'via.osm')
    const via = store.doc.relations.get(30)!.members.filter(m => m.role === 'via')
    expect(via.map(m => store.doc.ways.get(m.ref)!.nodes)).toEqual([[2, 3], [3, 4]])
    expect(store.doc.ways.get(60)!.nodes).toEqual([1, 2, 3, 1])
  })

  it('перемещает остановку свободно, сохраняет номер и привязку при отмене и экспорте', () => {
    const store = new Store({ autoSplitRoads: true })
    store.load(network(), 'stops.osm')
    const anchor = placeBusStop(store, { kind: 'way', wayId: 10, lat: 52.0015, lon: 104 }, { lat: 52.0015, lon: 104.0001 })
    const [stop] = stopsAt(store.doc, anchor)
    const originalAnchor = structuredClone(store.doc.nodes.get(anchor))
    moveNode(store, stop.platform, 52.005, 104.02)
    expect(store.doc.nodes.get(anchor)).toEqual(originalAnchor)
    expect(stopsAt(store.doc, stop.platform)).toEqual([stop])
    store.undo()
    expect(store.doc.nodes.get(stop.platform)!.lon).toBeCloseTo(104.0001)
    store.redo()
    const exported = serializeOsm(store.doc, { onlyRoads: true })
    store.load(parseOsm(exported), 'saved.osm')
    expect(stopsAt(store.doc, stop.platform)).toEqual([stop])
    expect(store.doc.nodes.get(stop.platform)!.lon).toBe(104.02)
    expect(store.doc.nodes.get(anchor)).toEqual(originalAnchor)
  })

  it('обрабатывает исходную карту без потери геометрии и вводит стабильные ID', () => {
    const doc = parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8'))
    const store = new Store({ autoSplitRoads: true })
    store.load(doc, 'example.osm')
    expect([...store.doc.ways.values()].filter(w => w.tags.highway && w.tags.area !== 'yes').every(w => w.nodes.length <= 2)).toBe(true)
    expect(store.doc.nodes.size).toBe(doc.nodes.size)
    const originalCount = [...doc.ways.values()].reduce((count, w) => count + w.nodes.length - 1, 0)
    const newCount = [...store.doc.ways.values()].reduce((count, w) => count + w.nodes.length - 1, 0)
    expect(newCount).toBe(originalCount)
    for (const relation of store.doc.relations.values()) {
      if (relation.tags.type !== 'restriction') continue
      const via = relation.members.find(m => m.type === 'node' && m.role === 'via')
      if (!via) continue
      for (const member of relation.members.filter(m => m.type === 'way' && ['from', 'to'].includes(m.role))) {
        const original = doc.ways.get(member.ref)
        if (original && !original.nodes.includes(via.ref)) continue
        const way = store.doc.ways.get(member.ref)
        if (way) expect(way.nodes).toContain(via.ref)
      }
    }
    const saved = serializeOsm(store.doc)
    store.load(parseOsm(saved), 'saved.osm')
    expect(serializeOsm(store.doc)).toBe(saved)
    expect(store.dirty).toBe(false)
  })
})
