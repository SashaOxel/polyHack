/** Иконки светофора и пешеходного перехода для 2D-карты (рисуются по тегам узла). */

/** Светофор: тёмный корпус с тремя сигналами. size — высота корпуса, px. */
export function drawSignalIcon(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
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
}

/**
 * Пешеходный переход: «зебра» поперёк дороги. screenAngle — направление дороги на экране,
 * length — ширина дороги в пикселях (длина полос зебры).
 */
export function drawCrossingIcon(
  ctx: CanvasRenderingContext2D, x: number, y: number, screenAngle: number, length: number,
) {
  const len = Math.max(12, length)
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(screenAngle)
  ctx.fillStyle = 'rgba(38,48,65,0.55)'
  ctx.fillRect(-14, -len / 2 - 1, 28, len + 2)
  ctx.fillStyle = '#ffffff'
  for (let k = -2; k <= 2; k++) ctx.fillRect(k * 5 - 1.7, -len / 2, 3.4, len)
  ctx.restore()
}

/**
 * Знак приоритета (ПДД РФ): 2.1 жёлтый ромб с белой каймой, 2.4 перевёрнутый треугольник с красной каймой,
 * 2.5 красный восьмиугольник STOP. size — поперечник знака, px.
 */
export function drawPrioritySign(ctx: CanvasRenderingContext2D, x: number, y: number, kind: 'priority' | 'giveway' | 'stop', size: number) {
  const r = size / 2
  ctx.save()
  ctx.translate(x, y)
  ctx.shadowColor = 'rgba(0,0,0,0.4)'
  ctx.shadowBlur = 3
  ctx.lineJoin = 'round'
  ctx.beginPath()
  if (kind === 'priority') {
    ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath()
    ctx.fillStyle = '#facc15'; ctx.fill(); ctx.shadowBlur = 0
    ctx.lineWidth = Math.max(1.5, size * 0.12); ctx.strokeStyle = '#ffffff'; ctx.stroke()
    ctx.lineWidth = 1; ctx.strokeStyle = '#1f2937'; ctx.stroke()
  } else if (kind === 'giveway') {
    ctx.moveTo(-r, -r * 0.8); ctx.lineTo(r, -r * 0.8); ctx.lineTo(0, r * 0.95); ctx.closePath()
    ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.shadowBlur = 0
    ctx.lineWidth = Math.max(2, size * 0.2); ctx.strokeStyle = '#dc2626'; ctx.stroke()
  } else {
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i * Math.PI) / 4
      ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r)
    }
    ctx.closePath()
    ctx.fillStyle = '#dc2626'; ctx.fill(); ctx.shadowBlur = 0
    ctx.lineWidth = Math.max(1.2, size * 0.08); ctx.strokeStyle = '#ffffff'; ctx.stroke()
    if (size >= 18) {
      ctx.fillStyle = '#ffffff'; ctx.font = `700 ${Math.round(size * 0.3)}px system-ui, sans-serif`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('STOP', 0, 0.5)
    }
  }
  ctx.restore()
}
