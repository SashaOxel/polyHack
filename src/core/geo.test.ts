import { describe, expect, it } from 'vitest'
import { dashPolyline, offsetPolyline } from './geo'

describe('offsetPolyline', () => {
  it('смещает вправо по ходу (ось y вниз): идём на восток — смещение на юг (y+)', () => {
    const out = offsetPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], 2)
    expect(out[0]).toEqual({ x: 0, y: 2, h: undefined })
    expect(out[1].y).toBeCloseTo(2, 9)
    expect(offsetPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], -2)[0].y).toBeCloseTo(-2, 9)
  })

  it('на повороте сохраняет расстояние до линии (митра)', () => {
    // поворот на 90° вправо: на углу смещение ≈ 2·√2 по диагонали
    const out = offsetPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 2)
    expect(out[1].x).toBeCloseTo(8, 6)
    expect(out[1].y).toBeCloseTo(2, 6)
  })
})

describe('dashPolyline', () => {
  const line = [{ x: 0, y: 0, h: 0 }, { x: 100, y: 0, h: 10 }]

  it('режет на штрихи нужной длины с пропусками', () => {
    const d = dashPolyline(line, 3, 7)
    expect(d).toHaveLength(10)
    expect(d[0][0].x).toBe(0)
    expect(d[0].at(-1)!.x).toBeCloseTo(3, 9)
    expect(d[1][0].x).toBeCloseTo(10, 9)
  })

  it('отступ от концов и интерполяция высоты', () => {
    const d = dashPolyline(line, 3, 7, 6)
    expect(d[0][0].x).toBeCloseTo(6, 9)
    expect(d.at(-1)!.at(-1)!.x).toBeLessThanOrEqual(94 + 1e-9)
    expect(d[0][0].h).toBeCloseTo(0.6, 9)
  })

  it('штрих включает внутренние изгибы', () => {
    const d = dashPolyline([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 5 }], 4, 100)
    expect(d).toHaveLength(1)
    expect(d[0]).toHaveLength(3)
  })

  it('короткая линия или нулевой штрих — пусто', () => {
    expect(dashPolyline([{ x: 0, y: 0 }], 3, 3)).toEqual([])
    expect(dashPolyline(line, 0, 3)).toEqual([])
    expect(dashPolyline([{ x: 0, y: 0 }, { x: 2, y: 0 }], 3, 3)).toEqual([])
  })
})
