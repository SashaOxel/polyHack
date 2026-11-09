/**
 * Иконки светофора и пешеходного перехода для 2D-карты.
 * uiOnly = маркер нарисован в редакторе и в .osm не попадёт: показываем его с синим пунктиром.
 */

const BLUE = '#2563eb'

function dashedRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.save()
  ctx.setLineDash([3, 3])
  ctx.strokeStyle = BLUE
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

/** Светофор: тёмный корпус с тремя сигналами. size — высота корпуса, px. */
export function drawSignalIcon(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, uiOnly: boolean) {
  const h = size, w = size * 0.5
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.35)'
  ctx.shadowBlur = 3
  ctx.fillStyle = '#1f2937'
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.roundRect(x - w / 2, y - h / 2, w, h, w * 0.3)
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.stroke()
  const r = w * 0.27
  ;['#ef4444', '#facc15', '#22c55e'].forEach((c, i) => {
    ctx.fillStyle = c
    ctx.beginPath()
    ctx.arc(x, y - h * 0.3 + i * h * 0.3, r, 0, Math.PI * 2)
    ctx.fill()
  })
  ctx.restore()
  if (uiOnly) dashedRing(ctx, x, y, h * 0.78)
}

/**
 * Пешеходный переход: «зебра» поперёк дороги. screenAngle — направление дороги на экране,
 * length — ширина дороги в пикселях (длина полос зебры).
 */
export function drawCrossingIcon(
  ctx: CanvasRenderingContext2D, x: number, y: number, screenAngle: number, length: number, uiOnly: boolean,
) {
  const len = Math.max(12, length)
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(screenAngle)
  ctx.fillStyle = 'rgba(38,48,65,0.55)'
  ctx.fillRect(-14, -len / 2 - 1, 28, len + 2)
  ctx.fillStyle = '#ffffff'
  for (let k = -2; k <= 2; k++) ctx.fillRect(k * 5 - 1.7, -len / 2, 3.4, len)
  if (uiOnly) {
    ctx.setLineDash([3, 3])
    ctx.strokeStyle = BLUE
    ctx.lineWidth = 1.5
    ctx.strokeRect(-15.5, -len / 2 - 2.5, 31, len + 5)
  }
  ctx.restore()
}
