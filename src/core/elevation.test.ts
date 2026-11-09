import { describe, expect, it } from 'vitest'
import { cumulativeDistance, elevationContext, LAYER_HEIGHT, smoothstep, wayElevations, wayProfile } from './elevation'
import { clearElevation, setElevationRamp } from './ops'
import { Store } from './store'
import { emptyDocument, type OsmDocument, type Tags } from './types'

/** Прямая дорога на восток из n узлов с шагом ≈ 22 м (0.0003° долготы на широте 52). */
function line(n: number, tags: Tags = {}, id = 1, startLon = 104, doc: OsmDocument = emptyDocument()): OsmDocument {
  const ids: number[] = []
  for (let i = 0; i < n; i++) {
    const nid = id * 1000 + i
    // узлы с одинаковой долготой совпадают по id, чтобы дороги могли делить узел
    doc.nodes.set(nid, { id: nid, lat: 52, lon: startLon + i * 0.0003, tags: {}, meta: {} })
    ids.push(nid)
  }
  doc.ways.set(id, { id, nodes: ids, tags: { highway: 'primary', ...tags }, meta: {} })
  return doc
}

describe('высоты', () => {
  it('без ele, моста и тоннеля — ноль', () => {
    const doc = line(5)
    expect(wayElevations(doc, doc.ways.get(1)!)).toEqual([0, 0, 0, 0, 0])
  })

  it('мост поднимается плавно: концы 0, середина layer × высота уровня', () => {
    const doc = line(21, { bridge: 'yes', layer: '1' }) // ≈ 440 м
    const z = wayElevations(doc, doc.ways.get(1)!)
    expect(z[0]).toBe(0)
    expect(z.at(-1)).toBeCloseTo(0, 6)
    expect(z[10]).toBeCloseTo(LAYER_HEIGHT, 6)
    // плавность: монотонный подъём в первой половине, без скачков больше чем в половину высоты
    for (let i = 1; i <= 10; i++) {
      expect(z[i]).toBeGreaterThanOrEqual(z[i - 1])
      expect(z[i] - z[i - 1]).toBeLessThan(LAYER_HEIGHT / 2)
    }
  })

  it('layer=2 даёт двойную высоту, тоннель — отрицательную', () => {
    const b = line(21, { bridge: 'yes', layer: '2' })
    expect(wayElevations(b, b.ways.get(1)!)[10]).toBeCloseTo(2 * LAYER_HEIGHT, 6)
    const t = line(21, { tunnel: 'yes', layer: '-1' })
    expect(wayElevations(t, t.ways.get(1)!)[10]).toBeCloseTo(-LAYER_HEIGHT, 6)
  })

  it('продолжение моста в соседней дороге не проседает в стыке', () => {
    // два куска моста встык: у второго узел 0 совпадает с последним узлом первого
    const doc = line(11, { bridge: 'yes', layer: '1' }, 1)
    const first = doc.ways.get(1)!
    const joint = first.nodes.at(-1)!
    const lon0 = doc.nodes.get(joint)!.lon
    line(11, { bridge: 'yes', layer: '1' }, 2, lon0, doc)
    const second = doc.ways.get(2)!
    doc.nodes.delete(second.nodes[0])
    second.nodes[0] = joint // общий узел
    const ctx = elevationContext(doc)
    expect(wayElevations(doc, first, ctx).at(-1)).toBeCloseTo(LAYER_HEIGHT, 6)
    expect(wayElevations(doc, second, ctx)[0]).toBeCloseTo(LAYER_HEIGHT, 6)
    // без контекста (одиночная дорога) было бы 0
    expect(wayElevations(doc, first).at(-1)).toBeCloseTo(0, 6)
  })

  it('тег ele главнее: высоты интерполируются по расстоянию между известными узлами', () => {
    const doc = line(5, { bridge: 'yes' })
    const w = doc.ways.get(1)!
    doc.nodes.get(w.nodes[0])!.tags.ele = '100'
    doc.nodes.get(w.nodes[4])!.tags.ele = '108'
    const z = wayElevations(doc, w)
    expect(z[0]).toBe(100)
    expect(z[2]).toBeCloseTo(104, 1)
    expect(z[4]).toBe(108)
  })

  it('если ele известен лишь у части узлов, края держат ближайшее значение', () => {
    const doc = line(5)
    const w = doc.ways.get(1)!
    doc.nodes.get(w.nodes[2])!.tags.ele = '50'
    expect(wayElevations(doc, w)).toEqual([50, 50, 50, 50, 50])
  })

  it('smoothstep: 0, 1 и плавный ход', () => {
    expect(smoothstep(-1)).toBe(0)
    expect(smoothstep(2)).toBe(1)
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 6)
    expect(smoothstep(0.1)).toBeLessThan(0.1) // медленный старт
  })
})

describe('wayProfile', () => {
  it('мост из двух узлов получает промежуточные точки и плавный горб', () => {
    const doc = line(2, { bridge: 'yes', layer: '1' }) // один отрезок ≈ 22 м
    const p = wayProfile(doc, doc.ways.get(1)!, undefined, 4)
    expect(p.length).toBeGreaterThan(4)
    expect(p[0].id).toBeDefined()
    expect(p.at(-1)!.id).toBeDefined()
    expect(p.slice(1, -1).every((q) => q.id === undefined)).toBe(true)
    expect(p[0].z).toBe(0)
    expect(p.at(-1)!.z).toBeCloseTo(0, 6)
    expect(Math.max(...p.map((q) => q.z))).toBeGreaterThan(LAYER_HEIGHT * 0.5)
  })

  it('обычная дорога не дробится', () => {
    const doc = line(3)
    expect(wayProfile(doc, doc.ways.get(1)!)).toHaveLength(3)
  })
})

describe('setElevationRamp', () => {
  const make = () => {
    const s = new Store()
    s.load(line(5), 't.osm')
    return s
  }

  it('линейно пишет ele от начала к концу', () => {
    const s = make()
    setElevationRamp(s, 1, 10, 18)
    const w = s.doc.ways.get(1)!
    const z = w.nodes.map((id) => Number(s.doc.nodes.get(id)!.tags.ele))
    expect(z[0]).toBe(10)
    expect(z[4]).toBe(18)
    expect(z[2]).toBeCloseTo(14, 1)
    for (let i = 1; i < z.length; i++) expect(z[i]).toBeGreaterThan(z[i - 1])
    // и wayElevations читает то же самое
    expect(wayElevations(s.doc, w)[2]).toBeCloseTo(14, 1)
  })

  it('откатывается и сбрасывается', () => {
    const s = make()
    setElevationRamp(s, 1, 0, 5)
    s.undo()
    expect(s.doc.nodes.get(1000)!.tags.ele).toBeUndefined()
    setElevationRamp(s, 1, 0, 5)
    clearElevation(s, 1)
    expect(s.doc.ways.get(1)!.nodes.every((id) => s.doc.nodes.get(id)!.tags.ele === undefined)).toBe(true)
  })

  it('длина по узлам сходится с cumulativeDistance', () => {
    const doc = line(5)
    const d = cumulativeDistance(doc, doc.ways.get(1)!)
    expect(d[0]).toBe(0)
    expect(d[4]).toBeGreaterThan(70)
    expect(d[4]).toBeLessThan(100)
  })
})
