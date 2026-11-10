import { describe, expect, it } from 'vitest'
import { linkSignals, setSignalPlan, unlinkSignals } from './ops'
import { pairOf, readPlan, defaultPlan } from './signals'
import { Store } from './store'
import type { OsmDocument } from './types'

// Две односторонние дороги (встречные) с переходом посреди каждой — светофоры на узлах 2 и 5.
const N = (id: number, lat: number, lon: number, tags: Record<string, string> = {}) => [id, { id, lat, lon, tags, meta: {} }] as const
const W = (id: number, nodes: number[], tags: Record<string, string> = {}) => [id, { id, nodes, tags: { highway: 'secondary', oneway: 'yes', ...tags }, meta: {} }] as const
const make = () => ({
  nodes: new Map([N(1, 55, 37), N(2, 55, 37.001, { highway: 'traffic_signals' }), N(3, 55, 37.002),
    N(4, 55.00005, 37.002), N(5, 55.00005, 37.001, { highway: 'traffic_signals' }), N(6, 55.00005, 37)]),
  ways: new Map([W(10, [1, 2, 3]), W(11, [4, 5, 6])]), relations: new Map(), meta: {},
}) as unknown as OsmDocument

describe('пара светофоров', () => {
  it('связывает узлы взаимно; план одного копируется на второй', () => {
    const store = new Store(); store.load(make(), 't.osm')
    const plan = { ...defaultPlan(store.doc, 2, 50), offset: 7, yellow: 3 }
    setSignalPlan(store, 2, plan)
    linkSignals(store, 2, 5)
    expect(pairOf(store.doc.nodes.get(2)!.tags)).toBe(5)
    expect(pairOf(store.doc.nodes.get(5)!.tags)).toBe(2)
    const b = readPlan(store.doc.nodes.get(5)!.tags)!
    expect(b.cycle).toBe(50); expect(b.offset).toBe(7)
    expect(b.groups[0].start).toBe(plan.groups[0].start); expect(b.groups[0].end).toBe(plan.groups[0].end)
  })
  it('правка плана одного повторяется на втором (и тег пары не теряется)', () => {
    const store = new Store(); store.load(make(), 't.osm')
    setSignalPlan(store, 2, defaultPlan(store.doc, 2, 60)); linkSignals(store, 2, 5)
    const p = readPlan(store.doc.nodes.get(2)!.tags)!
    p.cycle = 90; p.groups[0].end = 40
    setSignalPlan(store, 2, p)
    const b = readPlan(store.doc.nodes.get(5)!.tags)!
    expect(b.cycle).toBe(90); expect(b.groups[0].end).toBe(40)
    expect(pairOf(store.doc.nodes.get(2)!.tags)).toBe(5)
  })
  it('разрыв пары снимает тег с обоих; отмена возвращает как было', () => {
    const store = new Store(); store.load(make(), 't.osm')
    linkSignals(store, 2, 5); unlinkSignals(store, 5)
    expect(pairOf(store.doc.nodes.get(2)!.tags)).toBeUndefined(); expect(pairOf(store.doc.nodes.get(5)!.tags)).toBeUndefined()
    store.undo(); store.undo()
    expect(pairOf(store.doc.nodes.get(2)!.tags)).toBeUndefined()
  })
  it('нельзя связать не светофор', () => {
    const store = new Store(); store.load(make(), 't.osm')
    expect(() => linkSignals(store, 2, 3)).toThrow(/светофор/)
  })
})
