import { project, unproject } from '../core/geo'
import { isDrivable, roadStyle } from '../core/roads'
import type { OsmDocument } from '../core/types'
import type { View } from './tiles'
import { PALETTES, type Theme } from './theme'

/** «Круглая» длина для масштабной линейки: 1, 2, 5 × 10^k, не больше raw. */
export function niceLength(raw: number): number {
  if (!(raw > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(raw))
  for (const m of [5, 2, 1]) if (m * p <= raw) return m * p
  return p
}

export const formatLength = (m: number) => (m >= 1000 ? `${+(m / 1000).toFixed(2)} км` : `${Math.round(m)} м`)

/**
 * Масштабная линейка. Меркатор растягивает расстояния на широте, поэтому реальные метры на пиксель —
 * (метры Меркатора на пиксель) × cos(широта центра).
 */
export function scaleBar(view: View, targetPx = 110): { px: number; label: string; metersPerPx: number } {
  const { lat } = unproject(view.cx, view.cy)
  const metersPerPx = Math.cos((lat * Math.PI) / 180) / view.scale
  const m = niceLength(metersPerPx * targetPx)
  return { px: m / metersPerPx, label: formatLength(m), metersPerPx }
}

/**
 * Миникарта: вся дорожная сеть целиком в маленьком окне и рамка текущего вида.
 * Содержимое рисуется один раз во внутренний буфер и перерисовывается только когда документ изменился.
 */
export class Minimap {
  private buf: HTMLCanvasElement | null = null
  private key: { doc: OsmDocument; version: number; theme: Theme } | null = null
  private ext = { x0: 0, x1: 1, y0: 0, y1: 1 }
  w = 0
  h = 0
  private theme: Theme = 'light'

  constructor(private maxW = 220, private maxH = 160) {}

  get ready() { return this.buf !== null && this.w > 0 }

  /** Пересобрать буфер, если документ или его версия изменились. */
  update(doc: OsmDocument, version: number, dpr: number, theme: Theme = 'light') {
    if (this.key && this.key.doc === doc && this.key.version === version && this.key.theme === theme) return
    this.key = { doc, version, theme }
    this.theme = theme
    const pal = PALETTES[theme]

    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    const ways = [...doc.ways.values()].filter((w) => w.tags.highway)
    for (const w of ways) for (const id of w.nodes) {
      const n = doc.nodes.get(id)
      if (!n) continue
      const p = project(n.lat, n.lon)
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y
    }
    if (!isFinite(x0) || x1 <= x0 || y1 <= y0) { this.buf = null; this.w = this.h = 0; return }
    const padX = (x1 - x0) * 0.03, padY = (y1 - y0) * 0.03
    this.ext = { x0: x0 - padX, x1: x1 + padX, y0: y0 - padY, y1: y1 + padY }

    const aspect = (this.ext.x1 - this.ext.x0) / (this.ext.y1 - this.ext.y0)
    if (aspect > this.maxW / this.maxH) { this.w = this.maxW; this.h = Math.max(60, this.maxW / aspect) }
    else { this.h = this.maxH; this.w = Math.max(60, this.maxH * aspect) }

    const buf = document.createElement('canvas')
    buf.width = Math.round(this.w * dpr)
    buf.height = Math.round(this.h * dpr)
    const ctx = buf.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    const sx = this.w / (this.ext.x1 - this.ext.x0), sy = this.h / (this.ext.y1 - this.ext.y0)
    // сначала пешеходные (тонкие, светлые), потом дороги для машин сверху
    for (const pass of [false, true]) {
      for (const way of ways) {
        if (isDrivable(way) !== pass) continue
        ctx.beginPath()
        let started = false
        for (const id of way.nodes) {
          const n = doc.nodes.get(id)
          if (!n) continue
          const p = project(n.lat, n.lon)
          const x = (p.x - this.ext.x0) * sx, y = (this.ext.y1 - p.y) * sy
          if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = pass ? pal.road(way.tags.highway) : theme === 'dark' ? '#334155' : '#c9ced6'
        ctx.lineWidth = pass ? Math.max(1, roadStyle(way.tags.highway).width / 3) : 0.6
        ctx.stroke()
      }
    }
    this.buf = buf
  }

  /** Нарисовать миникарту и рамку вида (viewW × viewH — размер основной карты в пикселях). */
  draw(target: HTMLCanvasElement, view: View, viewW: number, viewH: number, dpr: number) {
    if (!this.buf) return
    target.width = Math.round(this.w * dpr)
    target.height = Math.round(this.h * dpr)
    target.style.width = `${this.w}px`
    target.style.height = `${this.h}px`
    const ctx = target.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = this.theme === 'dark' ? '#0b1324' : '#f7f8fa'
    ctx.fillRect(0, 0, this.w, this.h)
    ctx.drawImage(this.buf, 0, 0, this.w, this.h)

    const { x0, x1, y0, y1 } = this.ext
    const halfW = viewW / 2 / view.scale, halfH = viewH / 2 / view.scale
    const rx0 = ((view.cx - halfW - x0) / (x1 - x0)) * this.w
    const rx1 = ((view.cx + halfW - x0) / (x1 - x0)) * this.w
    const ry0 = ((y1 - (view.cy + halfH)) / (y1 - y0)) * this.h
    const ry1 = ((y1 - (view.cy - halfH)) / (y1 - y0)) * this.h
    // затемнение вне рамки вида
    ctx.fillStyle = 'rgba(15,23,42,0.18)'
    ctx.beginPath()
    ctx.rect(0, 0, this.w, this.h)
    ctx.rect(rx0, ry0, rx1 - rx0, ry1 - ry0)
    ctx.fill('evenodd')
    ctx.strokeStyle = this.theme === 'dark' ? '#38bdf8' : '#2563eb'
    ctx.lineWidth = 2
    ctx.strokeRect(rx0, ry0, Math.max(3, rx1 - rx0), Math.max(3, ry1 - ry0))
  }

  /** Точка миникарты (в CSS-пикселях) → координаты Меркатора. */
  toWorld(px: number, py: number): { x: number; y: number } {
    const { x0, x1, y0, y1 } = this.ext
    const cl = (v: number, max: number) => Math.max(0, Math.min(max, v))
    return { x: x0 + (cl(px, this.w) / this.w) * (x1 - x0), y: y1 - (cl(py, this.h) / this.h) * (y1 - y0) }
  }
}
