import { describe, expect, it } from 'vitest'
import { deleteRoute, placeBusStop, saveRoute } from './ops'
import { parseOsm } from './parse'
import { listRoutes, resolveStop, routePath } from './routes'
import { serializeOsm } from './serialize'
import { Store } from './store'
import { emptyDocument, type Tags } from './types'

/**
 * Улица Главная (way 1) с запада на восток: узлы 1–2–3–4–5, двусторонняя.
 * Переулок (way 2) односторонний на север: 3 → 6.  Трамвайные пути (way 3): 7–8–9 параллельно, отдельно от дорог.
 * Остановки: «Вокзал» у узла 1, «Рынок» у узла 3, «Парк» у узла 5 (места посадки 11, 13, 15).
 */
function city() {
  const doc = emptyDocument()
  const put = (id: number, lat: number, lon: number, tags: Tags = {}) => doc.nodes.set(id, { id, lat, lon, tags, meta: {} })
  for (let i = 1; i <= 5; i++) put(i, 52, 104 + i * 0.002)
  put(6, 52.002, 104.006)
  put(7, 52.003, 104.002, { railway: 'tram_stop', name: 'Трамвайная-1' }); put(8, 52.003, 104.006); put(9, 52.003, 104.01, { railway: 'tram_stop', name: 'Трамвайная-2' })
  doc.ways.set(1, { id: 1, nodes: [1, 2, 3, 4, 5], tags: { highway: 'secondary', name: 'Главная' }, meta: {} })
  doc.ways.set(2, { id: 2, nodes: [3, 6], tags: { highway: 'residential', oneway: 'yes' }, meta: {} })
  doc.ways.set(3, { id: 3, nodes: [7, 8, 9], tags: { railway: 'tram' }, meta: {} })
  const s = new Store()
  s.load(doc, 'city.osm')
  for (const [anchor, platform, name] of [[1, 11, 'Вокзал'], [3, 13, 'Рынок'], [5, 15, 'Парк']] as const) {
    s.doc.nodes.set(platform, { id: platform, lat: 52.0002, lon: 104 + anchor * 0.002, tags: { highway: 'bus_stop', name }, meta: {} })
    placeBusStop(s, { kind: 'node', id: anchor }, { id: platform })
  }
  return s
}

