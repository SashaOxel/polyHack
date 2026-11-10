import { describe, expect, it } from 'vitest'
import { buildGraph } from './graph'
import { reachability } from './reachability'
import type { OsmDocument } from './types'

// Кольцо 1-2-3-4 (двустороннее) + односторонний отросток 3→5→6 (ловушка: въезд есть, выезда нет) + остров 7—8.
const N = (id: number, lat: number, lon: number) => [id, { id, lat, lon, tags: {}, meta: {} }] as const
const W = (id: number, nodes: number[], tags: Record<string, string> = {}) => [id, { id, nodes, tags: { highway: 'residential', ...tags }, meta: {} }] as const
const doc = {
  nodes: new Map([N(1, 55, 37), N(2, 55, 37.01), N(3, 55.01, 37.01), N(4, 55.01, 37), N(5, 55.02, 37.01), N(6, 55.02, 37.02), N(7, 55.03, 37.05), N(8, 55.03, 37.06)]),
  ways: new Map([W(10, [1, 2]), W(11, [2, 3]), W(12, [3, 4]), W(13, [4, 1]), W(14, [3, 5, 6], { oneway: 'yes' }), W(15, [7, 8])]),
  relations: new Map(), meta: {},
} as unknown as OsmDocument

describe('достижимость', () => {
  const r = reachability(buildGraph(doc))
  it('находит ловушку и остров вне главной сети', () => {
    expect(r.groups.map((g) => g.role).sort()).toEqual(['detached', 'trap'])
    const trap = r.groups.find((g) => g.role === 'trap')!
    expect(trap.wayIds).toContain(14)
    expect(r.groups.find((g) => g.role === 'detached')!.wayIds).toEqual([15])
  })
  it('главная сеть — кольцо; рёбра вне неё привязаны к группам', () => {
    expect(r.mainEdges).toBe(8)
    expect([...r.edgeGroup.values()].every((g) => g.role !== undefined)).toBe(true)
    expect(r.edgeGroup.size).toBeGreaterThanOrEqual(3)
  })
  it('суммирует километры; без границы реальные = всё', () => {
    expect(r.realKm + r.borderKm).toBeCloseTo(r.groups.reduce((a, g) => a + g.km, 0), 6)
  })
  it('ловушка знает, через какой узел она связана с сетью', () => {
    expect(r.groups.find((g) => g.role === 'trap')!.links).toContain(3)
  })
})
