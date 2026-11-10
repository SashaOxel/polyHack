import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseOsm } from './parse'
import type { SignalPlan } from './signals'
import { writePlan } from './signals'
import { TrafficSim, laneOffsets } from './traffic'
import { emptyDocument, type OsmDocument } from './types'

/** Прямая улица с запада на восток (one-way, 60 км/ч) длиной ~700 м и светофор посередине (узел 5). */
function street(plan?: SignalPlan): OsmDocument {
  const doc = emptyDocument()
  for (let i = 0; i <= 10; i++) doc.nodes.set(i, { id: i, lat: 52, lon: 104 + i * 0.001, tags: {}, meta: {} })
  doc.nodes.get(5)!.tags = plan ? writePlan({ highway: 'traffic_signals' }, plan) : { highway: 'traffic_signals' }
  doc.ways.set(1, { id: 1, nodes: [0, 1, 2, 3, 4, 5], tags: { highway: 'secondary', oneway: 'yes', maxspeed: '60' }, meta: {} })
  doc.ways.set(2, { id: 2, nodes: [5, 6, 7, 8, 9, 10], tags: { highway: 'secondary', oneway: 'yes', maxspeed: '60' }, meta: {} })
  return doc
}

const always = (green: boolean): SignalPlan => ({
  cycle: 60, offset: 0, yellow: 3, intergreen: 4,
  // зелёный 0…1 с — по сути всегда красный; или весь цикл зелёный
  groups: [{ name: 'Главная', start: 0, end: green ? 60 : 1, turns: ['1+>2+'] }],
})

describe('демо-движение', () => {
  it('на красный машины стоят перед стоп-линией и не наезжают друг на друга', () => {
    const sim = new TrafficSim(street(always(false)), 12, 7)
    sim.step(0.2)
    for (let i = 0; i < 600; i++) sim.step(0.2) // 2 минуты
    const firstEdge = sim.edges.findIndex((e) => e.wayId === 1)
    const queue = sim.vehicles.filter((v) => v.edge === firstEdge).sort((a, b) => b.s - a.s)
    expect(queue.length).toBeGreaterThan(3)
    expect(queue[0].s).toBeLessThanOrEqual(sim.edges[firstEdge].length) // никто не проехал стоп-линию
    expect(queue[0].v).toBeLessThan(0.5)
    for (let i = 1; i < queue.length; i++) expect(queue[i - 1].s - queue[i].s).toBeGreaterThanOrEqual(4.5) // нет наложений (одна полоса)
  })

  it('на зелёный проезжают, скорость не выше ограничения', () => {
    const sim = new TrafficSim(street(always(true)), 6, 3)
    let maxV = 0
    for (let i = 0; i < 600; i++) { sim.step(0.2); for (const v of sim.vehicles) maxV = Math.max(maxV, v.v) }
    expect(maxV * 3.6).toBeLessThanOrEqual(60 * 1.05 + 0.01)
    expect(sim.stats().avgKmh).toBeGreaterThan(5)
  })

  it('одностороннее движение соблюдается: машины едут только по разрешённым рёбрам', () => {
    const sim = new TrafficSim(street(), 8, 1)
    expect(sim.edges.every((e) => e.id.endsWith(':f'))).toBe(true) // обратных рёбер у oneway нет
  })

  it('на реальной карте работает и детерминирован при одном зерне', () => {
    const doc = parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8'))
    const a = new TrafficSim(doc, 200, 42), b = new TrafficSim(doc, 200, 42)
    for (let i = 0; i < 300; i++) { a.step(0.2); b.step(0.2) }
    expect(a.vehicles.length).toBe(200)
    expect(a.vehicles.map((v) => v.s)).toEqual(b.vehicles.map((v) => v.s))
    for (const v of a.vehicles) {
      const p = a.position(v)
      expect(Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.heading)).toBe(true)
    }
    const st = a.stats()
    expect(st.avgKmh).toBeGreaterThan(3)
    expect(st.avgKmh).toBeLessThan(100)
  })
})

describe('полосы', () => {
  it('смещения полос: односторонняя 3 полосы, двусторонняя 2 и 4, встречные слева', () => {
    const r = (a: number[]) => a.map((x) => Math.round(x * 100) / 100 || 0) // -0 → 0
    expect(r(laneOffsets(3, false, null, true))).toEqual([-3.2, 0, 3.2])
    // двусторонняя 2 полосы: по ходу — правее оси на полполосы, навстречу — тоже правее оси (по своему ходу)
    expect(r(laneOffsets(2, true, 1, true))).toEqual([1.6])
    expect(r(laneOffsets(2, true, 1, false))).toEqual([1.6])
    // 4 полосы, по 2 в каждую сторону: ближняя к оси 1.6, дальняя 4.8
    expect(r(laneOffsets(4, true, 2, true))).toEqual([1.6, 4.8])
    expect(r(laneOffsets(4, true, 2, false))).toEqual([1.6, 4.8])
    // 3 полосы: 2 попутные справа и 1 встречная (centerAfter = 1)
    expect(r(laneOffsets(3, true, 1, true))).toEqual([0, 3.2])
    expect(r(laneOffsets(3, true, 1, false))).toEqual([3.2])
  })

  it('машины распределяются по полосам и держат дистанцию внутри своей полосы', () => {
    const doc = street(always(false))
    for (const w of doc.ways.values()) w.tags.lanes = '3'
    const sim = new TrafficSim(doc, 24, 5)
    for (let i = 0; i < 600; i++) sim.step(0.2)
    const firstEdge = sim.edges.findIndex((e) => e.wayId === 1)
    const here = sim.vehicles.filter((v) => v.edge === firstEdge)
    expect(new Set(here.map((v) => v.lane)).size).toBeGreaterThan(1) // заняты разные полосы
    for (const lane of [0, 1, 2]) {
      const q = here.filter((v) => v.lane === lane).sort((a, b) => b.s - a.s)
      for (let i = 1; i < q.length; i++) expect(q[i - 1].s - q[i].s).toBeGreaterThanOrEqual(4.5)
    }
    // боковое смещение — в пределах проезжей части (3 × 3.2 м)
    for (const v of here) expect(Math.abs(sim.position(v).offset)).toBeLessThanOrEqual(4.8 + 1e-9)
  })
})
