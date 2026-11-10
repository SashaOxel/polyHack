import { describe, expect, it } from 'vitest'
import { setSignalPlan } from './ops'
import { parseOsm } from './parse'
import { serializeOsm } from './serialize'
import {
  checkPlan, corridorDistance, defaultPlan, greenTime, greenWaveOffset, isGreenAt, readPlan, turnsAt, websterDelay, writePlan,
  type SignalPlan,
} from './signals'
import { Store } from './store'
import { emptyDocument, type OsmDocument, type Tags } from './types'

/**
 * Перекрёсток «плюс» в узле 0: улица Восточная (way 1, запад→восток через 0) и Северная (way 2, юг→север через 0),
 * обе двусторонние. Плюс второй светофорный узел 9 в 300 м восточнее на той же улице.
 */
function cross(): OsmDocument {
  const doc = emptyDocument()
  const put = (id: number, lat: number, lon: number, tags: Tags = {}) => doc.nodes.set(id, { id, lat, lon, tags, meta: {} })
  put(0, 52, 104, { highway: 'traffic_signals' })
  put(1, 52, 103.999); put(2, 52, 104.001); put(3, 51.999, 104); put(4, 52.001, 104)
  put(9, 52, 104.0054, { highway: 'traffic_signals' })
  doc.ways.set(1, { id: 1, nodes: [1, 0, 2, 9], tags: { highway: 'secondary', name: 'Восточная' }, meta: {} })
  doc.ways.set(2, { id: 2, nodes: [3, 0, 4], tags: { highway: 'secondary', name: 'Северная' }, meta: {} })
  return doc
}

describe('повороты узла', () => {
  it('4 подхода × 3 направления = 12, без разворотов, с типами', () => {
    const t = turnsAt(cross(), 0)
    expect(t).toHaveLength(12)
    expect(new Set(t.map((x) => x.approach)).size).toBe(4)
    // с запада на восток прямо и с востока на запад прямо — разные направления
    expect(t.find((x) => x.key === '1+>1+')?.kind).toBe('straight')
    expect(t.find((x) => x.key === '1->1-')?.kind).toBe('straight')
    // с запада (едем на восток) на север — налево, на юг — направо
    expect(t.find((x) => x.key === '1+>2+')?.kind).toBe('left')
    expect(t.find((x) => x.key === '1+>2-')?.kind).toBe('right')
    expect(t.filter((x) => x.kind === 'left')).toHaveLength(4)
  })

  it('учитывает односторонние дороги', () => {
    const doc = cross()
    doc.ways.get(2)!.tags.oneway = 'yes' // только на север
    const keys = turnsAt(doc, 0).map((x) => x.key)
    expect(keys).toHaveLength(7) // 3 подхода: с запада и востока — по 2 (на юг нельзя), с юга — 3
    expect(keys.some((k) => k.endsWith('2-'))).toBe(false) // на юг по Северной нельзя
    expect(keys.some((k) => k.startsWith('2-'))).toBe(false) // и с севера не въехать
  })

  it('светофор посреди улицы — только движение прямо', () => {
    const t = turnsAt(cross(), 9)
    expect(t.every((x) => x.kind === 'straight')).toBe(true)
  })
})

describe('план по умолчанию и проверки', () => {
  it('две оси — две фазы, все направления распределены, ошибок нет', () => {
    const doc = cross()
    const plan = defaultPlan(doc, 0, 60)
    expect(plan.groups).toHaveLength(2)
    expect(plan.groups[0].start).toBe(0)
    expect(plan.groups[0].end).toBe(26) // 30 − межзелёный 4
    expect(plan.groups[1].start).toBe(30)
    expect(checkPlan(plan, turnsAt(doc, 0)).filter((i) => i.level === 'error')).toEqual([])
  })

  it('ловит одновременный зелёный у конфликтующих групп', () => {
    const doc = cross()
    const plan = defaultPlan(doc, 0, 60)
    plan.groups[1].start = 20
    expect(checkPlan(plan, turnsAt(doc, 0)).some((i) => i.text.startsWith('Конфликт'))).toBe(true)
  })

  it('ловит короткий межзелёный и направление без группы', () => {
    const doc = cross()
    const plan = defaultPlan(doc, 0, 60)
    plan.groups[0].end = 29 // до включения второй группы всего 1 с
    plan.groups[1].turns = plan.groups[1].turns.slice(1)
    const texts = checkPlan(plan, turnsAt(doc, 0)).map((i) => i.text)
    expect(texts.some((t) => t.startsWith('Межзелёный'))).toBe(true)
    expect(texts.some((t) => t.startsWith('Направление без сигнальной группы'))).toBe(true)
  })

  it('зелёный через конец цикла', () => {
    const g = { name: 'x', start: 50, end: 10, turns: [] }
    expect(greenTime(g, 60)).toBe(20)
    expect(isGreenAt(g, 60, 55)).toBe(true)
    expect(isGreenAt(g, 60, 5)).toBe(true)
    expect(isGreenAt(g, 60, 30)).toBe(false)
  })

  it('задержка по Вебстеру: меньше зелёного — больше задержка', () => {
    expect(websterDelay(40, 60)).toBeLessThan(websterDelay(20, 60))
    expect(websterDelay(60, 60)).toBeCloseTo(0, 6)
    expect(websterDelay(26, 60)).toBeCloseTo((0.5 * 60 * (1 - 26 / 60) ** 2) / (1 - 0.8 * 26 / 60), 6)
  })
})

