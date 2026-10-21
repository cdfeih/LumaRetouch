import { describe, it, expect } from 'vitest'
import { adjustAdvancedPixelBuffer, createCurveLut, DEFAULT_ADVANCED_COLOR, hasAdvancedColor, normalizeAdvancedColor } from './color'
import { planPhotoTransform } from './geometry'

const pixels = (...values: number[]) => new Uint8ClampedArray(values)
describe('local finishing controls', () => {
  it('zero / neutral curves preserve every RGBA byte, including in-place and transparency', () => {
    const input = pixels(1, 24, 253, 0, 128, 127, 126, 145)
    const settings = normalizeAdvancedColor({ curve: [{ x: .4, y: .4 }] })
    expect(hasAdvancedColor(settings)).toBe(false)
    expect(adjustAdvancedPixelBuffer(input, settings)).toEqual(input)
    expect(adjustAdvancedPixelBuffer(input, settings, input)).toBe(input)
    expect(input).toEqual(pixels(1, 24, 253, 0, 128, 127, 126, 145))
  })
  it('shadow lift primarily changes shadows and highlight compression primarily changes highlights', () => {
    const input = pixels(32, 32, 32, 255, 224, 224, 224, 127)
    const lifted = adjustAdvancedPixelBuffer(input, { shadows: 80 })
    expect(lifted[0] - 32).toBeGreaterThan(lifted[4] - 224)
    const lowered = adjustAdvancedPixelBuffer(input, { highlights: -80 })
    expect(224 - lowered[4]).toBeGreaterThan(32 - lowered[0])
    expect(lifted[7]).toBe(127); expect(lowered[7]).toBe(127)
  })
  it('HSL targets the selected color, leaves neutral gray and other color centers unchanged', () => {
    const settings = normalizeAdvancedColor()
    settings.hsl.red.saturation = -100
    const input = pixels(240, 16, 16, 255, 0, 200, 0, 255, 80, 80, 80, 100)
    const output = adjustAdvancedPixelBuffer(input, settings)
    expect(output[0]).toBe(output[1]); expect(output[1]).toBe(output[2])
    expect(output.slice(4)).toEqual(input.slice(4))
  })
  it('red hue wraps smoothly around 0 degrees without discontinuity', () => {
    const settings = normalizeAdvancedColor(); settings.hsl.red.hue = 100
    const output = adjustAdvancedPixelBuffer(pixels(255, 1, 0, 255, 255, 0, 1, 255), settings)
    for (let c = 0; c < 3; c++) expect(Math.abs(output[c] - output[c + 4])).toBeLessThanOrEqual(3)
  })
  it('master curve applies known input/output points and interpolates without overshoot', () => {
    const curve = [{ x: 0, y: 0 }, { x: .5, y: .75 }, { x: 1, y: 1 }]
    const lut = createCurveLut(curve)
    expect(lut[0]).toBe(0); expect(lut[255]).toBe(255)
    expect(lut[128]).toBeCloseTo(191.5)
    expect([...lut].every((value, i) => value >= 0 && value <= 255 && (!i || value >= lut[i - 1]))).toBe(true)
    expect(adjustAdvancedPixelBuffer(pixels(128, 128, 128, 40), { curve })).toEqual(pixels(192, 192, 192, 40))
  })
  it('imported invalid settings cannot create NaN, mutate defaults or share mutable arrays', () => {
    const a = normalizeAdvancedColor({ highlights: NaN, shadows: Infinity, curve: [{ x: NaN, y: .5 }, { x: .5, y: 2 }, { x: .5, y: .2 }] })
    expect(a.highlights).toBe(0); expect(a.shadows).toBe(0)
    expect(a.curve).toEqual([{ x: 0, y: 0 }, { x: .5, y: .2 }, { x: 1, y: 1 }])
    a.hsl.blue.hue = 55
    expect(DEFAULT_ADVANCED_COLOR.hsl.blue.hue).toBe(0)
    expect(normalizeAdvancedColor().hsl.blue.hue).toBe(0)
    const output = adjustAdvancedPixelBuffer(pixels(0, 255, 0, 255), a)
    expect([...output].every(Number.isFinite)).toBe(true)
  })
  it('rejects mismatched buffers', () => {
    expect(() => adjustAdvancedPixelBuffer(pixels(1, 2, 3), {})).toThrow()
    expect(() => adjustAdvancedPixelBuffer(pixels(1, 2, 3, 4), {}, pixels())).toThrow()
  })
})
describe('crop and rotation planning', () => {
  it('crops before rotation and swaps dimensions for quarter turns', () => {
    expect(planPhotoTransform(4000, 3000, { crop: { x: .1, y: .2, width: .5, height: .6 }, rotation: 90, flipHorizontal: true }))
      .toEqual({ x: 400, y: 600, sourceWidth: 2000, sourceHeight: 1800, width: 1800, height: 2000, rotation: 90, flipHorizontal: true, flipVertical: false })
  })
  it('full transform retains source dimensions, tiny valid crop retains one pixel', () => {
    expect(planPhotoTransform(8, 6, {}).width).toBe(8)
    expect(planPhotoTransform(8, 6, { crop: { x: .99, y: .99, width: .01, height: .01 } }).width).toBe(1)
  })
  it('rejects out-of-bounds, NaN, empty and invalid rotation requests', () => {
    for (const crop of [{ x: -.1, y: 0, width: 1, height: 1 }, { x: .5, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }]) expect(() => planPhotoTransform(4, 3, { crop })).toThrow()
    expect(() => planPhotoTransform(4, 3, { rotation: 45 as 90 })).toThrow()
  })
})
