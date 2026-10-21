import { describe, expect, it } from 'vitest'
import { includePortraitDetailPixels, mergeNaturalRetouchStrip, scaleProtectionAlpha } from './render'

describe('original-resolution natural finishing merge', () => {
  it('conservatively scales alpha=1 protection, including thin lines between worker samples', () => {
    expect([...scaleProtectionAlpha(new Uint8ClampedArray([0, 1, 0, 0, 0]), 5, 1, 2, 1)]).toEqual([255, 0])
    expect([...scaleProtectionAlpha(new Uint8ClampedArray([0, 0, 1, 0, 0]), 5, 1, 2, 1)]).toEqual([255, 255])
    expect([...scaleProtectionAlpha(new Uint8ClampedArray([1, 0]), 2, 1, 4, 2)]).toEqual([255, 255, 0, 0, 255, 255, 0, 0])
    expect(() => scaleProtectionAlpha(new Uint8ClampedArray(2), 5, 1, 2, 1)).toThrow('尺寸不一致')
  })

  it('limits one achromatic delta against full-resolution RGB without new clipping or chroma drift', () => {
    const baseline = new Uint8ClampedArray([253, 101, 80, 255, 2, 180, 250, 255, 0, 90, 255, 128])
    const current = new Uint8ClampedArray(baseline)
    mergeNaturalRetouchStrip(baseline, current, new Uint8ClampedArray(3).fill(255),
      new Int16Array([10, 10, 10, -10, -10, -10, 10, 10, 10]),
      { width: 3, height: 1, workWidth: 3, workHeight: 1, startY: 0, achromatic: true })
    expect([...current]).toEqual([254, 102, 81, 255, 1, 179, 249, 255, 0, 90, 255, 128])
  })

  it('keeps one person’s D&B headroom independent of another person’s color settings', () => {
    const baseline = new Uint8ClampedArray([253, 101, 80, 255, 100, 100, 100, 255])
    const current = new Uint8ClampedArray(baseline)
    mergeNaturalRetouchStrip(baseline, current, new Uint8ClampedArray([255, 255]),
      new Int16Array([10, 10, 10, 12, 4, -7]), { width: 2, height: 1, workWidth: 2, workHeight: 1, startY: 0 },
      null, null, null, new Uint8ClampedArray([255, 0]))
    expect([...current]).toEqual([254, 102, 81, 255, 112, 104, 93, 255])
  })
  it('keeps current outside target skin, inside feature holes, at green=0, and at protection=1', () => {
    const baseline = new Uint8ClampedArray(20).fill(50)
    const current = new Uint8ClampedArray([
      10, 20, 30, 255, 11, 21, 31, 111, 12, 22, 32, 222, 13, 23, 33, 133, 14, 24, 34, 144,
    ])
    const before = new Uint8ClampedArray(current)
    const delta = new Int16Array(15).fill(20)
    mergeNaturalRetouchStrip(baseline, current, new Uint8ClampedArray([0, 0, 255, 255, 255]), delta,
      { width: 5, height: 1, workWidth: 5, workHeight: 1, startY: 0 },
      new Uint8ClampedArray([0, 0, 1, 0, 0]), new Uint8ClampedArray([255, 255, 255, 0, 255]))
    expect(current.slice(0, 16)).toEqual(before.slice(0, 16))
    expect([...current.slice(16)]).toEqual([70, 70, 70, 144])
  })

  it('zero delta restores selected skin from the fixed baseline while preserving other current pixels', () => {
    const baseline = new Uint8ClampedArray([100, 90, 80, 255, 110, 100, 90, 255])
    const current = new Uint8ClampedArray([180, 170, 160, 255, 190, 180, 170, 255])
    const changed = mergeNaturalRetouchStrip(baseline, current, new Uint8ClampedArray([255, 0]), new Int16Array(6),
      { width: 2, height: 1, workWidth: 2, workHeight: 1, startY: 0 })
    expect(changed).toBe(true)
    expect([...current]).toEqual([100, 90, 80, 255, 190, 180, 170, 255])
  })

  it('bilinearly upsamples RGB differences without reapplying small skin feather alpha', () => {
    const baseline = new Uint8ClampedArray([50, 50, 50, 255, 50, 50, 50, 255, 50, 50, 50, 255, 50, 50, 50, 255])
    const current = new Uint8ClampedArray(baseline)
    const delta = new Int16Array([0, 0, 0, 40, 40, 40])
    mergeNaturalRetouchStrip(baseline, current, new Uint8ClampedArray([1, 1, 1, 1]), delta,
      { width: 4, height: 1, workWidth: 2, workHeight: 1, startY: 0 })
    expect([...current]).toEqual([50, 50, 50, 255, 60, 60, 60, 255, 80, 80, 80, 255, 90, 90, 90, 255])
  })

  it('blends half-transparent green once against the fixed source rather than accumulating prior results', () => {
    const source = new Uint8ClampedArray([100, 90, 80, 255]), current = new Uint8ClampedArray(source);
    const dimensions = { width: 1, height: 1, workWidth: 1, workHeight: 1, startY: 0 };
    const render = () => mergeNaturalRetouchStrip(source, current, new Uint8ClampedArray([255]), new Int16Array([40, 30, 20]), dimensions, null, new Uint8ClampedArray([128]));
    render(); const first = new Uint8ClampedArray(current); render(); expect(current).toEqual(first);
    expect([...current]).toEqual([120, 105, 90, 255]);
  })

  it('uses global row coordinates for strips and reports a fully protected strip unchanged', () => {
    const baseline = new Uint8ClampedArray([60, 60, 60, 255]), current = new Uint8ClampedArray(baseline)
    const delta = new Int16Array([0, 0, 0, 30, 30, 30])
    expect(mergeNaturalRetouchStrip(baseline, current, new Uint8ClampedArray([255]), delta,
      { width: 1, height: 4, workWidth: 1, workHeight: 2, startY: 3 }, new Uint8ClampedArray([128]))).toBe(false)
    expect(current).toEqual(baseline)
    expect(mergeNaturalRetouchStrip(baseline, current, new Uint8ClampedArray([255]), delta,
      { width: 1, height: 4, workWidth: 1, workHeight: 2, startY: 3 })).toBe(true)
    expect([...current]).toEqual([90, 90, 90, 255])
  })
})


