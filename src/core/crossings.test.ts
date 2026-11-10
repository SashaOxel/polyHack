import { describe, expect, it } from 'vitest'
import { findCrossings } from './crossings'
import { makeJunction } from './ops'
import { Store } from './store'
import { validate } from '../validate'
import { applyFix } from '../validate/fixes'
import type { OsmDocument } from './types'

// Две дороги крест-накрест без общего узла: 1—2 по оси X, 3—4 по оси Y.
const N = (id: number, lat: number, lon: number) => [id, { id, lat, lon, tags: {}, meta: {} }] as const
const W = (id: number, nodes: number[], tags: Record<string, string> = {}) => [id, { id, nodes, tags: { highway: 'residential', ...tags }, meta: {} }] as const
const make = (extra: Record<string, string> = {}) => ({
  nodes: new Map([N(1, 55, 37), N(2, 55, 37.002), N(3, 54.999, 37.001), N(4, 55.001, 37.001)]),
  ways: new Map([W(10, [1, 2]), W(11, [3, 4], extra)]), relations: new Map(), meta: {},
}) as unknown as OsmDocument

describe('разорванные перекрёстки', () => {
  it('находит пересечение без узла в его точке', () => {
    const c = findCrossings(make())
    expect(c).toHaveLength(1)
    expect(c[0].a).toBe(10); expect(c[0].b).toBe(11)
    expect(c[0].lat).toBeCloseTo(55, 4); expect(c[0].lon).toBeCloseTo(37.001, 4)
  })
  it('мост, тоннель и другой layer — не перекрёсток', () => {
    expect(findCrossings(make({ bridge: 'yes', layer: '1' }))).toHaveLength(0)
    expect(findCrossings(make({ layer: '-1' }))).toHaveLength(0)
  })
  it('общий узел — уже перекрёсток', () => {
    const d = make(); d.ways.set(11, { ...d.ways.get(11)!, nodes: [3, 2, 4] } as never)
    expect(findCrossings(d)).toHaveLength(0)
  })
  it('исправление вставляет один общий узел в обе дороги, undo возвращает как было', () => {
    const store = new Store(); store.load(make(), 't.osm')
    const issue = validate(store.doc).find((i) => i.code === 'torn-junction')!
    expect(issue.auto).toBeFalsy()
    applyFix(store, issue.fix!)
    const a = store.doc.ways.get(10)!, b = store.doc.ways.get(11)!
    const shared = a.nodes.filter((n) => b.nodes.includes(n))
    expect(shared).toHaveLength(1)
    expect(a.nodes).toHaveLength(3); expect(b.nodes).toHaveLength(3)
    expect(validate(store.doc).some((i) => i.code === 'torn-junction')).toBe(false)
    store.undo()
    expect(store.doc.ways.get(10)!.nodes).toEqual([1, 2]); expect(store.doc.ways.get(11)!.nodes).toEqual([3, 4])
  })
  it('makeJunction на несуществующей дороге — понятная ошибка', () => {
    const store = new Store(); store.load(make(), 't.osm')
    expect(() => makeJunction(store, 10, 999, 55, 37)).toThrow(/не найдены/)
  })
})
