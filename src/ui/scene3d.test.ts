import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { parseOsm } from '../core/parse'
import { buildScene, roadWidth } from './scene3d'

const doc = parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8'))

describe('3D-сцена', () => {
  const opts = { zScale: 3, buildings: true, pedestrian: false }

  it('строит дороги, здания и считает объекты', () => {
    const t0 = performance.now()
    const s = buildScene(doc, opts)
    const ms = performance.now() - t0
    expect(s.roads).not.toBeNull()
    expect(s.stats.roads).toBeGreaterThan(100)
    expect(s.stats.buildings).toBeGreaterThan(100)
    expect(s.stats.signals).toBeGreaterThan(0)
    expect(s.radius).toBeGreaterThan(300)
    expect(ms).toBeLessThan(3000)
  })

  it('на каждый треугольник дорог есть id дороги', () => {
    const s = buildScene(doc, opts)
    const g = s.roads!.geometry
    expect(s.faceWay.length).toBe(g.index!.count / 3)
    expect(s.faceWay.every((id) => doc.ways.has(id))).toBe(true)
  })

  it('все вершины конечны и лежат в разумных пределах (нет NaN от кривой геометрии)', () => {
    const s = buildScene(doc, opts)
    const pos = s.roads!.geometry.getAttribute('position')
    const box = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute)
    expect(box.isEmpty()).toBe(false)
    for (const v of [box.min.x, box.max.x, box.min.y, box.max.y, box.min.z, box.max.z]) expect(Number.isFinite(v)).toBe(true)
    expect(box.max.x - box.min.x).toBeLessThan(s.radius * 2.5)
  })

  it('мосты поднимают дорогу над землёй, масштаб высоты работает', () => {
    const flat = buildScene(doc, { ...opts, zScale: 1 })
    const high = buildScene(doc, { ...opts, zScale: 4 })
    expect(flat.stats.bridges).toBeGreaterThan(0)
    const top = (s: ReturnType<typeof buildScene>) => new THREE.Box3().setFromBufferAttribute(s.roads!.geometry.getAttribute('position') as THREE.BufferAttribute).max.y
    expect(top(high)).toBeGreaterThan(top(flat) * 2)
  })

  it('подсветка выбранной дороги даёт ленту', () => {
    const s = buildScene(doc, opts)
    const id = s.faceWay[0]
    const g = s.wayRibbon(id, 2, 0.1)
    expect(g).not.toBeNull()
    expect(g!.getAttribute('position').count).toBeGreaterThanOrEqual(4)
    expect(s.wayRibbon(-999, 2, 0)).toBeNull()
  })

  it('без зданий и без пешеходных — легче', () => {
    const a = buildScene(doc, { ...opts, buildings: false })
    expect(a.stats.buildings).toBe(0)
    const withPed = buildScene(doc, { ...opts, pedestrian: true })
    expect(withPed.faceWay.length).toBeGreaterThan(buildScene(doc, opts).faceWay.length)
  })

  it('ширина по полосам и классу', () => {
    expect(roadWidth({ id: 1, nodes: [], meta: {}, tags: { highway: 'primary', lanes: '4' } })).toBeCloseTo(12.8, 5)
    expect(roadWidth({ id: 1, nodes: [], meta: {}, tags: { highway: 'service' } })).toBe(3.5)
    expect(roadWidth({ id: 1, nodes: [], meta: {}, tags: { highway: 'footway' } })).toBe(1.8)
  })
})
