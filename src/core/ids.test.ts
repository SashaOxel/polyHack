import { describe, expect, it } from 'vitest'
import { createIdGenerator } from './ids'
import { addNode } from './ops'
import { parseOsm } from './parse'
import { serializeOsm } from './serialize'
import { stopsAt } from './stops'
import { Store } from './store'
import { emptyDocument } from './types'

describe('Положительные номера объектов', () => {
  it('сохраняет исходные номера и не использует внешние ссылки при создании узлов', () => {
    const doc = emptyDocument()
    doc.nodes.set(2064126206, { id: 2064126206, lat: 52, lon: 104, tags: {}, meta: {} })
    doc.relations.set(10, {
      id: 10, tags: { type: 'route' }, meta: {},
      members: [{ type: 'node', ref: 2064126210, role: 'stop' }],
    })
    const store = new Store()
    store.load(doc, 'test.osm')
    const first = addNode(store, 52.001, 104)
    expect(first).toBe(2064126211)
    expect(store.doc.nodes.has(2064126206)).toBe(true)
    store.undo()
    store.redo()
    expect(store.doc.nodes.has(first)).toBe(true)
    store.load(parseOsm(serializeOsm(store.doc)), 'saved.osm')
    expect(addNode(store, 52.002, 104)).toBeGreaterThan(first)
    expect(store.doc.nodes.size).toBe(3)
  })

  it('обновляет старые отрицательные номера остановки и все связи при открытии', () => {
    const doc = parseOsm(`<osm version="0.6">
      <node id="2064126206" lat="52" lon="104"/>
      <node id="-1" lat="52.001" lon="104"><tag k="public_transport" v="stop_position"/></node>
      <node id="-2" lat="52.001" lon="104.0001"><tag k="public_transport" v="platform"/></node>
      <way id="-1"><nd ref="2064126206"/><nd ref="-1"/><tag k="highway" v="residential"/></way>
      <relation id="-3"><member type="node" ref="-1" role="stop"/><member type="node" ref="-2" role="platform"/>
        <tag k="type" v="public_transport"/><tag k="public_transport" v="stop_area"/><tag k="polyhack:linked" v="yes"/>
      </relation>
      <relation id="20"><member type="way" ref="-1" role=""/><member type="relation" ref="-3" role=""/></relation>
    </osm>`)
    const store = new Store()
    store.load(doc, 'older-editor.osm')
    const way = [...store.doc.ways.values()][0]
    const anchor = way.nodes[1]
    const [stop] = stopsAt(store.doc, anchor)
    expect([anchor, way.id, stop.platform, stop.area].every(id => id > 2064126206)).toBe(true)
    expect(new Set([anchor, way.id, stop.platform, stop.area]).size).toBe(4)
    expect(store.doc.relations.get(20)?.members.map(member => member.ref)).toEqual([way.id, stop.area])
    expect(store.dirty).toBe(true)
    expect(doc.nodes.has(-1)).toBe(true)
    store.load(parseOsm(serializeOsm(store.doc, { onlyRoads: true })), 'saved.osm')
    expect(stopsAt(store.doc, anchor)).toEqual([stop])
    expect(store.dirty).toBe(false)
  })

  it('выделяет свободный безопасный номер при предельном исходном ID', () => {
    const doc = emptyDocument()
    for (const id of [1, Number.MAX_SAFE_INTEGER]) {
      doc.nodes.set(id, { id, lat: 52, lon: 104, tags: {}, meta: {} })
    }
    const allocate = createIdGenerator(doc)
    expect(allocate()).toBe(2)
    expect(allocate()).toBe(3)
  })
})