describe('маршруты общественного транспорта', () => {
  it('автобус 80: остановки по порядку, путь по дорогам, участники в порядке PTv2', () => {
    const s = city()
    const stops = [1, 13, 5].map((id) => resolveStop(s.doc, id, 'bus')!) // можно кликнуть и по месту посадки (13)
    expect(stops.map((x) => x.name)).toEqual(['Вокзал', 'Рынок', 'Парк'])
    expect(stops[1].node).toBe(3)
    const id = saveRoute(s, { kind: 'bus', ref: '80', stops })
    const r = s.doc.relations.get(id)!
    expect(r.tags).toMatchObject({ type: 'route', route: 'bus', ref: '80', name: 'Автобус 80: Вокзал — Парк', 'public_transport:version': '2', from: 'Вокзал', to: 'Парк' })
    // сначала stop/platform по порядку, потом дороги
    expect(r.members.map((m) => `${m.role || 'way'}:${m.ref}`)).toEqual(['stop:1', 'platform:11', 'stop:3', 'platform:13', 'stop:5', 'platform:15', 'way:1'])
    const info = listRoutes(s.doc).find((x) => x.id === id)!
    expect(info.editable).toBe(true)
    expect(info.stops.map((x) => x.name)).toEqual(['Вокзал', 'Рынок', 'Парк'])
    s.undo()
    expect(s.doc.relations.has(id)).toBe(false)
  })

  it('учитывает одностороннее движение: против oneway пути нет — понятная ошибка', () => {
    const s = city()
    const a = resolveStop(s.doc, 3, 'bus')!, b = resolveStop(s.doc, 6, 'bus')!
    expect(routePath(s.doc, 'bus', [3, 6]).broken).toEqual([])
    expect(routePath(s.doc, 'bus', [6, 3]).broken).toEqual([0])
    expect(() => saveRoute(s, { kind: 'bus', ref: '5', stops: [b, a] })).toThrow(/Нет пути .* 1→2/)
  })

  it('трамвай ездит только по трамвайным путям', () => {
    const s = city()
    expect(resolveStop(s.doc, 3, 'tram')).toBeUndefined() // узел дороги — не трамвайная остановка
    const stops = [7, 9].map((id) => resolveStop(s.doc, id, 'tram')!)
    const id = saveRoute(s, { kind: 'tram', ref: '1', stops })
    expect(s.doc.relations.get(id)!.members.filter((m) => m.type === 'way').map((m) => m.ref)).toEqual([3])
    expect(() => saveRoute(s, { kind: 'tram', ref: '2', stops: [stops[0], { node: 5, name: 'x' }] })).toThrow(/трамвайным путям/)
  })

  it('проверяет номер и число остановок; изменение и удаление', () => {
    const s = city()
    const stops = [1, 5].map((id) => resolveStop(s.doc, id, 'bus')!)
    expect(() => saveRoute(s, { kind: 'bus', ref: ' ', stops })).toThrow(/номер/)
    expect(() => saveRoute(s, { kind: 'bus', ref: '1', stops: stops.slice(0, 1) })).toThrow(/две остановки/)
    const id = saveRoute(s, { kind: 'bus', ref: '1', stops, colour: '#e11d48' })
    saveRoute(s, { kind: 'bus', ref: '1А', stops: [stops[1], stops[0]] }, id) // обратное направление
    const r = s.doc.relations.get(id)!
    expect(r.tags.ref).toBe('1А')
    expect(r.tags.from).toBe('Парк')
    deleteRoute(s, id)
    expect(s.doc.relations.has(id)).toBe(false)
  })

  it('маршрут попадает в .osm, в том числе при экспорте «только дороги»', () => {
    const s = city()
    const id = saveRoute(s, { kind: 'bus', ref: '80', stops: [1, 3, 5].map((n) => resolveStop(s.doc, n, 'bus')!) })
    const back = parseOsm(serializeOsm(s.doc, { onlyRoads: true, keepMeta: false }))
    const r = back.relations.get(id)!
    expect(r.tags.ref).toBe('80')
    expect(r.members.every((m) => (m.type === 'way' ? back.ways.has(m.ref) : back.nodes.has(m.ref)))).toBe(true)
  })
})

describe('проверка маршрутов', () => {
  it('после правки дорог: путь пропал — ошибка, изменился — предупреждение с перестройкой', async () => {
    const { validate } = await import('../validate')
    const { applyFix } = await import('../validate/fixes')
    const { splitWayAt, deleteWay } = await import('./ops')
    const s = city()
    const id = saveRoute(s, { kind: 'bus', ref: '80', stops: [1, 5].map((n) => resolveStop(s.doc, n, 'bus')!) })
    expect(validate(s.doc).filter((i) => i.code === 'route')).toEqual([])
    // разрез дороги сохраняет маршрут целым: новая половина встаёт в relation сразу после старой
    splitWayAt(s, 1, 3)
    expect(validate(s.doc).filter((i) => i.code === 'route')).toEqual([])
    // список дорог маршрута разошёлся с путём (например, правили relation вручную) — предупреждение
    const r0 = s.doc.relations.get(id)!
    s.commit('порча', (tx) => tx.setRelation({ ...r0, members: r0.members.filter((m) => m.type !== 'way' || m.ref === 1) }))
    const stale = validate(s.doc).find((i) => i.code === 'route')!
    expect(stale.severity).toBe('warning')
    applyFix(s, stale.fix!)
    expect(validate(s.doc).filter((i) => i.code === 'route')).toEqual([])
    expect(s.doc.relations.get(id)!.members.filter((m) => m.type === 'way')).toHaveLength(2)
    // удаляем кусок улицы — пути больше нет
    const tail = [...s.doc.ways.values()].find((w) => w.nodes[0] === 3 && w.nodes.at(-1) === 5)!
    deleteWay(s, tail.id)
    expect(validate(s.doc).find((i) => i.code === 'route')?.severity).toBe('error')
  })
})
