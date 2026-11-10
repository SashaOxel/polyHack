import type { Tags } from './types'

/**
 * Шаблоны дорог: один набор тегов на один клик. Используются в панели атрибутов
 * (применить к выбранной дороге) и в инструменте рисования (теги новой дороги).
 * Добавляйте свои сюда.
 */
export interface RoadTemplate {
  name: string
  tags: Tags
  /** показывать в списке для рисования новых дорог (мост — это дополнение, а не отдельная дорога) */
  forDrawing: boolean
  /** car — для машин, foot — пешеходная (в симулятор по умолчанию не идёт, в экспорте включается отдельной галочкой) */
  group?: 'car' | 'foot' | 'rail'
}

export const ROAD_TEMPLATES: RoadTemplate[] = [
  { name: 'Магистраль, 3 полосы', tags: { highway: 'primary', lanes: '3', maxspeed: '60' }, forDrawing: true },
  { name: 'Улица, 2 полосы', tags: { highway: 'secondary', lanes: '2', maxspeed: '60' }, forDrawing: true },
  { name: 'Жилая улица', tags: { highway: 'residential', lanes: '2', maxspeed: '40' }, forDrawing: true },
  { name: 'Односторонняя, 2 полосы', tags: { highway: 'secondary', lanes: '2', oneway: 'yes', maxspeed: '60' }, forDrawing: true },
  { name: 'Проезд во дворе', tags: { highway: 'service', maxspeed: '20' }, forDrawing: true },
  { name: 'Мост', tags: { bridge: 'yes', layer: '1' }, forDrawing: false },
  { name: 'Тоннель', tags: { tunnel: 'yes', layer: '-1' }, forDrawing: false },
  // пешеходные дороги
  { name: 'Пешеходная дорожка', tags: { highway: 'footway' }, forDrawing: true, group: 'foot' },
  { name: 'Пешеходная улица', tags: { highway: 'pedestrian' }, forDrawing: true, group: 'foot' },
  { name: 'Лестница', tags: { highway: 'steps' }, forDrawing: true, group: 'foot' },
  // «зебра» как дорожка поперёк проезжей части: SUMO строит по ней пешеходный переход (концы — на узлах дороги)
  { name: 'Пешеходный переход', tags: { highway: 'footway', footway: 'crossing' }, forDrawing: true, group: 'foot' },
  { name: 'Надземный переход', tags: { highway: 'footway', bridge: 'yes', layer: '1' }, forDrawing: true, group: 'foot' },
  { name: 'Подземный переход', tags: { highway: 'footway', tunnel: 'yes', layer: '-1' }, forDrawing: true, group: 'foot' },
  // рельсовый транспорт
  { name: 'Трамвайные пути', tags: { railway: 'tram', gauge: '1524', electrified: 'contact_line' }, forDrawing: true, group: 'rail' },
]

export const DRAW_TEMPLATES = ROAD_TEMPLATES.filter((t) => t.forDrawing)

/** Пешеходная ли дорога по шаблону (для автоматического показа пешеходных и включения в экспорт). */
export const isFootTemplate = (t: RoadTemplate | undefined) => t?.group === 'foot'
export const isRailTemplate = (t: RoadTemplate | undefined) => t?.group === 'rail'

/** Уровень новой дороги при рисовании: теги, которые добавляются к шаблону. */
export const LEVEL_TAGS: Record<'ground' | 'bridge' | 'tunnel', Tags> = {
  ground: {},
  bridge: { bridge: 'yes', layer: '1' },
  tunnel: { tunnel: 'yes', layer: '-1' },
}
