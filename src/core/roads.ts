import { distanceM } from './geo'
import type { OsmDocument, OsmNode, OsmWay, Tags } from './types'

/** Классы дорог для автомобилей (то, что нужно SUMO / MATSim / Webots). */
export const DRIVABLE = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential',
  'living_street', 'service', 'road',
])

export const PEDESTRIAN = new Set(['footway', 'steps', 'path', 'pedestrian', 'cycleway', 'track', 'crossing'])

export const isDrivable = (w: OsmWay) => DRIVABLE.has(w.tags.highway ?? '')
export const isHighway = (w: OsmWay) => w.tags.highway !== undefined

/** Цвет и толщина линии (в пикселях при масштабе по умолчанию) по классу дороги. */
export function roadStyle(highway: string | undefined): { color: string; width: number } {
  switch (highway) {
    case 'motorway': case 'trunk': return { color: '#e0605a', width: 6 }
    case 'primary': case 'primary_link': return { color: '#e89a3c', width: 5 }
    case 'secondary': case 'secondary_link': return { color: '#d9c441', width: 4 }
    case 'tertiary': case 'tertiary_link': return { color: '#6aa84f', width: 3.5 }
    case 'residential': case 'unclassified': case 'living_street': return { color: '#4a6fa5', width: 3 }
    case 'service': return { color: '#7b8794', width: 2 }
    case 'footway': case 'steps': case 'path': case 'pedestrian': case 'cycleway': case 'crossing':
      return { color: '#b5838d', width: 1 }
    default: return { color: '#9aa0a6', width: 1.5 }
  }
}

/** Направление движения: 1 — по порядку узлов, -1 — против, 0 — в обе стороны. */
export function onewayDirection(w: OsmWay): 1 | -1 | 0 {
  const v = w.tags.oneway
  if (v === 'yes' || v === 'true' || v === '1') return 1
  if (v === '-1' || v === 'reverse') return -1
  if (v === 'no') return 0
  // по правилам OSM кольцо и магистраль односторонние, если не указано иное
  if (w.tags.junction === 'roundabout') return 1
  if (w.tags.highway === 'motorway' || w.tags.highway === 'motorway_link') return 1
  return 0
}

// ---------- скоростное ограничение ----------

export interface SpeedInfo {
  /** км/ч; null — ограничения нет (`maxspeed=none`) или оно неизвестно */
  kmh: number | null
  /** tag — задано числом/в милях; zone — по зоне (RU:urban); default — в OSM не задано, взято по классу дороги */
  source: 'tag' | 'zone' | 'default'
  /** исходное значение тега maxspeed */
  raw?: string
  forward?: number | null
  backward?: number | null
}

/** Скорости по классу дороги, которые SUMO подставляет, если maxspeed не задан (data/typemap/osmNetconvert.typ.xml). */
export const SUMO_DEFAULT_KMH: Record<string, number> = {
  motorway: 142, trunk: 100, primary: 100, secondary: 100, tertiary: 80,
  motorway_link: 80, trunk_link: 80, primary_link: 80, secondary_link: 80, tertiary_link: 80,
  unclassified: 50, residential: 50, living_street: 10, service: 20,
}

/** Скорости по зонам OSM (maxspeed=RU:urban). Другие страны не известны — вернётся null. */
const ZONE_KMH: Record<string, number> = { 'RU:urban': 60, 'RU:rural': 90, 'RU:motorway': 110, 'RU:living_street': 20 }

function parseSpeed(v: string | undefined): { kmh: number | null; zone: boolean } | undefined {
  if (v === undefined) return undefined
  const t = v.trim()
  if (t === 'none') return { kmh: null, zone: false }
  if (t === 'walk') return { kmh: 7, zone: false }
  const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h)?$/.exec(t)
  if (m) return { kmh: Math.round(m[2] === 'mph' ? Number(m[1]) * 1.609344 : Number(m[1])), zone: false }
  if (t in ZONE_KMH) return { kmh: ZONE_KMH[t], zone: true }
  return undefined
}

/** Ограничение скорости на дороге: по тегам maxspeed, maxspeed:forward/backward, иначе по классу. */
export function speedLimit(way: OsmWay): SpeedInfo {
  const raw = way.tags.maxspeed
  const f = parseSpeed(way.tags['maxspeed:forward']), b = parseSpeed(way.tags['maxspeed:backward'])
  const main = parseSpeed(raw)
  const dir = { forward: f?.kmh, backward: b?.kmh }
  if (main) return { kmh: main.kmh, source: main.zone ? 'zone' : 'tag', raw, ...dir }
  if (f || b) return { kmh: (f ?? b)!.kmh, source: 'tag', raw: way.tags['maxspeed:forward'] ?? way.tags['maxspeed:backward'], ...dir }
  return { kmh: SUMO_DEFAULT_KMH[way.tags.highway ?? ''] ?? null, source: 'default', raw }
}

