import { describe, expect, it } from 'vitest'
import { buildGraph } from './graph'
import { deleteNode, deleteWay, drawRoad, featureTags, insertNodeOnWay, mergeNodes, placeRoadFeature, splitAtNode } from './ops'
import { serializeOsm } from './serialize'
import { DRAW_TEMPLATES, isFootTemplate } from './templates'
import { Store } from './store'
import { emptyDocument, type Tags } from './types'

/**
 * Перекрёсток-«плюс»: дорога 1 горизонтальная (узлы 1-2-3), дорога 2 вертикальная (4-2-5).
 * Узел 2 общий. Плюс ограничение поворота 100 (from=1, to=2, via=узел 2) и маршрут 200 по дороге 1.
 */
function plus(): Store {
  const doc = emptyDocument()
  const put = (id: number, lat: number, lon: number, tags: Tags = {}) => doc.nodes.set(id, { id, lat, lon, tags, meta: {} })
  put(1, 52.0, 104.000); put(2, 52.0, 104.001); put(3, 52.0, 104.002)
  put(4, 52.001, 104.001); put(5, 51.999, 104.001, { highway: 'traffic_signals' })
  doc.ways.set(1, { id: 1, nodes: [1, 2, 3], tags: { highway: 'residential' }, meta: {} })
  doc.ways.set(2, { id: 2, nodes: [4, 2, 5], tags: { highway: 'residential' }, meta: {} })
  doc.relations.set(100, {
    id: 100, tags: { type: 'restriction', restriction: 'no_left_turn' }, meta: {},
    members: [{ type: 'way', ref: 1, role: 'from' }, { type: 'node', ref: 2, role: 'via' }, { type: 'way', ref: 2, role: 'to' }],
  })
  doc.relations.set(200, { id: 200, tags: { type: 'route', route: 'bus' }, meta: {}, members: [{ type: 'way', ref: 1, role: '' }] })
  const s = new Store()
  s.load(doc, 'test.osm')
  return s
}

describe('drawRoad', () => {
  it('рисует дорогу из свободных точек одним шагом undo', () => {
    const s = plus()
    const id = drawRoad(s, [
      { kind: 'new', lat: 52.01, lon: 104.0 }, { kind: 'new', lat: 52.01, lon: 104.002 },
    ], { highway: 'service' })
    expect(id).toBeLessThan(0)
    expect(s.doc.ways.get(id)!.nodes).toHaveLength(2)
    expect(s.doc.nodes.size).toBe(7)
    s.undo()
    expect(s.doc.ways.has(id)).toBe(false)
    expect(s.doc.nodes.size).toBe(5)
    s.redo()
    expect(s.doc.ways.has(id)).toBe(true)
  })

  it('присоединяется к узлу и врезается в существующую дорогу', () => {
    const s = plus()
    const id = drawRoad(s, [
      { kind: 'node', id: 3 },
      { kind: 'way', wayId: 2, lat: 52.0005, lon: 104.0012 }, // рядом с вертикальной дорогой
    ], { highway: 'service' })
    const road = s.doc.ways.get(id)!
    expect(road.nodes[0]).toBe(3)
    const junction = road.nodes[1]
    // узел встал в вертикальную дорогу, в ней теперь 4 узла вместо 3
    expect(s.doc.ways.get(2)!.nodes).toContain(junction)
    expect(s.doc.ways.get(2)!.nodes).toHaveLength(4)
    // точка лежит на отрезке: долгота равна долготе вертикальной дороги
    expect(s.doc.nodes.get(junction)!.lon).toBeCloseTo(104.001, 6)
    // в графе это настоящий перекрёсток
    expect(buildGraph(s.doc).nodes.get(junction)!.out.length).toBeGreaterThanOrEqual(3)
    s.undo()
    expect(s.doc.ways.get(2)!.nodes).toEqual([4, 2, 5])
  })

  it('меньше двух точек — ничего не делает', () => {
    const s = plus()
    expect(drawRoad(s, [{ kind: 'node', id: 1 }], { highway: 'service' })).toBe(0)
    expect(s.canUndo).toBe(false)
  })
})

describe('insertNodeOnWay', () => {
  it('добавляет узел в нужное место дороги', () => {
    const s = plus()
    const id = insertNodeOnWay(s, 1, 52.0001, 104.0015) // между 2 и 3
    expect(s.doc.ways.get(1)!.nodes).toEqual([1, 2, id, 3])
  })
})

