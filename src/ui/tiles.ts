/**
 * Подложка: растровые тайлы (Web Mercator) под графом.
 * URL-шаблон настраивается в UI: {z}/{x}/{y}. По умолчанию — OSM (см. tile usage policy:
 * для демо ок, для нагрузки нужен свой/платный тайл-сервер).
 */

export const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
export interface Basemap { id: string; label: string; url: string; satellite?: boolean; attribution: string }

/** Готовые подложки. Яндекс сюда намеренно не входит: его тайлы — в другой проекции (EPSG:3395) и только через API с ключом. */
export const BASEMAPS: Basemap[] = [
  { id: 'osm', label: 'Схема (OpenStreetMap)', url: DEFAULT_TILE_URL, attribution: '© участники OpenStreetMap' },
  { id: 'esri', label: 'Спутник (Esri World Imagery)', satellite: true, attribution: 'Снимки © Esri, Maxar, Earthstar Geographics',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}' },
]
export const isSatelliteUrl = (url: string) => BASEMAPS.some((b) => b.satellite && b.url === url)

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

/**
 * Тёмный вариант тайла (инверсия + поворот тона на 180° + приглушение): считается один раз на тайл и кэшируется.
 * Раньше это делал ctx.filter на каждом кадре — дорого, а в Safari его нет вовсе.
 */
const darkCache = new Map<HTMLImageElement, HTMLCanvasElement | 'fail'>()
function darkTile(img: HTMLImageElement): HTMLCanvasElement | HTMLImageElement {
  const hit = darkCache.get(img)
  if (hit) return hit === 'fail' ? img : hit
  const c = document.createElement('canvas')
  c.width = img.naturalWidth || 256
  c.height = img.naturalHeight || 256
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  try {
    const data = ctx.getImageData(0, 0, c.width, c.height)
    const d = data.data
    // матрицы CSS-фильтров: hue-rotate(180°) и saturate(0.35)
    const H = [-0.574, 1.43, 0.144, 0.426, 0.43, 0.144, 0.426, 1.43, -0.856]
    const k = 0.35
    const S = [0.213 + 0.787 * k, 0.715 - 0.715 * k, 0.072 - 0.072 * k, 0.213 - 0.213 * k, 0.715 + 0.285 * k, 0.072 - 0.072 * k, 0.213 - 0.213 * k, 0.715 - 0.715 * k, 0.072 + 0.928 * k]
    const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)
    for (let i = 0; i < d.length; i += 4) {
      const r0 = 255 - d[i], g0 = 255 - d[i + 1], b0 = 255 - d[i + 2]
      const r1 = H[0] * r0 + H[1] * g0 + H[2] * b0, g1 = H[3] * r0 + H[4] * g0 + H[5] * b0, b1 = H[6] * r0 + H[7] * g0 + H[8] * b0
      const r2 = S[0] * r1 + S[1] * g1 + S[2] * b1, g2 = S[3] * r1 + S[4] * g1 + S[5] * b1, b2 = S[6] * r1 + S[7] * g1 + S[8] * b1
      // brightness(0.62) и contrast(1.15)
      d[i] = clamp((r2 * 0.62 - 128) * 1.15 + 128)
      d[i + 1] = clamp((g2 * 0.62 - 128) * 1.15 + 128)
      d[i + 2] = clamp((b2 * 0.62 - 128) * 1.15 + 128)
    }
    ctx.putImageData(data, 0, 0)
    darkCache.set(img, c)
    return c
  } catch {
    darkCache.set(img, 'fail') // тайл без CORS — рисуем как есть
    return img
  }
}

export interface View {
  /** центр карты в метрах Меркатора */
  cx: number
  cy: number
  /** пикселей на метр */
  scale: number
}

export function drawTiles(
  ctx: CanvasRenderingContext2D, view: View, w: number, h: number, template: string, onLoad: () => void, dark = false,
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
      ctx.drawImage(dark ? darkTile(img) : img, sx, sy, size + 0.5, size + 0.5)
    }
  }
}
