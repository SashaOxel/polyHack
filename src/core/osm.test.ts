import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Store } from './store'
import { parseOsm } from './parse'
import { reverseWay, moveNode, splitWayAt } from './ops'
import { serializeOsm } from './serialize'
import { validate } from '../validate'
import { isDrivable } from './roads'

const xml = readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8')

describe('parse / serialize', () => {
  const doc = parseOsm(xml)

  it('читает example.osm', () => {
    expect(doc.nodes.size).toBe(6089)
    expect(doc.ways.size).toBe(1392)
    expect(doc.relations.size).toBe(187)
    expect(doc.bounds?.minlat).toBeCloseTo(52.25113, 5)
  })

  it('круговой проход без потерь', () => {
    const again = parseOsm(serializeOsm(doc))
    expect(again.nodes.size).toBe(doc.nodes.size)
    expect(again.ways.size).toBe(doc.ways.size)
    expect(again.relations.size).toBe(doc.relations.size)
    const w = [...doc.ways.values()].find((x) => Object.keys(x.tags).length > 2)!
    expect(again.ways.get(w.id)).toEqual(w)
  })

  it('экспорт «только дороги» оставляет проезжие дороги и их узлы', () => {
    const out = parseOsm(serializeOsm(doc, { onlyRoads: true, keepMeta: false }))
    // дороги для машин + трамвайные пути (часть транспортной сети)
    const drivable = [...doc.ways.values()].filter((w) => isDrivable(w) || w.tags.railway === 'tram').length
    expect(out.ways.size).toBe(drivable)
    expect([...out.ways.values()].every((w) => w.nodes.every((n) => out.nodes.has(n)))).toBe(true)
    expect([...out.ways.values()].some((w) => w.tags.building)).toBe(false)
  })
})

describe('store: undo/redo', () => {
  it('двигает узел и откатывает', () => {
    const s = new Store()
    s.load(parseOsm(xml), 'example.osm')
    const id = [...s.doc.nodes.keys()][0]
    const { lat } = s.doc.nodes.get(id)!
    moveNode(s, id, lat + 0.001, s.doc.nodes.get(id)!.lon)
    expect(s.doc.nodes.get(id)!.lat).toBeCloseTo(lat + 0.001, 6)
    s.undo()
    expect(s.doc.nodes.get(id)!.lat).toBe(lat)
    s.redo()
    expect(s.doc.nodes.get(id)!.lat).toBeCloseTo(lat + 0.001, 6)
  })

  it('разворот дороги и разрезание', () => {
    const s = new Store()
    s.load(parseOsm(xml), 'example.osm')
    const w = [...s.doc.ways.values()].find((x) => isDrivable(x) && x.nodes.length > 3)!
    const first = w.nodes[0]
    reverseWay(s, w.id)
    expect(s.doc.ways.get(w.id)!.nodes.at(-1)).toBe(first)
    const before = s.doc.ways.size
    splitWayAt(s, w.id, s.doc.ways.get(w.id)!.nodes[1])
    expect(s.doc.ways.size).toBe(before + 1)
    s.undo()
    expect(s.doc.ways.size).toBe(before)
  })
})

describe('валидатор', () => {
  it('находит проблемы на example.osm', () => {
    const issues = validate(parseOsm(xml))
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some((i) => i.code === 'broken-relation')).toBe(true)
  })
})
