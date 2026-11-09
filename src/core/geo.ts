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