describe('хранение в тегах OSM', () => {
  it('туда-обратно без потерь, значения ≤ 255 символов, прочие теги не трогаются', () => {
    const plan: SignalPlan = {
      cycle: 90, offset: 12, yellow: 3, intergreen: 5,
      groups: [
        { name: 'Главная', start: 0, end: 40, turns: Array.from({ length: 30 }, (_, i) => `${1000000000 + i}+>${2000000000 + i}-`) },
        { name: 'Второст.|пров', start: 45, end: 85, turns: ['1+>2+'] },
      ],
    }
    const tags = writePlan({ highway: 'traffic_signals', name: 'x' }, plan)
    expect(Object.values(tags).every((v) => v.length <= 255)).toBe(true)
    expect(tags.highway).toBe('traffic_signals')
    const back = readPlan(tags)!
    expect(back.groups[0].turns).toEqual(plan.groups[0].turns)
    expect(back.groups[1].name).toBe('Второст. пров') // «|» в имени заменяется
    expect({ ...back, groups: [] }).toEqual({ ...plan, groups: [] })
    expect(readPlan(writePlan(tags, null))).toBeUndefined()
    expect(writePlan(tags, null)).toEqual({ highway: 'traffic_signals', name: 'x' })
  })

  it('план сохраняется в .osm и откатывается', () => {
    const s = new Store()
    s.load(cross(), 'c.osm')
    const plan = defaultPlan(s.doc, 0)
    setSignalPlan(s, 0, plan)
    const again = parseOsm(serializeOsm(s.doc, { onlyRoads: true }))
    expect(readPlan(again.nodes.get(0)!.tags)).toEqual(plan)
    s.undo()
    expect(readPlan(s.doc.nodes.get(0)!.tags)).toBeUndefined()
  })
})

describe('зелёная волна', () => {
  it('сдвиг = время в пути по дороге', () => {
    const doc = cross()
    const d = corridorDistance(doc, 0, 9)
    expect(d.byRoad).toBe(true)
    expect(d.meters).toBeGreaterThan(350)
    expect(d.meters).toBeLessThan(380)
    const ref = { ...defaultPlan(doc, 0), offset: 5 }
    const mine = defaultPlan(doc, 9)
    // 368 м при 40 км/ч ≈ 33 с; + 5 опорного; главная группа у обоих начинается в 0
    expect(greenWaveOffset(ref, mine, d.meters, 40)).toBe(Math.round((5 + d.meters / (40 / 3.6)) % 60))
  })
})

describe('программа SUMO из плана', () => {
  it('фазы: зелёный, жёлтый, красный по группам, цикл целиком, левые с уступкой', async () => {
    const { phasesFor, edgeToWay } = await import('./sumoSignals')
    const plan: SignalPlan = { cycle: 60, offset: 0, yellow: 3, intergreen: 4, groups: [
      { name: 'A', start: 0, end: 26, turns: [] }, { name: 'B', start: 30, end: 56, turns: [] },
    ] }
    // сигналы: 0 — группа A прямо, 1 — группа A налево (уступает), 2 — группа B
    const ph = phasesFor(plan, [0, 0, 1], [false, true, false])
    expect(ph).toEqual([
      { duration: 26, state: 'Ggr' },
      { duration: 3, state: 'yyr' },
      { duration: 1, state: 'rrr' },
      { duration: 26, state: 'rrG' },
      { duration: 3, state: 'rry' },
      { duration: 1, state: 'rrr' },
    ])
    expect(edgeToWay('-123#4')).toEqual({ way: 123, dir: '-' })
    expect(edgeToWay('123')).toEqual({ way: 123, dir: '+' })
    expect(edgeToWay(':123_c0')).toBeUndefined()
  })
})
