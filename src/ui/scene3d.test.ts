import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { placeRoadFeature } from '../core/ops'
import { parseOsm } from '../core/parse'
import { Store } from '../core/store'
import { buildScene, roadWidth } from './scene3d'

const xml = readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8')
const doc = parseOsm(xml)

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

  it('якорь для знака скорости лежит над дорогой', () => {
    const s = buildScene(doc, opts)
    const a = s.wayAnchor(s.faceWay[0], 8)!
    expect(a).not.toBeNull()
    expect(a.y).toBeGreaterThanOrEqual(7.9)
    expect([a.x, a.y, a.z].every(Number.isFinite)).toBe(true)
    expect(s.wayAnchor(-1)).toBeNull()
  })

  it('светофор и переход, поставленные инструментами, появляются в сцене', () => {
    const base = buildScene(doc, opts)
    expect(base.stats.crossings).toBeGreaterThan(0) // highway=crossing на проезжих дорогах файла
    const store = new Store()
    store.load(parseOsm(xml), 'x.osm')
    const way = [...store.doc.ways.values()].find((w) => w.tags.highway === 'residential' && w.nodes.length > 3)!
    placeRoadFeature(store, { kind: 'node', id: way.nodes[1] }, 'signal')
    placeRoadFeature(store, { kind: 'node', id: way.nodes[2] }, 'crossing')
    const after = buildScene(store.doc, opts)
    expect(after.stats.signals).toBe(base.stats.signals + 1)
    expect(after.stats.crossings).toBe(base.stats.crossings + 1)
  })

  it('разметка полос: пунктир попадает в сцену, ширина дороги растёт с числом полос', () => {
    const s = buildScene(doc, opts)
    const meshes = s.root.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh && !!(c as THREE.Mesh).geometry.getAttribute('color'))
    // дороги, настил (если есть мост) и разметка — все с vertexColors; разметка самая «мелкая» (много штрихов)
    expect(meshes.length).toBeGreaterThanOrEqual(2)
    const marks = meshes.filter((m) => m !== s.roads).sort((a, b) => b.geometry.getAttribute('position').count - a.geometry.getAttribute('position').count)[0]
    expect(marks.geometry.getAttribute('position').count).toBeGreaterThan(1000)
    // в первой версии у дорог без lanes была фиксированная ширина по классу; теперь она = полосы × 3,2 м
    expect(roadWidth({ id: 1, nodes: [], meta: {}, tags: { highway: 'primary', lanes: '3' } })).toBeCloseTo(9.6, 5)
  })

  it('мосты: и автомобильный, и пешеходные (надземные переходы) получают настил', () => {
    const withPed = buildScene(doc, { ...opts, pedestrian: true })
    expect(withPed.stats.bridges).toBe(10) // в файле 1 автомобильный и 9 пешеходных мостов
    expect(buildScene(doc, opts).stats.bridges).toBe(1) // без пешеходных — только автомобильный
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
    expect(roadWidth({ id: 1, nodes: [], meta: {}, tags: { highway: 'residential' } })).toBeCloseTo(6.4, 5) // 2 полосы по умолчанию
    expect(roadWidth({ id: 1, nodes: [], meta: {}, tags: { highway: 'footway' } })).toBe(1.8)
  })
})