describe('splitAtNode', () => {
  it('режет проходящие насквозь дороги и сохраняет членство в маршруте', () => {
    const s = plus()
    expect(splitAtNode(s, 2)).toBe(2)
    expect(s.doc.ways.size).toBe(4)
    expect(s.doc.ways.get(1)!.nodes).toEqual([1, 2])
    const route = s.doc.relations.get(200)!
    expect(route.members).toHaveLength(2) // обе половины
    s.undo()
    expect(s.doc.ways.size).toBe(2)
    expect(s.doc.relations.get(200)!.members).toHaveLength(1)
  })

  it('на конце дороги ничего не режет', () => {
    expect(splitAtNode(plus(), 1)).toBe(0)
  })
})

describe('deleteNode', () => {
  it('убирает узел из дороги и чистит relations', () => {
    const s = plus()
    deleteNode(s, 3) // конец дороги 1
    expect(s.doc.ways.get(1)!.nodes).toEqual([1, 2])
    expect(s.doc.nodes.has(3)).toBe(false)
    s.undo()
    expect(s.doc.ways.get(1)!.nodes).toEqual([1, 2, 3])
    expect(s.doc.nodes.has(3)).toBe(true)
  })

  it('удаление узла-via убирает запрет поворота', () => {
    const s = plus()
    deleteNode(s, 2)
    expect(s.doc.relations.has(100)).toBe(false)
    // дороги не пропали: у каждой остались два узла
    expect(s.doc.ways.get(1)!.nodes).toEqual([1, 3])
  })

  it('дорога из двух узлов исчезает вместе с узлом', () => {
    const s = plus()
    deleteNode(s, 1) // дорога 1: [1,2,3] → [2,3] остаётся
    deleteNode(s, 3) // → [2] → дорога удаляется
    expect(s.doc.ways.has(1)).toBe(false)
    s.undo(); s.undo()
    expect(s.doc.ways.get(1)!.nodes).toEqual([1, 2, 3])
  })
})

describe('deleteWay', () => {
  it('удаляет запреты с участием дороги и убирает её из маршрутов', () => {
    const s = plus()
    deleteWay(s, 1)
    expect(s.doc.relations.has(100)).toBe(false)
    expect(s.doc.relations.get(200)!.members).toHaveLength(0)
    expect(s.doc.nodes.has(1)).toBe(false) // конец стал ничьим
    expect(s.doc.nodes.has(2)).toBe(true)  // узел 2 держит вторая дорога
    s.undo()
    expect(s.doc.relations.has(100)).toBe(true)
    expect(s.doc.nodes.has(1)).toBe(true)
  })

  it('не удаляет узлы с тегами (светофоры)', () => {
    const s = plus()
    deleteWay(s, 2)
    expect(s.doc.nodes.has(5)).toBe(true)
  })
})

describe('mergeNodes', () => {
  it('склеивает два узла: дороги переключаются, теги объединяются', () => {
    const s = plus()
    // новая дорога заканчивается рядом с узлом 3
    const id = drawRoad(s, [{ kind: 'new', lat: 52.01, lon: 104.002 }, { kind: 'new', lat: 52.0001, lon: 104.002 }], { highway: 'service' })
    const endNode = s.doc.ways.get(id)!.nodes[1]
    mergeNodes(s, 3, endNode)
    expect(s.doc.nodes.has(endNode)).toBe(false)
    expect(s.doc.ways.get(id)!.nodes[1]).toBe(3)
    // в графе узел 3 теперь перекрёсток
    expect(buildGraph(s.doc).nodes.get(3)!.out.length).toBe(2)
    s.undo()
    expect(s.doc.nodes.has(endNode)).toBe(true)
    expect(s.doc.ways.get(id)!.nodes[1]).toBe(endNode)
  })

  it('перенос тегов и relations', () => {
    const s = plus()
    mergeNodes(s, 3, 5) // у 5 тег traffic_signals, у 3 тегов нет
    expect(s.doc.nodes.get(3)!.tags.highway).toBe('traffic_signals')
    expect(s.doc.ways.get(2)!.nodes).toEqual([4, 2, 3])
  })

  it('схлопнувшаяся дорога удаляется', () => {
    const s = plus()
    mergeNodes(s, 2, 3) // дорога 1: [1,2,3] → [1,2]; ничего не схлопывается
    expect(s.doc.ways.get(1)!.nodes).toEqual([1, 2])
    mergeNodes(s, 1, 2) // дорога 1: [1,2] → [1,1] → [1] → удаляется
    expect(s.doc.ways.has(1)).toBe(false)
  })
})

