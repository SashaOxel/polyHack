import { describe, expect, it } from 'vitest'
import { project } from '../core/geo'
import { formatLength, niceLength, scaleBar } from './overlays'

describe('масштабная линейка', () => {
  it('niceLength выбирает 1/2/5 × 10^k не больше заданного', () => {
    expect(niceLength(137)).toBe(100)
    expect(niceLength(260)).toBe(200)
    expect(niceLength(520)).toBe(500)
    expect(niceLength(1000)).toBe(1000)
    expect(niceLength(0.7)).toBe(0.5)
    expect(niceLength(0)).toBe(1)
  })

  it('форматирует метры и километры', () => {
    expect(formatLength(50)).toBe('50 м')
    expect(formatLength(500)).toBe('500 м')
    expect(formatLength(1000)).toBe('1 км')
    expect(formatLength(2500)).toBe('2.5 км')
  })

  it('учитывает широту: у экватора метры = метры Меркатора, на 60° вдвое короче', () => {
    const eq = project(0, 0), hi = project(60, 0)
    const a = scaleBar({ cx: eq.x, cy: eq.y, scale: 1 })
    const b = scaleBar({ cx: hi.x, cy: hi.y, scale: 1 })
    expect(a.metersPerPx).toBeCloseTo(1, 3)
    expect(b.metersPerPx).toBeCloseTo(0.5, 3)
  })

  it('длина линейки близка к целевой и подпись соответствует', () => {
    const p = project(52.26, 104.26)
    const sb = scaleBar({ cx: p.x, cy: p.y, scale: 0.3 }, 110)
    expect(sb.px).toBeGreaterThan(40)
    expect(sb.px).toBeLessThanOrEqual(110)
    expect(sb.label).toMatch(/^\d+(\.\d+)? (м|км)$/)
  })
})
