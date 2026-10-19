import { describe, expect, it } from 'vitest'
import { analyzeLuminance } from './analysis'

function grays(values: Array<number | [number, number]>): Uint8ClampedArray {
  return new Uint8ClampedArray(values.flatMap(value => {
    const [gray, alpha] = Array.isArray(value) ? value : [value, 255]
    return [gray, gray, gray, alpha]
  }))
}

describe('local photo exposure analysis', () => {
  it('returns a neutral empty histogram for empty or transparent input', () => {
    for (const pixels of [new Uint8ClampedArray(), grays([[0, 0], [255, 127]])]) {
      const result = analyzeLuminance(pixels)
      expect(result.histogram).toHaveLength(64)
      expect(result.histogram.every(value => value === 0)).toBe(true)
      expect(result).toMatchObject({ median: 128, shadowClipped: 0, highlightClipped: 0, suggestedExposure: 0, warnings: [] })
    }
  })

  it('reports an all-black photo without suggesting invented shadow recovery', () => {
    const result = analyzeLuminance(grays(Array(12).fill(0)))
    expect(result.histogram[0]).toBe(12)
    expect(result).toMatchObject({ median: 0, shadowClipped: 1, highlightClipped: 0, suggestedExposure: 0 })
    expect(result.warnings.join('')).toMatch(/几乎全黑.*不能找回/)
  })

  it('reports an all-white photo without suggesting invented highlight recovery', () => {
    const result = analyzeLuminance(grays(Array(12).fill(255)))
    expect(result.histogram[63]).toBe(12)
    expect(result).toMatchObject({ median: 255, shadowClipped: 0, highlightClipped: 1, suggestedExposure: 0 })
    expect(result.warnings.join('')).toMatch(/几乎全白.*不能找回/)
  })

  it('counts a normal full gradient across exactly 64 bins', () => {
    const result = analyzeLuminance(grays(Array.from({ length: 256 }, (_, i) => i)))
    expect(result.histogram).toEqual(Array(64).fill(4))
    expect(result.median).toBe(127)
    expect(result.shadowClipped).toBe(6 / 256)
    expect(result.highlightClipped).toBe(6 / 256)
    expect(result.suggestedExposure).toBe(0)
  })

  it('includes alpha 128 but excludes alpha 127 and leaves the source unchanged', () => {
    const source = grays([[0, 127], [100, 128], [150, 255], [255, 0]])
    const before = new Uint8ClampedArray(source)
    const result = analyzeLuminance(source)
    expect(result.histogram.reduce((sum, value) => sum + value, 0)).toBe(2)
    expect(result).toMatchObject({ median: 100, shadowClipped: 0, highlightClipped: 0, suggestedExposure: 0 })
    expect(source).toEqual(before)
  })

  it('caps dark and bright recommendations and keeps well-lit midtones neutral', () => {
    expect(analyzeLuminance(grays(Array(10).fill(60))).suggestedExposure).toBe(0.7)
    expect(analyzeLuminance(grays(Array(10).fill(210))).suggestedExposure).toBe(-0.7)
    expect(analyzeLuminance(grays(Array(10).fill(128))).suggestedExposure).toBe(0)
  })

  it('vetoes a positive exposure recommendation when highlights are already clipping', () => {
    const result = analyzeLuminance(grays([...Array(199).fill(60), 255]))
    expect(result.highlightClipped).toBe(0.005)
    expect(result.suggestedExposure).toBe(0)
    expect(result.warnings.join('')).toMatch(/高光接近纯白/)
  })

  it('rejects an incomplete RGBA pixel', () => {
    expect(() => analyzeLuminance(new Uint8ClampedArray([1, 2, 3]))).toThrow('不完整')
  })
})
