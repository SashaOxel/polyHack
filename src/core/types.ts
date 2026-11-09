/**
 * КОНТРАКТ ЯДРА. Все модули (карта, инструменты, панели, валидатор, 3D)
 * работают с этими типами. Менять только по договорённости с командой.
 */

export type Tags = Record<string, string>

/** Служебные атрибуты OSM (version, changeset, user, ...), сохраняем «как есть». */
export type Meta = Record<string, string>

export interface OsmNode {
  id: number
  lat: number
  lon: number
  tags: Tags
  meta: Meta
}

export interface OsmWay {
  id: number
  /** id узлов по порядку */
  nodes: number[]
  tags: Tags
  meta: Meta
}

export interface OsmMember {
  type: 'node' | 'way' | 'relation'
  ref: number
  role: string
}

export interface OsmRelation {
  id: number
  members: OsmMember[]
  tags: Tags
  meta: Meta
}

export interface Bounds {
  minlat: number
  minlon: number
  maxlat: number
  maxlon: number
}

export interface OsmDocument {
  /** атрибуты корня <osm> (version, generator, ...) */
  rootAttrs: Record<string, string>
  bounds?: Bounds
  nodes: Map<number, OsmNode>
  ways: Map<number, OsmWay>
  relations: Map<number, OsmRelation>
}

export type ElementKind = 'node' | 'way' | 'relation' | 'marker'

/**
 * Маркер «только UI»: светофор или пешеходный переход, нарисованный в редакторе.
 * Живёт в store.markers, а не в OsmDocument, поэтому НИКОГДА не попадает в .osm.
 */
export interface Marker {
  id: number
  kind: 'signal' | 'crossing'
  lat: number
  lon: number
  /** направление дороги в этой точке, радианы, в системе «север вверх» (восток = 0, север = π/2) */
  angle: number
  wayId?: number
}

export interface ElementRef {
  kind: ElementKind
  id: number
}

export function emptyDocument(): OsmDocument {
  return {
    rootAttrs: { version: '0.6', generator: 'uds-editor' },
    nodes: new Map(),
    ways: new Map(),
    relations: new Map(),
  }
}
