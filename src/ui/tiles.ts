/**
 * Подложка: растровые тайлы (Web Mercator) под графом.
 * URL-шаблон настраивается в UI: {z}/{x}/{y}. По умолчанию — OSM (см. tile usage policy:
 * для демо ок, для нагрузки нужен свой/платный тайл-сервер).
 */

export const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
export const WORLD = 40075016.68557849 // длина экватора, м

const cache = new Map<string, HTMLImageElement | 'loading' | 'error'>()

function tile(url: string, onLoad: () => void): HTMLImageElement | null {
  const hit = cache.get(url)
  if (hit instanceof HTMLImageElement) return hit
  if (hit) return null
  cache.set(url, 'loading')
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => { cache.set(url, img); onLoad() }
  img.onerror = () => cache.set(url, 'error')
  img.src = url
  return null
}

export interface View {
  /** центр карты в метрах Меркатора */
  cx: number
  cy: number
  /** пикселей на метр */
  scale: number
}

export function drawTiles(
  ctx: CanvasRenderingContext2D, view: View, w: number, h: number, template: string, onLoad: () => void,
) {
  if (!template) return
  const z = Math.max(0, Math.min(19, Math.round(Math.log2((view.scale * WORLD) / 256))))
  const n = 2 ** z
  const tileM = WORLD / n
  const x0 = Math.floor((view.cx - w / 2 / view.scale + WORLD / 2) / tileM)
  const x1 = Math.floor((view.cx + w / 2 / view.scale + WORLD / 2) / tileM)
  const y0 = Math.floor((WORLD / 2 - (view.cy + h / 2 / view.scale)) / tileM)
  const y1 = Math.floor((WORLD / 2 - (view.cy - h / 2 / view.scale)) / tileM)
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 80) return
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue
      const wx = ((tx % n) + n) % n
      const url = template.replace('{z}', String(z)).replace('{x}', String(wx)).replace('{y}', String(ty))
      const img = tile(url, onLoad)
      if (!img) continue
      const mx = tx * tileM - WORLD / 2
      const my = WORLD / 2 - ty * tileM
      const sx = (mx - view.cx) * view.scale + w / 2
      const sy = (view.cy - my) * view.scale + h / 2
      const size = tileM * view.scale
      ctx.drawImage(img, sx, sy, size + 0.5, size + 0.5)
    }
  }
}
