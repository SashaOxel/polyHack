import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyze, buildGraph, stronglyConnectedComponents } from './graph'
import { parseOsm } from './parse'
import { emptyDocument, type OsmDocument, type Tags } from './types'
import { validate } from '../validate'

/** Мини-документ: ways задаются списком id узлов; координаты узлов раскладываются автоматически. */
function mk(ways: { id: number; nodes: number[]; tags?: Tags }[]): OsmDocument {
  const doc = emptyDocument()
  for (const w of ways) {
    for (const n of w.nodes) {
      if (!doc.nodes.has(n)) doc.nodes.set(n, { id: n, lat: 52 + n * 0.0001, lon: 104 + (n % 3) * 0.0001, tags: {}, meta: {} })
    }
    doc.ways.set(w.id, { id: w.id, nodes: w.nodes, tags: { highway: 'residential', ...w.tags }, meta: {} })
  }
  return doc
}

const ONEWAY = { oneway: 'yes' }

describe('buildGraph', () => {
  it('двусторонняя дорога даёт два ребра, oneway — одно', () => {
    expect(buildGraph(mk([{ id: 1, nodes: [1, 2, 3] }])).edges).toHaveLength(2)
    expect(buildGraph(mk([{ id: 1, nodes: [1, 2, 3], tags: ONEWAY }])).edges).toHaveLength(1)
  })

  it('oneway=-1 идёт против порядка узлов', () => {
    const e = buildGraph(mk([{ id: 1, nodes: [1, 2, 3], tags: { oneway: '-1' } }])).edges[0]
    expect([e.from, e.to]).toEqual([3, 1])
  })

  it('режет дороги на перекрёстке', () => {
    const g = buildGraph(mk([{ id: 1, nodes: [1, 2, 3] }, { id: 2, nodes: [4, 2, 5] }]))
    expect(g.edges).toHaveLength(8) // 4 отрезка × 2 направления
    expect(g.nodes.get(2)!.out).toHaveLength(4)
  })

  it('игнорирует не-автомобильные дороги', () => {
    expect(buildGraph(mk([{ id: 1, nodes: [1, 2], tags: { highway: 'footway' } }])).edges).toHaveLength(0)
  })

  it('кольцо и магистраль односторонние по умолчанию, oneway=no отменяет', () => {
    const ring = mk([{ id: 1, nodes: [1, 2, 3, 1], tags: { junction: 'roundabout' } }])
    expect(buildGraph(ring).edges.every((e) => e.oneway)).toBe(true)
    expect(buildGraph(mk([{ id: 1, nodes: [1, 2], tags: { highway: 'motorway' } }])).edges).toHaveLength(1)
    expect(buildGraph(mk([{ id: 1, nodes: [1, 2], tags: { highway: 'motorway', oneway: 'no' } }])).edges).toHaveLength(2)
  })

  it('читает полосы и скорость', () => {
    const e = buildGraph(mk([{ id: 1, nodes: [1, 2], tags: { ...ONEWAY, lanes: '3', maxspeed: '60' } }])).edges[0]
    expect(e.lanes).toBe(3)
    expect(e.maxspeed).toBe(60)
  })
})

describe('связность', () => {
  const loop = [
    { id: 1, nodes: [1, 2], tags: ONEWAY },
    { id: 2, nodes: [2, 3], tags: ONEWAY },
    { id: 3, nodes: [3, 1], tags: ONEWAY },
  ]

  it('односторонний цикл — одна сильная компонента', () => {
    const comps = stronglyConnectedComponents(buildGraph(mk(loop)))
    expect(comps.filter((c) => c.length === 3)).toHaveLength(1)
  })

  it('находит ловушку и участок без въезда', () => {
    const doc = mk([
      ...loop,
      { id: 4, nodes: [3, 9], tags: ONEWAY }, // въехать можно, выехать нельзя
      { id: 5, nodes: [8, 1], tags: ONEWAY }, // выехать можно, въехать нельзя
    ])
    const a = analyze(buildGraph(doc))
    expect([...a.main].sort()).toEqual([1, 2, 3])
    expect(a.traps).toEqual([[9]])
    expect(a.noEntry).toEqual([[8]])
    const codes = validate(doc).map((i) => i.code)
    expect(codes).toContain('trap')
    expect(codes).toContain('no-entry')
  })

  it('отдельный кусок сети — detached', () => {
    const a = analyze(buildGraph(mk([...loop, { id: 7, nodes: [20, 21] }, { id: 8, nodes: [21, 22] }, { id: 9, nodes: [22, 20] }])))
    // две компоненты по 3 узла: одна считается основной, вторая — отдельная
    expect(a.main.size).toBe(3)
    expect(a.detached).toHaveLength(1)
    expect(a.detached[0]).toHaveLength(3)
  })

  it('двусторонняя сеть без oneway не даёт ловушек', () => {
    const a = analyze(buildGraph(mk([{ id: 1, nodes: [1, 2, 3] }, { id: 2, nodes: [4, 2, 5] }])))
    expect(a.traps).toEqual([])
    expect(a.noEntry).toEqual([])
  })
})

describe('example.osm', () => {
  const doc = parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8'))

  it('строит граф быстро и осмысленно', () => {
    const t0 = performance.now()
    const g = buildGraph(doc)
    const a = analyze(g)
    const ms = performance.now() - t0
    expect(g.edges.length).toBeGreaterThan(500)
    expect(a.main.size).toBeGreaterThan(50)
    expect(ms).toBeLessThan(1500)
    // каждая ловушка/«нет въезда» — реальные узлы графа
    for (const grp of [...a.traps, ...a.noEntry]) for (const id of grp) expect(g.nodes.has(id)).toBe(true)
  })
})
