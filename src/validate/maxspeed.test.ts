import { describe, expect, it } from 'vitest'
import { Store } from '../core/store'
import { applyAutoFixes } from './fixes'
import { validate } from './index'
import type { OsmDocument } from '../core/types'

const doc = () => ({
  nodes: new Map([1, 2, 3].map((id) => [id, { id, lat: 55, lon: 37 + id / 1000, tags: {}, meta: {} }])),
  ways: new Map([
    [10, { id: 10, nodes: [1, 2], tags: { highway: 'primary', maxspeed: 'RU:urban' }, meta: {} }],
    [11, { id: 11, nodes: [2, 3], tags: { highway: 'secondary', maxspeed: '40 km/h', 'maxspeed:backward': 'RU:rural' }, meta: {} }],
    [12, { id: 12, nodes: [1, 3], tags: { highway: 'residential', maxspeed: '30' }, meta: {} }],
  ]), relations: new Map(), meta: {},
}) as unknown as OsmDocument

describe('скорость числом', () => {
  it('находит нечисловые значения и исправляет автоматически', () => {
    const store = new Store(); store.load(doc(), 't.osm')
    const issue = validate(store.doc).find((i) => i.code === 'maxspeed-nonnumeric')!
    expect(issue.wayIds).toEqual([10, 11]); expect(issue.auto).toBe(true)
    applyAutoFixes(store, [issue])
    expect(store.doc.ways.get(10)!.tags.maxspeed).toBe('60')
    expect(store.doc.ways.get(11)!.tags.maxspeed).toBe('40'); expect(store.doc.ways.get(11)!.tags['maxspeed:backward']).toBe('90')
    expect(store.doc.ways.get(12)!.tags.maxspeed).toBe('30')
    expect(validate(store.doc).some((i) => i.code === 'maxspeed-nonnumeric')).toBe(false)
  })
  it('одним шагом отмены', () => {
    const store = new Store(); store.load(doc(), 't.osm')
    applyAutoFixes(store, validate(store.doc).filter((i) => i.code === 'maxspeed-nonnumeric'))
    store.undo()
    expect(store.doc.ways.get(10)!.tags.maxspeed).toBe('RU:urban')
  })
})
