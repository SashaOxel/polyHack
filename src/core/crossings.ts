import { project, unproject } from './geo'
import { isDrivable, wayLevel } from './roads'
import type { OsmDocument } from './types'

/**
 * Дороги для машин, которые пересекаются посреди отрезков без общего узла, на одном уровне
 * (мост/тоннель и разные `layer` не считаются). В реальности это либо перекрёсток, который не «склеен» в OSM
 * (машины не смогут повернуть), либо путепровод без тегов. Решает человек.
 */
export interface Crossing {
  a: number
  b: number
  lat: number
  lon: number
}

interface Seg { id: number; level: string; layer: string; ax: number; ay: number; bx: number; by: number }

export function findCrossings(doc: OsmDocument): Crossing[] {
  const segs: Seg[] = []
  for (const w of doc.ways.values()) {
    if (!isDrivable(w)) continue
    const level = wayLevel(w), layer = w.tags.layer ?? '0'
    for (let i = 1; i < w.nodes.length; i++) {
      const p = doc.nodes.get(w.nodes[i - 1]), q = doc.nodes.get(w.nodes[i])
      if (!p || !q) continue
      const A = project(p.lat, p.lon), B = project(q.lat, q.lon)
      segs.push({ id: w.id, level, layer, ax: A.x, ay: A.y, bx: B.x, by: B.y })
    }
  }
  const cell = 60
  const grid = new Map<string, Seg[]>()
  for (const s of segs) {
    const x0 = Math.floor(Math.min(s.ax, s.bx) / cell), x1 = Math.floor(Math.max(s.ax, s.bx) / cell)
    const y0 = Math.floor(Math.min(s.ay, s.by) / cell), y1 = Math.floor(Math.max(s.ay, s.by) / cell)
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = `${x},${y}`
      const list = grid.get(k)
      if (list) list.push(s); else grid.set(k, [s])
    }
  }
  const seen = new Set<string>()
  const out: Crossing[] = []
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const p = list[i], q = list[j]
      if (p.id === q.id || p.level !== q.level || p.layer !== q.layer) continue
      const key = p.id < q.id ? `${p.id}-${q.id}` : `${q.id}-${p.id}`
      if (seen.has(key)) continue
      // p + t·(p.b − p.a) = q + u·(q.b − q.a); d — векторное произведение направлений
      const d = (p.bx - p.ax) * (q.by - q.ay) - (p.by - p.ay) * (q.bx - q.ax)
      if (Math.abs(d) < 1e-9) continue
      const t = ((q.ax - p.ax) * (q.by - q.ay) - (q.ay - p.ay) * (q.bx - q.ax)) / d
      const u = ((q.ax - p.ax) * (p.by - p.ay) - (q.ay - p.ay) * (p.bx - p.ax)) / d
      if (!(t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98)) continue
      seen.add(key)
      const ll = unproject(p.ax + t * (p.bx - p.ax), p.ay + t * (p.by - p.ay))
      out.push({ a: Math.min(p.id, q.id), b: Math.max(p.id, q.id), lat: ll.lat, lon: ll.lon })
    }
  }
  return out
}
