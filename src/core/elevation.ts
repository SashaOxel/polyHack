import { distanceM } from './geo'
import { wayLevel } from './roads'
import type { OsmDocument, OsmNode, OsmWay } from './types'

/**
 * ВЫСОТЫ (ось Z). В OSM высота узла — тег `ele` (метры). Если у узлов дороги `ele` нет,
 * считаем по правилам OSM: мост поднимается на layer × LAYER_HEIGHT, тоннель опускается.
 * Подъём плавный: у концов моста высота нарастает по сглаженной кривой, а не скачком.
 */

export const LAYER_HEIGHT = 6 // метров на один уровень (layer=1)
const MAX_RAMP = 60 // длина въезда на мост, м

const isOn = (v?: string) => v !== undefined && v !== 'no'

export function parseEle(n: OsmNode): number | undefined {
  const v = parseFloat(n.tags.ele ?? '')
  return Number.isFinite(v) ? v : undefined
}

/** Сглаженная ступенька: 0 при t≤0, 1 при t≥1, без «излома» на концах. */
export const smoothstep = (t: number) => {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

/** Накопленное расстояние вдоль дороги до каждого узла, метры. */
export function cumulativeDistance(doc: OsmDocument, way: OsmWay): number[] {
  const d = [0]
  for (let i = 1; i < way.nodes.length; i++) {
    const a = doc.nodes.get(way.nodes[i - 1]), b = doc.nodes.get(way.nodes[i])
    d.push(d[i - 1] + (a && b ? distanceM(a.lat, a.lon, b.lat, b.lon) : 0))
  }
  return d
}

export interface ElevationContext {
  /** сколько дорог «на другом уровне» (мост/тоннель) проходит через узел */
  levelCount: Map<number, number>
}

/** Один раз на документ: нужен, чтобы соседние куски одного моста не проседали в стыке. */
export function elevationContext(doc: OsmDocument): ElevationContext {
  const levelCount = new Map<number, number>()
  for (const w of doc.ways.values()) {
    if (wayLevel(w) === 'ground') continue
    for (const id of new Set(w.nodes)) levelCount.set(id, (levelCount.get(id) ?? 0) + 1)
  }
  return { levelCount }
}

/** Линейная интерполяция известных высот по расстоянию; за краями держим ближайшее известное значение. */
function interpolate(d: number[], ele: (number | undefined)[]): number[] {
  const known = ele.map((e, i) => (e === undefined ? -1 : i)).filter((i) => i >= 0)
  return d.map((di, i) => {
    if (ele[i] !== undefined) return ele[i]!
    const before = [...known].reverse().find((k) => k < i)
    const after = known.find((k) => k > i)
    if (before === undefined) return ele[after!]!
    if (after === undefined) return ele[before]!
    const span = d[after] - d[before]
    const t = span > 0 ? (di - d[before]) / span : (i - before) / (after - before)
    return ele[before]! + (ele[after]! - ele[before]!) * t
  })
}

/**
 * Профиль высоты моста/тоннеля без тегов ele: функция «расстояние от начала → высота».
 * null, если дорога не на другом уровне.
 */
function levelProfile(way: OsmWay, total: number, ctx?: ElevationContext): ((d: number) => number) | null {
  const kind = wayLevel(way)
  const bridge = kind === 'bridge', tunnel = kind === 'tunnel'
  if ((!bridge && !tunnel) || total < 1) return null
  const layer = parseInt(way.tags.layer ?? '', 10)
  const level = bridge ? (layer > 0 ? layer : 1) : -(layer < 0 ? -layer : 1)
  const H = level * LAYER_HEIGHT
  const ramp = Math.min(MAX_RAMP, total * 0.4)
  const shared = (id: number) => (ctx?.levelCount.get(id) ?? 0) > 1 // продолжение моста — не опускаем
  const rampStart = !shared(way.nodes[0]), rampEnd = !shared(way.nodes[way.nodes.length - 1])
  return (d) => {
    const up = rampStart ? smoothstep(d / ramp) : 1
    const down = rampEnd ? smoothstep((total - d) / ramp) : 1
    return H * Math.min(up, down)
  }
}

const knownEle = (doc: OsmDocument, way: OsmWay) =>
  way.nodes.map((id) => {
    const n = doc.nodes.get(id)
    return n ? parseEle(n) : undefined
  })

/** Высота каждого узла дороги, метры (массив в порядке way.nodes). */
export function wayElevations(doc: OsmDocument, way: OsmWay, ctx?: ElevationContext): number[] {
  const d = cumulativeDistance(doc, way)
  const ele = knownEle(doc, way)
  if (ele.some((e) => e !== undefined)) return interpolate(d, ele)
  const prof = levelProfile(way, d[d.length - 1], ctx)
  return prof ? d.map(prof) : way.nodes.map(() => 0)
}

export interface ProfilePoint {
  lat: number
  lon: number
  z: number
  /** id узла OSM; у добавленных промежуточных точек его нет */
  id?: number
}

/**
 * Дорога как ломаная с высотами для рисования. Мост из двух узлов (концов) в OSM — прямой отрезок,
 * поэтому на мостах и в тоннелях досыпаем промежуточные точки (шаг `step` м), иначе плавный подъём не нарисовать.
 */
export function wayProfile(doc: OsmDocument, way: OsmWay, ctx?: ElevationContext, step = 8): ProfilePoint[] {
  const d = cumulativeDistance(doc, way)
  const z = wayElevations(doc, way, ctx)
  const prof = knownEle(doc, way).some((e) => e !== undefined) ? null : levelProfile(way, d[d.length - 1], ctx)
  const out: ProfilePoint[] = []
  let prev = -1
  way.nodes.forEach((id, i) => {
    const n = doc.nodes.get(id)
    if (!n) return
    if (prof && prev >= 0) {
      const a = doc.nodes.get(way.nodes[prev])!
      const len = d[i] - d[prev]
      const pieces = Math.min(200, Math.ceil(len / step))
      for (let j = 1; j < pieces; j++) {
        const t = j / pieces
        out.push({ lat: a.lat + (n.lat - a.lat) * t, lon: a.lon + (n.lon - a.lon) * t, z: prof(d[prev] + len * t) })
      }
    }
    out.push({ lat: n.lat, lon: n.lon, z: z[i], id })
    prev = i
  })
  return out
}