describe('original-resolution feature eligibility', () => {
  it('does not let interpolated feature deltas spill into iris holes, dark pupils, tongue, protected or green-excluded pixels', () => {
    const source = new Uint8ClampedArray([
      180, 185, 180, 255, 175, 190, 195, 255, 20, 20, 20, 255,
      210, 200, 150, 255, 190, 65, 85, 255, 180, 185, 180, 255, 180, 185, 180, 255,
    ])
    const current = new Uint8ClampedArray(source), gate = new Uint8ClampedArray(7)
    const details = {
      underEyes: new Uint8ClampedArray(7), eyes: new Uint8ClampedArray([255, 0, 255, 0, 0, 255, 255]),
      teeth: new Uint8ClampedArray([0, 0, 0, 255, 255, 0, 0]), lips: new Uint8ClampedArray(7),
    }
    includePortraitDetailPixels(gate, details, source, { smoothing: 0, blemish: 0, evenness: 0, brightening: 0, shine: 0, eyeWhitening: 100, teethWhitening: 100 })
    expect([...gate]).toEqual([255, 0, 0, 255, 0, 255, 255])
    mergeNaturalRetouchStrip(source, current, gate, new Int16Array(21).fill(12),
      { width: 7, height: 1, workWidth: 7, workHeight: 1, startY: 0 },
      new Uint8ClampedArray([0, 0, 0, 0, 0, 1, 0]), new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 0]))
    for (const pixel of [1, 2, 4, 5, 6]) expect(current.slice(pixel * 4, pixel * 4 + 4)).toEqual(source.slice(pixel * 4, pixel * 4 + 4))
    for (const pixel of [0, 3]) expect(current[pixel * 4]).toBeGreaterThan(source[pixel * 4])
  })

  it('includes an explicit zero detail setting for restoring its fixed baseline and leaves legacy natural settings alone', () => {
    const source = new Uint8ClampedArray([180, 185, 180, 255])
    const details = { underEyes: new Uint8ClampedArray(1), teeth: new Uint8ClampedArray(1), eyes: new Uint8ClampedArray([255]), lips: new Uint8ClampedArray(1) }
    const natural = { smoothing: 0, blemish: 0, evenness: 0, brightening: 0, shine: 0 }
    const legacy = new Uint8ClampedArray(1); includePortraitDetailPixels(legacy, details, source, natural)
    expect(legacy[0]).toBe(0)
    const gate = new Uint8ClampedArray(1); includePortraitDetailPixels(gate, details, source, { ...natural, eyeWhitening: 0 })
    const current = new Uint8ClampedArray([210, 215, 210, 255])
    mergeNaturalRetouchStrip(source, current, gate, new Int16Array(3), { width: 1, height: 1, workWidth: 1, workHeight: 1, startY: 0 })
    expect(current).toEqual(source)
  })
})


describe('feature-delta interpolation limits', () => {
  it('resets to baseline outside an enabled detail rather than leaking neighboring upsampled deltas', () => {
    const baseline = new Uint8ClampedArray([180, 160, 140, 255, 120, 100, 90, 255])
    const current = new Uint8ClampedArray([190, 170, 150, 255, 125, 105, 95, 255])
    const editable = new Uint8ClampedArray([255, 255]), adjustment = new Uint8ClampedArray(2)
    const details = { underEyes: new Uint8ClampedArray([0, 255]), eyes: new Uint8ClampedArray(2), teeth: new Uint8ClampedArray(2), lips: new Uint8ClampedArray(2) }
    includePortraitDetailPixels(editable, details, baseline, { smoothing: 0, blemish: 0, evenness: 0, brightening: 0, shine: 0, darkCircles: 100 }, adjustment)
    mergeNaturalRetouchStrip(baseline, current, editable, new Int16Array([20, 20, 20]),
      { width: 2, height: 1, workWidth: 1, workHeight: 1, startY: 0 }, null, null, adjustment)
    expect([...current]).toEqual([180, 160, 140, 255, 140, 120, 110, 255])
  })
})
