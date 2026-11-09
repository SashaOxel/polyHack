import type { SpeedInfo } from '../core/roads'

/**
 * Знак скоростного ограничения. Красное кольцо — скорость задана в OSM; серый пунктир — не задана,
 * показана скорость, которую подставит SUMO по классу дороги.
 */
export function drawSpeedSign(ctx: CanvasRenderingContext2D, x: number, y: number, info: SpeedInfo, r = 15) {
  const explicit = info.source !== 'default'
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = explicit ? '#ffffff' : 'rgba(255,255,255,0.9)'
  ctx.shadowColor = 'rgba(0,0,0,0.3)'
  ctx.shadowBlur = 4
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.lineWidth = r * 0.27
  ctx.strokeStyle = explicit ? '#d32f2f' : '#8a919b'
  if (!explicit) ctx.setLineDash([r * 0.4, r * 0.3])
  ctx.stroke()
  ctx.setLineDash([])

  const text = info.kmh === null ? (info.raw === 'none' ? '∞' : '?') : String(info.kmh)
  ctx.fillStyle = explicit ? '#111827' : '#6b7280'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${explicit ? 700 : 600} ${text.length > 2 ? r * 0.82 : r * 1.0}px system-ui, sans-serif`
  ctx.fillText(text, x, y + r * 0.04)
  ctx.restore()
}

/** Холст со знаком для текстуры в 3D. */
export function speedSignCanvas(info: SpeedInfo, size = 128): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  drawSpeedSign(ctx, size / 2, size / 2, info, size * 0.4)
  return c
}