/** Середина дороги по длине (для подписи на карте). */
export function wayMidpoint(doc: OsmDocument, way: OsmWay): { lat: number; lon: number } | null {
  const pts = way.nodes.map((id) => doc.nodes.get(id)).filter((n): n is OsmNode => !!n)
  if (!pts.length) return null
  if (pts.length === 1) return { lat: pts[0].lat, lon: pts[0].lon }
  let total = 0
  for (let i = 1; i < pts.length; i++) total += distanceM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon)
  let left = total / 2
  for (let i = 1; i < pts.length; i++) {
    const seg = distanceM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon)
    if (left <= seg || i === pts.length - 1) {
      const t = seg > 0 ? Math.min(1, left / seg) : 0
      return { lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t, lon: pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * t }
    }
    left -= seg
  }
  return null
}

// ---------- полосы ----------

export interface LaneInfo {
  /** общее число полос (в обе стороны) */
  total: number
  twoWay: boolean
  /** сколько полос слева от встречной линии, если дорога двусторонняя и место линии известно; иначе null */
  centerAfter: number | null
  /** число полос задано тегом (lanes / lanes:forward / lanes:backward), а не угадано по умолчанию */
  explicit: boolean
}

const posInt = (v?: string) => {
  const n = parseInt(v ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Число полос и положение встречной линии. Правостороннее движение: встречные полосы слева по ходу дороги,
 * попутные справа (OSM: lanes:forward идёт вправо, lanes:backward — влево).
 * Если тегов нет: односторонняя дорога — 1 полоса, двусторонняя — по полосе в каждую сторону,
 * а служебные проезды и жилые зоны — одна полоса без разметки.
 */
export function laneInfo(way: OsmWay): LaneInfo | null {
  if (!isDrivable(way)) return null
  const oneway = onewayDirection(way) !== 0
  const L = posInt(way.tags.lanes), F = posInt(way.tags['lanes:forward']), B = posInt(way.tags['lanes:backward'])
  const hw = way.tags.highway ?? ''
  const narrow = hw === 'service' || hw === 'living_street'

  let total = L ?? (F || B ? (F ?? 0) + (B ?? 0) : oneway || narrow ? 1 : 2)
  total = Math.min(10, Math.max(1, total))
  const explicit = L !== undefined || F !== undefined || B !== undefined

  let centerAfter: number | null = null
  if (!oneway && total >= 2) {
    if (B !== undefined && B >= 1 && B < total) centerAfter = B
    else if (F !== undefined && F >= 1 && F < total) centerAfter = total - F
    else if (total % 2 === 0) centerAfter = total / 2
  }
  return { total, twoWay: !oneway, centerAfter, explicit }
}

// ---------- светофоры и пешеходные переходы (теги узла) ----------

/** Узел со светофором: highway=traffic_signals. */
export const hasSignal = (t: Tags) => t.highway === 'traffic_signals'

/** Узел с пешеходным переходом: highway=crossing или тег crossing=* (в том числе у светофора: crossing=traffic_signals). */
export const hasCrossing = (t: Tags) => t.highway === 'crossing' || (t.crossing !== undefined && t.crossing !== 'no')

// ---------- трамвайные пути ----------

/** Трамвайные пути (railway=tram). Не дорога для машин, но часть транспортной сети для симулятора. */
export const isTram = (w: OsmWay) => w.tags.railway === 'tram'

// ---------- русские названия классов дорог ----------

export const HIGHWAY_LABELS: Record<string, string> = {
  motorway: 'Автомагистраль',
  trunk: 'Скоростная дорога',
  primary: 'Магистральная улица',
  secondary: 'Улица районного значения',
  tertiary: 'Улица местного значения',
  residential: 'Жилая улица',
  unclassified: 'Прочая дорога',
  service: 'Проезд',
  living_street: 'Жилая зона',
  primary_link: 'Съезд с магистральной',
  secondary_link: 'Съезд с районной',
  tertiary_link: 'Съезд с местной',
  footway: 'Пешеходная дорожка',
  pedestrian: 'Пешеходная улица',
  steps: 'Лестница',
  path: 'Тропинка',
  cycleway: 'Велодорожка',
}

/** Человеческое название дороги: «Жилая улица», «Пешеходный переход», «Трамвайные пути». */
export function wayKindLabel(w: OsmWay): string {
  if (isTram(w)) return 'Трамвайные пути'
  if (w.tags.highway === 'footway' && w.tags.footway === 'crossing') return 'Пешеходный переход'
  const hw = w.tags.highway
  return hw ? HIGHWAY_LABELS[hw] ?? hw : 'Линия'
}
