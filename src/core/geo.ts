/** Веб-Меркатор. Единая проекция для карты, подложки (тайлов) и 3D. */

const R = 6378137

/** lat/lon → метры Меркатора. y растёт на север. */
export function project(lat: number, lon: number): { x: number; y: number } {
  const x = (lon * Math.PI * R) / 180
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  return { x, y }
}

export function unproject(x: number, y: number): { lat: number; lon: number } {
  const lon = (x / R) * (180 / Math.PI)
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)
  return { lat, lon }
}

/**
 * Ближайшая точка отрезка a–b к точке p (всё в метрах Меркатора).
 * t — положение вдоль отрезка от 0 до 1, dist — расстояние от p до отрезка.
 */
export function nearestOnSegment(
  p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number },
): { x: number; y: number; t: number; dist: number } {
  const dx = b.x - a.x, dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
  const x = a.x + t * dx, y = a.y + t * dy
  return { x, y, t, dist: Math.hypot(p.x - x, p.y - y) }
}

/** Расстояние между точками в метрах (haversine). */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(a))
}

export interface Pt { x: number; y: number; /** любое число, которое надо интерполировать вдоль линии (например, высота) */ h?: number }

/**
 * Параллельная линия на расстоянии `off` справа по ходу движения (для системы, где ось y направлена вниз:
 * экран и мир three.js X/Z). Углы сглаживаются «митрой», но не длиннее 2×off.
 */
export function offsetPolyline(pts: Pt[], off: number): Pt[] {
  const out: Pt[] = []
  const dir = (a: Pt, b: Pt) => {
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1
    return { x: dx / l, y: dy / l }
  }
  for (let i = 0; i < pts.length; i++) {
    const prev = i > 0 ? dir(pts[i - 1], pts[i]) : null
    const next = i < pts.length - 1 ? dir(pts[i], pts[i + 1]) : null
    const a = prev ?? next, b = next ?? prev
    if (!a || !b) { out.push({ ...pts[i] }); continue }
    let tx = a.x + b.x, ty = a.y + b.y
    const tl = Math.hypot(tx, ty) || 1
    tx /= tl; ty /= tl
    const miter = Math.min(2, 1 / Math.max(0.5, tx * b.x + ty * b.y))
    out.push({ x: pts[i].x - ty * off * miter, y: pts[i].y + tx * off * miter, h: pts[i].h })
  }
  return out
}

/**
 * Нарезка ломаной на штрихи: штрих `dash`, пропуск `gap`, отступ от концов `margin`.
 * Возвращает список коротких ломаных (поле h интерполируется).
 */
export function dashPolyline(pts: Pt[], dash: number, gap: number, margin = 0): Pt[][] {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  const total = cum[cum.length - 1] ?? 0
  const at = (d: number): Pt => {
    let i = 1
    while (i < pts.length - 1 && cum[i] < d) i++
    const seg = cum[i] - cum[i - 1]
    const t = seg > 0 ? Math.max(0, Math.min(1, (d - cum[i - 1]) / seg)) : 0
    const a = pts[i - 1], b = pts[i]
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, h: a.h !== undefined && b.h !== undefined ? a.h + (b.h - a.h) * t : undefined }
  }
  const out: Pt[][] = []
  if (pts.length < 2 || dash <= 0) return out
  for (let s = margin; s + dash <= total - margin + 1e-9; s += dash + gap) {
    const piece: Pt[] = [at(s)]
    for (let i = 1; i < pts.length - 1; i++) if (cum[i] > s && cum[i] < s + dash) piece.push(pts[i])
    piece.push(at(s + dash))
    out.push(piece)
  }
  return out
}