describe('светофоры и пешеходные переходы — это правка OSM', () => {
  it('клик по отрезку дороги: появляется новый узел с тегом, он в дороге и попадает в .osm', () => {
    const s = plus()
    const nodesBefore = s.doc.nodes.size
    const id = placeRoadFeature(s, { kind: 'way', wayId: 1, lat: 52.0, lon: 104.0005 }, 'signal')
    expect(id).toBeLessThan(0)
    expect(s.doc.nodes.size).toBe(nodesBefore + 1)
    expect(s.doc.nodes.get(id)!.tags.highway).toBe('traffic_signals')
    expect(s.doc.ways.get(1)!.nodes).toContain(id)
    expect(s.dirty).toBe(true) // файл изменён, его надо сохранить
    const xml = serializeOsm(s.doc, { onlyRoads: true })
    expect(xml).toContain(`<node id="${id}"`)
    expect(xml).toContain('v="traffic_signals"')
    s.undo() // одним шагом: и узел, и тег
    expect(s.doc.nodes.has(id)).toBe(false)
    expect(s.doc.ways.get(1)!.nodes).toEqual([1, 2, 3])
  })

  it('клик по существующему узлу ставит тег на него, новых узлов нет', () => {
    const s = plus()
    const n = s.doc.nodes.size
    expect(placeRoadFeature(s, { kind: 'node', id: 2 }, 'crossing')).toBe(2)
    expect(s.doc.nodes.size).toBe(n)
    expect(s.doc.nodes.get(2)!.tags).toMatchObject({ highway: 'crossing', crossing: 'uncontrolled' })
    expect(serializeOsm(s.doc, { onlyRoads: true })).toContain('k="crossing" v="uncontrolled"')
  })

  it('светофор и переход на одном узле не затирают друг друга', () => {
    expect(featureTags({ highway: 'crossing', crossing: 'uncontrolled' }, 'signal')).toEqual({ highway: 'traffic_signals', crossing: 'uncontrolled' })
    expect(featureTags({ highway: 'crossing' }, 'signal')).toEqual({ highway: 'traffic_signals', crossing: 'traffic_signals' })
    expect(featureTags({ highway: 'traffic_signals' }, 'crossing')).toEqual({ highway: 'traffic_signals', crossing: 'traffic_signals' })
    expect(featureTags({ name: 'x' }, 'signal')).toEqual({ name: 'x', highway: 'traffic_signals' })
  })
})

describe('пешеходные дороги', () => {
  const foot = (name: string) => DRAW_TEMPLATES.find((t) => t.name === name)!

  it('в списке для рисования есть пешеходные шаблоны, и они помечены', () => {
    const names = DRAW_TEMPLATES.filter(isFootTemplate).map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['Пешеходная дорожка', 'Лестница', 'Пешеходная улица']))
    expect(isFootTemplate(foot('Жилая улица'))).toBe(false)
  })

  it('дорожка создаётся, присоединяется к дороге, но в граф для машин не попадает', () => {
    const s = plus()
    const edgesBefore = buildGraph(s.doc).edges.length
    const id = drawRoad(s, [
      { kind: 'way', wayId: 1, lat: 52.0, lon: 104.0005 }, // начало на проезжей части
      { kind: 'new', lat: 52.0004, lon: 104.0005 },
    ], foot('Пешеходная дорожка').tags)
    expect(s.doc.ways.get(id)!.tags).toEqual({ highway: 'footway' })
    // дорожка подключена к проезжей части, но для машин это не перекрёсток: граф не меняется
    expect(buildGraph(s.doc).edges.length).toBe(edgesBefore)
    expect(buildGraph(s.doc).edges.some((e) => e.wayId === id)).toBe(false)
    expect(s.doc.ways.get(1)!.nodes).toHaveLength(4) // но узел в проезжей дороге появился — это точка подключения
  })

  it('в .osm попадает только с «Добавить пешеходные»', () => {
    const s = plus()
    const id = drawRoad(s, [{ kind: 'new', lat: 52.01, lon: 104.0 }, { kind: 'new', lat: 52.01, lon: 104.001 }], foot('Лестница').tags)
    expect(serializeOsm(s.doc, { onlyRoads: true })).not.toContain(`<way id="${id}"`)
    expect(serializeOsm(s.doc, { onlyRoads: true, includePedestrian: true })).toContain(`<way id="${id}"`)
    expect(serializeOsm(s.doc)).toContain('v="steps"') // полный экспорт — всё
  })

  it('дорожка-переход несёт footway=crossing', () => {
    expect(foot('Переход (дорожка через дорогу)').tags).toEqual({ highway: 'footway', footway: 'crossing' })
  })
})
