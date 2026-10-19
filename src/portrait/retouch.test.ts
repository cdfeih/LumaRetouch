import { describe, expect, it } from 'vitest'
import { DEFAULT_NATURAL_SETTINGS, retouchPortraitPixels } from './retouch'
import type { NaturalRetouchSettings, PortraitDetailMasks } from './retouch'

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


function detailMasks(length: number): PortraitDetailMasks {
  return { underEyes: new Uint8ClampedArray(length), teeth: new Uint8ClampedArray(length), eyes: new Uint8ClampedArray(length), lips: new Uint8ClampedArray(length) }
}

describe('local portrait complexion and feature finishing', () => {
  it('keeps all added controls opt-in and preserves the natural preset strengths', () => {
    expect([DEFAULT_NATURAL_SETTINGS.smoothing, DEFAULT_NATURAL_SETTINGS.blemish, DEFAULT_NATURAL_SETTINGS.evenness, DEFAULT_NATURAL_SETTINGS.brightening, DEFAULT_NATURAL_SETTINGS.shine]).toEqual([28, 24, 20, 16, 12])
    for (const key of ['warmth', 'deYellow', 'deRedness', 'rosiness', 'darkCircles', 'teethWhitening', 'eyeWhitening', 'lipColor'] as const) expect(DEFAULT_NATURAL_SETTINGS[key]).toBe(0)
    const source = photo(2, 1), details = detailMasks(2)
    for (const mask of Object.values(details)) mask.fill(255)
    expect(retouchPortraitPixels(source, 2, 1, [{ mask: new Uint8ClampedArray(2), details, settings: { ...ZERO, warmth: 0, deYellow: 0, deRedness: 0, rosiness: 0, darkCircles: 0, teethWhitening: 0, eyeWhitening: 0, lipColor: 0 } }])).toEqual(source)
  })

  it('offers reversible temperature and separate yellow, redness and rosy color changes only on face skin', () => {
    const source = photo(3, 1, [190, 150, 100]), mask = new Uint8ClampedArray([255, 0, 255]), protection = new Uint8ClampedArray([0, 0, 1])
    const render = (extra: Partial<NaturalRetouchSettings>) => retouchPortraitPixels(source, 3, 1, [{ mask, settings: { ...ZERO, ...extra } }], protection)
    const warm = render({ warmth: 100 }), cool = render({ warmth: -100 })
    expect(warm[0] - warm[2]).toBeGreaterThan(source[0] - source[2])
    expect(cool[0] - cool[2]).toBeLessThan(source[0] - source[2])
    const yellow = render({ deYellow: 100 })
    expect(Math.min(yellow[0], yellow[1]) - yellow[2]).toBeLessThan(Math.min(source[0], source[1]) - source[2])
    const red = render({ deRedness: 100 })
    expect(red[0] - (red[1] + red[2]) / 2).toBeLessThan(source[0] - (source[1] + source[2]) / 2)
    const rosy = render({ rosiness: 100 })
    expect(rosy[0] - rosy[1]).toBeGreaterThan(source[0] - source[1])
    for (const output of [warm, cool, yellow, red, rosy]) {
      expect(Math.abs(light(output, 0) - light(source, 0))).toBeLessThan(1)
      expect(output.slice(4)).toEqual(source.slice(4))
    }
  })

  it('lifts a dark under-eye skin band without changing eyes or adjacent cheek pixels', () => {
    const source = photo(5, 5), mask = new Uint8ClampedArray(25).fill(255), details = detailMasks(25)
    source.set([110, 90, 85, 255], 12 * 4); details.underEyes[12] = 255
    source.set([40, 32, 25, 255], 7 * 4); mask[7] = 0; details.underEyes[7] = 255
    const output = retouchPortraitPixels(source, 5, 5, [{ mask, details, settings: { ...ZERO, darkCircles: 100 } }])
    expect(light(output, 48)).toBeGreaterThan(light(source, 48))
    for (let pixel = 0; pixel < 25; pixel++) if (pixel !== 12) expect(output.slice(pixel * 4, pixel * 4 + 4)).toEqual(source.slice(pixel * 4, pixel * 4 + 4))
  })

  it('whitens actual bright neutral teeth, rejects tongue/lips/dark mouth and works outside skin masks', () => {
    const source = new Uint8ClampedArray([210, 200, 150, 255, 190, 65, 85, 255, 35, 30, 25, 255, 200, 185, 175, 123])
    const details = detailMasks(4); details.teeth.fill(255)
    const output = retouchPortraitPixels(source, 4, 1, [{ mask: new Uint8ClampedArray(4), details, settings: { ...ZERO, teethWhitening: 100 } }])
    expect(light(output, 0)).toBeGreaterThan(light(source, 0))
    expect(output[0] - output[2]).toBeLessThan(source[0] - source[2])
    expect(output.slice(4, 12)).toEqual(source.slice(4, 12))
    expect(output[15]).toBe(123)
  })

  it('brightens eye whites while preserving dark pupils, iris holes, eye edges and protection alpha=1', () => {
    const source = new Uint8ClampedArray([185, 190, 185, 255, 30, 32, 28, 255, 180, 195, 200, 255, 175, 180, 175, 255])
    const details = detailMasks(4); details.eyes.set([255, 255, 0, 255])
    const output = retouchPortraitPixels(source, 4, 1, [{ mask: new Uint8ClampedArray(4), details, settings: { ...ZERO, eyeWhitening: 100 } }], new Uint8ClampedArray([0, 0, 0, 1]))
    expect(light(output, 0)).toBeGreaterThan(light(source, 0))
    expect(output.slice(4)).toEqual(source.slice(4))
  })

  it('adjusts only pink lip color and retains the mouth opening and neutral non-lip pixels', () => {
    const source = new Uint8ClampedArray([180, 70, 90, 255, 180, 70, 90, 255, 100, 100, 100, 255])
    const details = detailMasks(3); details.lips.set([255, 0, 255])
    const output = retouchPortraitPixels(source, 3, 1, [{ mask: new Uint8ClampedArray(3), details, settings: { ...ZERO, lipColor: 100 } }])
    expect(output[0] - output[1]).toBeGreaterThan(source[0] - source[1])
    expect(output.slice(4)).toEqual(source.slice(4))
    expect(() => retouchPortraitPixels(source, 3, 1, [{ mask: new Uint8ClampedArray(3), details: detailMasks(2), settings: ZERO }])).toThrow('细节选区尺寸')
  })
})
