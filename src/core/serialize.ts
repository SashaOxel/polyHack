import { linkedStop } from './stops'
import { DRIVABLE, PEDESTRIAN } from './roads'
import type { Meta, OsmDocument, OsmNode, OsmRelation, OsmWay, Tags } from './types'

export interface ExportOptions {
  /**
   * Сохранить только дорожную сеть: дороги для машин (+ пешеходные при includePedestrian),
   * их узлы и relations типа restriction, у которых остались все участники.
   * Здания, маршруты общественного транспорта и прочее отбрасываются.
   */
  onlyRoads?: boolean
  includePedestrian?: boolean
  /** Писать служебные атрибуты (user, changeset, timestamp...). Для симуляторов не нужны. */
  keepMeta?: boolean
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;')

const attrs = (meta: Meta, keep: boolean) =>
  keep ? Object.entries(meta).map(([k, v]) => ` ${k}="${esc(v)}"`).join('') : ''

const tagLines = (tags: Tags) =>
  Object.entries(tags).map(([k, v]) => `   <tag k="${esc(k)}" v="${esc(v)}"/>\n`).join('')

/** Выбор подмножества документа по опциям экспорта. */
export function selectForExport(doc: OsmDocument, opts: ExportOptions) {
  if (!opts.onlyRoads) {
    return { nodes: [...doc.nodes.values()], ways: [...doc.ways.values()], relations: [...doc.relations.values()] }
  }
  const ways: OsmWay[] = []
  const used = new Set<number>()
  for (const w of doc.ways.values()) {
    const hw = w.tags.highway
    if (!hw) continue
    if (DRIVABLE.has(hw) || (opts.includePedestrian && PEDESTRIAN.has(hw))) {
      ways.push(w)
      for (const n of w.nodes) used.add(n)
    }
  }
  const wayIds = new Set(ways.map((w) => w.id))
  const relations: OsmRelation[] = []
  for (const r of doc.relations.values()) {
    const stop = linkedStop(r)
    if (stop && used.has(stop.anchor) && doc.nodes.has(stop.platform)) {
      used.add(stop.platform)
      relations.push(r)
      continue
    }
    if (r.tags.type !== 'restriction') continue
    const ok = r.members.every((m) => (m.type === 'way' ? wayIds.has(m.ref) : m.type === 'node' ? used.has(m.ref) : false))
    if (ok) relations.push(r)
  }
  const nodes = [...used].map(id => doc.nodes.get(id)).filter((n): n is OsmNode => !!n)
  return { nodes, ways, relations }
}

/** Запись модели обратно в текст .osm (XML 0.6). Порядок: nodes, ways, relations. */
export function serializeOsm(doc: OsmDocument, opts: ExportOptions = {}): string {
  const keep = opts.keepMeta ?? true
  const { nodes, ways, relations } = selectForExport(doc, opts)
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n']

  const root = { ...doc.rootAttrs, generator: 'uds-editor' }
  out.push(`<osm${Object.entries(root).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}>\n`)

  if (doc.bounds) {
    const b = doc.bounds
    out.push(` <bounds minlat="${b.minlat}" minlon="${b.minlon}" maxlat="${b.maxlat}" maxlon="${b.maxlon}"/>\n`)
  }

  for (const n of nodes) {
    const head = ` <node id="${n.id}"${attrs(n.meta, keep)} lat="${n.lat}" lon="${n.lon}"`
    const t = tagLines(n.tags)
    out.push(t ? `${head}>\n${t} </node>\n` : `${head}/>\n`)
  }
  for (const w of ways) {
    out.push(` <way id="${w.id}"${attrs(w.meta, keep)}>\n`)
    for (const ref of w.nodes) out.push(`  <nd ref="${ref}"/>\n`)
    out.push(tagLines(w.tags), ' </way>\n')
  }
  for (const r of relations) {
    out.push(` <relation id="${r.id}"${attrs(r.meta, keep)}>\n`)
    for (const m of r.members) out.push(`  <member type="${m.type}" ref="${m.ref}" role="${esc(m.role)}"/>\n`)
    out.push(tagLines(r.tags), ' </relation>\n')
  }
  out.push('</osm>\n')
  return out.join('')
}
