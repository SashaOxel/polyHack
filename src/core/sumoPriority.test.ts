import { describe, expect, it } from 'vitest'
import { buildSumoPriorities } from './sumoPriority'
import type { OsmDocument } from './types'

const doc = (signTags: Record<string, string>) => ({
  nodes: new Map([
    [1, { id: 1, lat: 55, lon: 37, tags: {}, meta: {} }], [2, { id: 2, lat: 55, lon: 37.002, tags: {}, meta: {} }],
    [3, { id: 3, lat: 55, lon: 37.004, tags: {}, meta: {} }], [4, { id: 4, lat: 54.998, lon: 37.002, tags: {}, meta: {} }],
    [6, { id: 6, lat: 54.999, lon: 37.002, tags: signTags, meta: {} }],
  ]),
  ways: new Map([
    [10, { id: 10, nodes: [1, 2, 3], tags: { highway: 'residential' }, meta: {} }],
    [11, { id: 11, nodes: [4, 6, 2], tags: { highway: 'residential' }, meta: {} }],
  ]),
  relations: new Map(), meta: {},
}) as unknown as OsmDocument

const net = `<net>
<edge id="10#0" from="1" to="2" priority="3"><lane id="a"/></edge><edge id="-10#0" from="2" to="1" priority="3"/>
<edge id=":2_0" function="internal"/>
<edge id="11" from="4" to="2" priority="3"/><edge id="-11" from="2" to="4" priority="3"/>
<junction id="2" type="priority" x="10.5" y="20"/></net>`

describe('знаки → приоритеты SUMO', () => {
  it('«Уступи» понижает приоритет ребра, подходящего к перекрёстку', () => {
    const r = buildSumoPriorities(doc({ highway: 'give_way', direction: 'forward' }), net)
    expect(r.edges).toEqual([{ id: '11', priority: 1 }])
    expect(r.nodes).toEqual([])
  })
  it('«Стоп» ещё и делает перекрёсток priority_stop с его координатами', () => {
    const r = buildSumoPriorities(doc({ highway: 'stop', direction: 'forward' }), net)
    expect(r.nodes).toEqual([{ id: '2', x: 10.5, y: 20, type: 'priority_stop' }])
  })
  it('«Главная» повышает приоритет; встречное направление не трогается', () => {
    const d = doc({ traffic_sign: 'RU:2.1', direction: 'forward' })
    d.nodes.set(6, { ...d.nodes.get(6)!, lat: 55, lon: 37.001 }); d.ways.set(11, { id: 11, nodes: [4, 2], tags: { highway: 'residential' }, meta: {} } as never)
    d.ways.set(10, { id: 10, nodes: [1, 6, 2, 3], tags: { highway: 'residential' }, meta: {} } as never)
    expect(buildSumoPriorities(d, net).edges).toEqual([{ id: '10#0', priority: 5 }])
  })
  it('знак без перекрёстка впереди — предупреждение', () => {
    const r = buildSumoPriorities(doc({ highway: 'give_way', direction: 'backward' }), net)
    expect(r.edges).toEqual([]); expect(r.warnings.length).toBe(1)
  })
})
