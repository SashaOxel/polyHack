import { distanceM, nearestOnSegment, project } from './geo'
import { isDrivable } from './roads'
import type { OsmDocument, OsmWay, Tags } from './types'

/**
 * ЗНАКИ ПРИОРИТЕТА (ПДД РФ) — реальные теги OSM на узле дороги:
 *  - 2.1 «Главная дорога»      — traffic_sign=RU:2.1 (отдельного highway-тега у знака нет);
 *  - 2.4 «Уступите дорогу»     — highway=give_way + traffic_sign=RU:2.4 (так помечается второстепенная дорога);
 *  - 2.5 «Движение без остановки запрещено» (STOP) — highway=stop + traffic_sign=RU:2.5.
 * direction=forward|backward — для какого направления движения вдоль дороги знак действует
 * (forward — по порядку узлов дороги). У односторонних дорог направление не указываем.
 */
export type SignKind = 'priority' | 'giveway' | 'stop'

export const SIGNS: Record<SignKind, { code: string; label: string; short: string; tags: Tags }> = {
  priority: { code: '2.1', label: 'Главная дорога', short: 'Главная', tags: { traffic_sign: 'RU:2.1' } },
  giveway: { code: '2.4', label: 'Уступите дорогу (второстепенная)', short: 'Уступи', tags: { highway: 'give_way', traffic_sign: 'RU:2.4' } },
  stop: { code: '2.5', label: 'Стоп (движение без остановки запрещено)', short: 'Стоп', tags: { highway: 'stop', traffic_sign: 'RU:2.5' } },
}

export interface SignInfo { kind: SignKind; direction?: 'forward' | 'backward' }

export function readSign(tags: Tags): SignInfo | undefined {
  let kind: SignKind | undefined
  if (tags.highway === 'give_way') kind = 'giveway'
  else if (tags.highway === 'stop') kind = 'stop'
  else if (tags.traffic_sign && /(^|[;:])(RU:)?2\.1($|[;\[])/.test(tags.traffic_sign)) kind = 'priority'
  if (!kind) return undefined
  const d = tags.direction
  return { kind, direction: d === 'forward' || d === 'backward' ? d : undefined }
}

/** Теги узла со знаком: чистим прежний знак и пишем новый. */
export function signTags(tags: Tags, kind: SignKind, direction?: 'forward' | 'backward'): Tags {
  const t = { ...removeSignTags(tags), ...SIGNS[kind].tags }
  if (direction) t.direction = direction
  return t
}

export function removeSignTags(tags: Tags): Tags {
  const t = { ...tags }
  const old = readSign(t)
  if (!old) return t
  if (t.highway === 'give_way' || t.highway === 'stop') delete t.highway
  delete t.traffic_sign
  delete t.direction
  return t
}

/** Занят ли узел другим highway-тегом (светофор, переход, остановка…) — знак give_way/stop туда не поставить. */
export const blocksSign = (tags: Tags, kind: SignKind) =>
  kind !== 'priority' && tags.highway !== undefined && tags.highway !== 'give_way' && tags.highway !== 'stop'

/** Автомобильные дороги, проходящие через узел. */
export function driveWaysAt(doc: OsmDocument, nodeId: number): OsmWay[] {
  return [...doc.ways.values()].filter((w) => isDrivable(w) && w.nodes.includes(nodeId))
}

/**
 * Направление знака: он стоит перед ближайшим перекрёстком (узел, общий с другой дорогой) или концом дороги
 * и «смотрит» на него — то есть действует для движения К перекрёстку.
 * at — либо индекс узла дороги, либо точка на отрезке между узлами (before — индекс узла перед точкой, share — доля пути).
 */
export function approachDirection(
  doc: OsmDocument, way: OsmWay, at: { node: number } | { lat: number; lon: number },
): 'forward' | 'backward' {
  const pts = way.nodes.map((id) => doc.nodes.get(id))
  const cum: number[] = [0]
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    cum.push(cum[i - 1] + (a && b ? distanceM(a.lat, a.lon, b.lat, b.lon) : 0))
  }
  let pos = 0
  if ('node' in at) pos = cum[Math.max(0, way.nodes.indexOf(at.node))]
  else {
    const p = project(at.lat, at.lon)
    let best = Infinity
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1]
      if (!a || !b) continue
      const A = project(a.lat, a.lon), B = project(b.lat, b.lon)
      const r = nearestOnSegment(p, A, B)
      if (r.dist < best) { best = r.dist; pos = cum[i] + Math.hypot(r.x - A.x, r.y - A.y) }
    }
  }
  // перекрёстки: узлы, где дорога пересекается с другой автомобильной, плюс оба конца
  const shared = new Set<number>()
  for (const w of doc.ways.values()) {
    if (w === way || !isDrivable(w)) continue
    for (const id of w.nodes) shared.add(id)
  }
  // настоящие перекрёстки важнее тупиков: концы дороги учитываем, только если перекрёстков на ней нет
  const hasJunction = way.nodes.some((id) => shared.has(id))
  let target = -1, dist = Infinity
  way.nodes.forEach((id, i) => {
    if (!(shared.has(id) || (!hasJunction && (i === 0 || i === way.nodes.length - 1)))) return
    const d = Math.abs(cum[i] - pos)
    if (d < dist - 0.01) { dist = d; target = i }
  })
  if (target < 0) return 'forward'
  if (Math.abs(cum[target] - pos) < 0.01) return target === 0 ? 'backward' : 'forward'
  return cum[target] > pos ? 'forward' : 'backward'
}
