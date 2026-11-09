import { XMLParser } from 'fast-xml-parser'
import type { Meta, OsmDocument, OsmMember, Tags } from './types'
import { emptyDocument } from './types'

const ATTR = '@_'

function splitAttrs(raw: Record<string, unknown>, skip: string[]): Meta {
  const meta: Meta = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith(ATTR)) continue
    const name = k.slice(ATTR.length)
    if (skip.includes(name)) continue
    meta[name] = String(v)
  }
  return meta
}

function readTags(raw: unknown): Tags {
  const tags: Tags = {}
  if (!raw) return tags
  const list = Array.isArray(raw) ? raw : [raw]
  for (const t of list as Record<string, unknown>[]) {
    tags[String(t[ATTR + 'k'])] = String(t[ATTR + 'v'])
  }
  return tags
}

const asArray = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x])

/** Разбор текста .osm (XML 0.6) в модель. Работает и в браузере, и в Node. */
export function parseOsm(xml: string): OsmDocument {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR,
    parseAttributeValue: false,
    parseTagValue: false,
    isArray: (name) => ['node', 'way', 'relation', 'tag', 'nd', 'member'].includes(name),
  })
  const root = parser.parse(xml)?.osm
  if (!root) throw new Error('Это не файл OSM: не найден корневой элемент <osm>')

  const doc = emptyDocument()
  doc.rootAttrs = splitAttrs(root, [])

  if (root.bounds) {
    const b = root.bounds
    doc.bounds = {
      minlat: +b[ATTR + 'minlat'],
      minlon: +b[ATTR + 'minlon'],
      maxlat: +b[ATTR + 'maxlat'],
      maxlon: +b[ATTR + 'maxlon'],
    }
  }

  for (const n of asArray<Record<string, unknown>>(root.node)) {
    const id = +(n[ATTR + 'id'] as string)
    doc.nodes.set(id, {
      id,
      lat: +(n[ATTR + 'lat'] as string),
      lon: +(n[ATTR + 'lon'] as string),
      tags: readTags(n.tag),
      meta: splitAttrs(n, ['id', 'lat', 'lon']),
    })
  }

  for (const w of asArray<Record<string, unknown>>(root.way)) {
    const id = +(w[ATTR + 'id'] as string)
    doc.ways.set(id, {
      id,
      nodes: asArray<Record<string, unknown>>(w.nd as never).map((nd) => +(nd[ATTR + 'ref'] as string)),
      tags: readTags(w.tag),
      meta: splitAttrs(w, ['id']),
    })
  }

  for (const r of asArray<Record<string, unknown>>(root.relation)) {
    const id = +(r[ATTR + 'id'] as string)
    const members: OsmMember[] = asArray<Record<string, unknown>>(r.member as never).map((m) => ({
      type: m[ATTR + 'type'] as OsmMember['type'],
      ref: +(m[ATTR + 'ref'] as string),
      role: String(m[ATTR + 'role'] ?? ''),
    }))
    doc.relations.set(id, { id, members, tags: readTags(r.tag), meta: splitAttrs(r, ['id']) })
  }

  return doc
}
