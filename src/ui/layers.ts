/** Слои карты: что рисовать. Каждый слой включается/выключается кнопкой на карте. */
export interface Layers {
  tiles: boolean
  car: boolean
  pedestrian: boolean
  tram: boolean
  lanes: boolean
  signals: boolean
  crossings: boolean
  signs: boolean
  stops: boolean
  nodeIds: boolean
  issues: boolean
  parking: boolean
  heat: boolean
  reach: boolean
}

export const DEFAULT_LAYERS: Layers = {
  tiles: true, car: true, pedestrian: true, tram: true, lanes: true,
  signals: true, crossings: true, signs: true, stops: true, nodeIds: false, issues: true, parking: true, heat: true, reach: false,
}

export const LAYER_LIST: { key: keyof Layers; label: string }[] = [
  { key: 'car', label: 'Дороги для машин' },
  { key: 'pedestrian', label: 'Пешеходные' },
  { key: 'tram', label: 'Трамвайные пути' },
  { key: 'lanes', label: 'Разметка полос' },
  { key: 'signals', label: 'Светофоры' },
  { key: 'crossings', label: 'Переходы' },
  { key: 'signs', label: 'Знаки приоритета' },
  { key: 'stops', label: 'Остановки' },
  { key: 'parking', label: 'Парковки' },
  { key: 'heat', label: 'Загруженность' },
  { key: 'reach', label: 'Недостижимые участки' },
  { key: 'issues', label: 'Проблемы' },
  { key: 'nodeIds', label: 'Номера узлов' },
  { key: 'tiles', label: 'Подложка' },
]
