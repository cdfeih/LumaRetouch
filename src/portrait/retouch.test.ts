import { describe, expect, it } from 'vitest'
import { DEFAULT_NATURAL_SETTINGS, retouchPortraitPixels } from './retouch'
import type { NaturalRetouchSettings } from './retouch'

const ZERO: NaturalRetouchSettings = { smoothing: 0, blemish: 0, evenness: 0, brightening: 0, shine: 0 }
const ALL: NaturalRetouchSettings = { smoothing: 100, blemish: 100, evenness: 100, brightening: 100, shine: 100 }
const light = (pixels: Uint8ClampedArray, offset: number) => pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722

function photo(width: number, height: number, rgb = [180, 140, 120]): Uint8ClampedArray {
  const result = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < result.length; i += 4) result.set([...rgb, 255], i)
  return result
}

describe('natural local portrait retouching', () => {
  it('keeps excluded eyes, brows, lips, and background exactly unchanged', () => {
    const source = photo(9, 9)
    const mask = new Uint8ClampedArray(81)
    for (let y = 1; y < 8; y += 1) for (let x = 1; x < 8; x += 1) mask[y * 9 + x] = 255
    const features = [2 * 9 + 3, 2 * 9 + 5, 4 * 9 + 3, 4 * 9 + 5, 6 * 9 + 4]
    for (const pixel of features) { mask[pixel] = 0; source.set([24, 12, 9, 173], pixel * 4) }
    const output = retouchPortraitPixels(source, 9, 9, [{ mask, settings: ALL }])
    let skinChanges = 0
    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      if (mask[pixel] === 0) expect(output.slice(pixel * 4, pixel * 4 + 4)).toEqual(source.slice(pixel * 4, pixel * 4 + 4))
      else if (output[pixel * 4] !== source[pixel * 4]) skinChanges++
    }
    expect(skinChanges).toBeGreaterThan(10)
  })

  it('hard-protects every RGBA byte at alpha 1, 128, and 255', () => {
    const source = photo(5, 5)
    const mask = new Uint8ClampedArray(25).fill(255)
    const protection = new Uint8ClampedArray(25)
    protection[6] = 1; protection[12] = 128; protection[18] = 255
    source.set([13, 23, 33, 0], 6 * 4)
    source.set([100, 120, 140, 122], 12 * 4)
    const output = retouchPortraitPixels(source, 5, 5, [{ mask, settings: ALL }], protection)
    for (const pixel of [6, 12, 18]) expect(output.slice(pixel * 4, pixel * 4 + 4)).toEqual(source.slice(pixel * 4, pixel * 4 + 4))
    expect(output.slice(0, 3)).not.toEqual(source.slice(0, 3))
  })

  it('adjusts two people independently and leaves the unconfigured space alone', () => {
    const source = photo(10, 5), first = new Uint8ClampedArray(50), second = new Uint8ClampedArray(50)
    for (let y = 0; y < 5; y += 1) {
      for (let x = 1; x < 4; x += 1) first[y * 10 + x] = 255
      for (let x = 6; x < 9; x += 1) second[y * 10 + x] = 255
    }
    const output = retouchPortraitPixels(source, 10, 5, [
      { mask: first, settings: ZERO }, { mask: second, settings: { ...ZERO, brightening: 100 } },
    ])
    for (let pixel = 0; pixel < 50; pixel += 1) {
      if (second[pixel]) expect(output[pixel * 4]).toBeGreaterThan(source[pixel * 4])
      else expect(output.slice(pixel * 4, pixel * 4 + 4)).toEqual(source.slice(pixel * 4, pixel * 4 + 4))
    }
  })

  it('uses the original source every time without mutation or cumulative slider effects', () => {
    const source = photo(7, 7), saved = new Uint8ClampedArray(source)
    source.set([190, 120, 105, 255], (3 * 7 + 3) * 4); saved.set(source)
    const mask = new Uint8ClampedArray(49).fill(255)
    const mild = [{ mask, settings: { ...DEFAULT_NATURAL_SETTINGS } }]
    const before = retouchPortraitPixels(source, 7, 7, mild)
    retouchPortraitPixels(source, 7, 7, [{ mask, settings: ALL }])
    const again = retouchPortraitPixels(source, 7, 7, mild)
    expect(source).toEqual(saved)
    expect(again).toEqual(before)
    expect(again).not.toBe(source)
  })

  it('smooths small skin noise without crossing excluded features or strong color edges', () => {
    const source = photo(7, 7, [150, 120, 100]), mask = new Uint8ClampedArray(49).fill(255)
    const center = (3 * 7 + 3) * 4
    source.set([158, 128, 108, 255], center)
    const smooth = retouchPortraitPixels(source, 7, 7, [{ mask, settings: { ...ZERO, smoothing: 100 } }])
    expect(smooth[center]).toBeLessThan(158)
    expect(smooth[center]).toBeGreaterThan(150)
    const edge = photo(8, 5, [100, 80, 65]), full = new Uint8ClampedArray(40).fill(255)
    for (let y = 0; y < 5; y += 1) for (let x = 4; x < 8; x += 1) edge.set([210, 190, 175, 255], (y * 8 + x) * 4)
    const kept = retouchPortraitPixels(edge, 8, 5, [{ mask: full, settings: { ...ZERO, smoothing: 100 } }])
    expect(kept).toEqual(edge)
  })

  it('reduces a small isolated red spot without automatically deleting neutral dark marks', () => {
    const mask = new Uint8ClampedArray(49).fill(255), center = (3 * 7 + 3) * 4
    const source = photo(7, 7)
    source.set([200, 60, 55, 255], center)
    const healed = retouchPortraitPixels(source, 7, 7, [{ mask, settings: { ...ZERO, blemish: 100 } }])
    expect(healed[center] - healed[center + 1]).toBeLessThan(source[center] - source[center + 1])
    expect(healed[center + 1]).toBeGreaterThan(source[center + 1])
    const neutral = photo(7, 7)
    neutral.set([90, 70, 60, 255], center)
    expect(retouchPortraitPixels(neutral, 7, 7, [{ mask, settings: { ...ZERO, blemish: 100 } }])).toEqual(neutral)
  })

  it('harmonizes chroma while retaining luminance and only reduces bright low-chroma shine', () => {
    const source = photo(7, 7), mask = new Uint8ClampedArray(49).fill(255)
    const center = (3 * 7 + 3) * 4
    source.set([195, 125, 100, 255], center)
    const uniform = retouchPortraitPixels(source, 7, 7, [{ mask, settings: { ...ZERO, evenness: 100 } }])
    expect(Math.abs(light(uniform, center) - light(source, center))).toBeLessThan(1)
    expect(uniform[center] - uniform[center + 2]).toBeLessThan(source[center] - source[center + 2])
    const shiny = photo(7, 7)
    shiny.set([245, 240, 230, 255], center)
    const matte = retouchPortraitPixels(shiny, 7, 7, [{ mask, settings: { ...ZERO, shine: 100 } }])
    expect(light(matte, center)).toBeLessThan(light(shiny, center))
    expect(matte.slice(0, 4)).toEqual(shiny.slice(0, 4))
  })

  it('honors fractional edit coverage but never blends away the source alpha', () => {
    const source = new Uint8ClampedArray([100, 80, 60, 123])
    const settings = { ...ZERO, brightening: 100 }
    const full = retouchPortraitPixels(source, 1, 1, [{ mask: new Uint8ClampedArray([255]), settings }])
    const half = retouchPortraitPixels(source, 1, 1, [{ mask: new Uint8ClampedArray([128]), settings }])
    for (let channel = 0; channel < 3; channel += 1) expect(Math.abs(half[channel] - (source[channel] + full[channel]) / 2)).toBeLessThanOrEqual(1)
    expect(half[3]).toBe(123)
  })

  it('limits brightening to channel headroom instead of clipping saturated skin highlights', () => {
    const source = new Uint8ClampedArray([250, 140, 120, 255, 255, 245, 230, 255])
    const result = retouchPortraitPixels(source, 2, 1, [{
      mask: new Uint8ClampedArray([255, 255]), settings: { ...ZERO, brightening: 100 },
    }])
    expect([...result]).toEqual([255, 145, 125, 255, 255, 245, 230, 255])
  })

  it('resolves overlapping masks from source without adding two people’s effects', () => {
    const source = photo(1, 1), weak = { mask: new Uint8ClampedArray([128]), settings: { ...ZERO, brightening: 100 } }
    const strong = { mask: new Uint8ClampedArray([255]), settings: ZERO }
    expect(retouchPortraitPixels(source, 1, 1, [weak, strong])).toEqual(source)
    expect(retouchPortraitPixels(source, 1, 1, [strong, weak])).toEqual(source)
  })

  it('leaves zero settings, empty subjects, and empty masks unchanged; rejects bad dimensions', () => {
    const source = photo(3, 3), mask = new Uint8ClampedArray(9).fill(255)
    expect(retouchPortraitPixels(source, 3, 3, [{ mask, settings: ZERO }])).toEqual(source)
    expect(retouchPortraitPixels(source, 3, 3, [])).toEqual(source)
    expect(retouchPortraitPixels(source, 3, 3, [{ mask: new Uint8ClampedArray(9), settings: ALL }])).toEqual(source)
    expect(retouchPortraitPixels(source, 3, 3, [{ mask, settings: { ...ZERO, brightening: NaN } }])).toEqual(source)
    expect(() => retouchPortraitPixels(source, 4, 3, [])).toThrow('尺寸')
    expect(() => retouchPortraitPixels(source, 3, 3, [{ mask: new Uint8ClampedArray(8), settings: ALL }])).toThrow('选区尺寸')
    expect(() => retouchPortraitPixels(source, 3, 3, [], new Uint8ClampedArray(8))).toThrow('保护区尺寸')
  })
})
