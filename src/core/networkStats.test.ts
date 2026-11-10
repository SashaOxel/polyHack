import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { networkStats } from './networkStats'
import { parseOsm } from './parse'
import { emptyDocument } from './types'

describe('показатели сети', () => {
  it('на example.osm: суммы сходятся, доли в пределах', () => {
    const s = networkStats(parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8')))
    expect(s.roadKm).toBeGreaterThan(5)
    expect(s.laneKm).toBeGreaterThanOrEqual(s.roadKm)
    const sumClass = s.byClass.reduce((a, x) => a + x.km, 0)
    const sumSpeed = s.bySpeed.reduce((a, x) => a + x.km, 0)
    expect(sumClass).toBeCloseTo(s.roadKm, 6)
    expect(sumSpeed).toBeCloseTo(s.roadKm, 6)
    expect(s.byClass[0].km).toBeGreaterThanOrEqual(s.byClass.at(-1)!.km) // по убыванию
    expect(s.bySpeed.some((b) => b.key === 'unset')).toBe(true)
    expect(s.connectivity).toBeGreaterThan(0.5)
    expect(s.connectivity).toBeLessThanOrEqual(1)
    expect(s.stops).toBe(10)
    expect(s.stopsLinked).toBe(0)
    expect(s.tramKm).toBeGreaterThan(0)
    expect(s.junctions).toBeGreaterThan(10)
  })

  it('пустой документ — нули', () => {
    const s = networkStats(emptyDocument())
    expect(s.roadKm).toBe(0)
    expect(s.connectivity).toBe(0)
    expect(s.byClass).toEqual([])
  })
})
