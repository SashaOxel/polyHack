import { afterEach, describe, expect, it } from 'vitest'
import { addMarker, deleteMarker, moveNode } from './ops'
import { parseOsm } from './parse'
import { serializeOsm } from './serialize'
import { Store } from './store'
import { emptyDocument } from './types'

const xml = `<?xml version="1.0"?><osm version="0.6">
 <node id="1" lat="52.0" lon="104.0"/><node id="2" lat="52.0" lon="104.001"/>
 <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way></osm>`

const make = () => {
  const s = new Store()
  s.load(parseOsm(xml), 'm.osm')
  return s
}

describe('маркеры «только UI» (светофоры и переходы)', () => {
  it('не попадают в документ и в .osm, даже при экспорте всего', () => {
    const s = make()
    const before = serializeOsm(s.doc)
    addMarker(s, 'signal', 52.0, 104.0005, 0, 10)
    addMarker(s, 'crossing', 52.0, 104.0002, 0, 10)
    expect(s.markers.size).toBe(2)
    expect(s.doc.nodes.size).toBe(2)
    expect(s.doc.ways.size).toBe(1)
    expect(serializeOsm(s.doc)).toBe(before)
    expect(serializeOsm(s.doc, { onlyRoads: true })).not.toContain('traffic_signals')
    expect(serializeOsm(s.doc)).not.toContain('crossing')
  })

  it('откат, возврат и удаление работают как у остальных правок', () => {
    const s = make()
    const id = addMarker(s, 'signal', 52.0, 104.0005, 0, 10)
    expect(id).toBeLessThan(0)
    s.undo()
    expect(s.markers.size).toBe(0)
    s.redo()
    expect(s.markers.get(id)!.kind).toBe('signal')
    deleteMarker(s, id)
    expect(s.markers.size).toBe(0)
    s.undo()
    expect(s.markers.has(id)).toBe(true)
  })

  it('не делают файл «несохранённым», а правка дороги делает', () => {
    const s = make()
    expect(s.dirty).toBe(false)
    addMarker(s, 'crossing', 52.0, 104.0005, 0)
    expect(s.dirty).toBe(false)
    s.undo()
    expect(s.dirty).toBe(false)
    moveNode(s, 1, 52.001, 104.0)
    expect(s.dirty).toBe(true)
  })

  it('увеличивают docVersion, чтобы карта и 3D перерисовались', () => {
    const s = make()
    const v = s.docVersion
    addMarker(s, 'signal', 52.0, 104.0, 0)
    expect(s.docVersion).toBeGreaterThan(v)
  })
})

describe('сохранение маркеров между запусками', () => {
  const g = globalThis as unknown as { window?: unknown }
  afterEach(() => { delete g.window })

  const fakeStorage = () => {
    const data = new Map<string, string>()
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v) },
      removeItem: (k: string) => { data.delete(k) },
    }
  }

  it('восстанавливаются по имени файла, новые id не совпадают со старыми', () => {
    const storage = fakeStorage()
    g.window = { localStorage: storage }

    const a = new Store()
    a.load(parseOsm(xml), 'm.osm')
    const id1 = addMarker(a, 'signal', 52.0, 104.0003, 0.5, 10)
    const id2 = addMarker(a, 'crossing', 52.0, 104.0007, 0, 10)

    const b = new Store() // «новый запуск»
    b.load(parseOsm(xml), 'm.osm')
    expect([...b.markers.keys()].sort()).toEqual([id1, id2].sort())
    expect(b.markers.get(id1)).toMatchObject({ kind: 'signal', angle: 0.5, wayId: 10 })
    const id3 = addMarker(b, 'signal', 52.0, 104.0009, 0)
    expect([id1, id2]).not.toContain(id3)

    const other = new Store() // другой файл — чистый слой
    other.load(emptyDocument(), 'other.osm')
    expect(other.markers.size).toBe(0)

    deleteMarker(b, id1); deleteMarker(b, id2); deleteMarker(b, id3)
    const c = new Store()
    c.load(parseOsm(xml), 'm.osm')
    expect(c.markers.size).toBe(0)
  })

  it('повреждённые данные не ломают загрузку', () => {
    const storage = fakeStorage()
    storage.setItem('uds-markers:m.osm', '{не json')
    g.window = { localStorage: storage }
    const s = new Store()
    expect(() => s.load(parseOsm(xml), 'm.osm')).not.toThrow()
    expect(s.markers.size).toBe(0)
  })
})
