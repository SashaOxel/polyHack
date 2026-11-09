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
}

export const ROAD_TEMPLATES: RoadTemplate[] = [
  { name: 'Магистраль, 3 полосы', tags: { highway: 'primary', lanes: '3', maxspeed: '60' }, forDrawing: true },
  { name: 'Улица, 2 полосы', tags: { highway: 'secondary', lanes: '2', maxspeed: '60' }, forDrawing: true },
  { name: 'Жилая улица', tags: { highway: 'residential', lanes: '2', maxspeed: '40' }, forDrawing: true },
  { name: 'Односторонняя, 2 полосы', tags: { highway: 'secondary', lanes: '2', oneway: 'yes', maxspeed: '60' }, forDrawing: true },
  { name: 'Проезд / двор', tags: { highway: 'service', maxspeed: '20' }, forDrawing: true },
  { name: 'Мост', tags: { bridge: 'yes', layer: '1' }, forDrawing: false },
]

export const DRAW_TEMPLATES = ROAD_TEMPLATES.filter((t) => t.forDrawing)
