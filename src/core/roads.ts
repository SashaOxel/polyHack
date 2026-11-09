import type { OsmWay } from './types'

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
