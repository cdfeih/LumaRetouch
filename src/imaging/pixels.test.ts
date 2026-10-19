import { describe, expect, it } from 'vitest'
import {
  adjustPixelBuffer,
  compositePixelBuffers,
  DEFAULT_ADJUSTMENTS,
  hasMaskSelection,
  maskPixelBuffers,
} from './pixels'

describe('masked editing', () => {
  it('leaves protected pixels byte-identical and replaces only selected pixels', () => {
    const original = new Uint8ClampedArray([12, 34, 56, 255, 23, 45, 67, 155])
    const edited = new Uint8ClampedArray([200, 100, 50, 255, 9, 8, 7, 255])
    const mask = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 0])
    expect([...compositePixelBuffers(original, edited, mask, 1)])
      .toEqual([200, 100, 50, 255, 23, 45, 67, 155])
    expect([...original]).toEqual([12, 34, 56, 255, 23, 45, 67, 155])
  })

  it('honors strength, feathered selection, and a zero strength', () => {
    const original = new Uint8ClampedArray([0, 20, 40, 255])
    const edited = new Uint8ClampedArray([200, 220, 240, 255])
    expect([...compositePixelBuffers(original, edited, null, 0.5)]).toEqual([100, 120, 140, 255])
    expect([...compositePixelBuffers(original, edited, new Uint8ClampedArray([255, 255, 255, 128]), 0.5)])
      .toEqual([50, 70, 90, 255])
    expect(compositePixelBuffers(original, edited, null, 0)).toEqual(original)
  })

  it('uses edit transparency and computes straight alpha correctly', () => {
    expect([...compositePixelBuffers(
      new Uint8ClampedArray([0, 0, 255, 128]),
      new Uint8ClampedArray([255, 0, 0, 128]), null, 1,
    )]).toEqual([170, 0, 85, 192])
    expect([...compositePixelBuffers(
      new Uint8ClampedArray([12, 23, 34, 0]),
      new Uint8ClampedArray([255, 0, 0, 0]), null, 1,
    )]).toEqual([12, 23, 34, 0])
  })

  it('supports writing into the original buffer without corrupting channels', () => {
    const original = new Uint8ClampedArray([10, 20, 30, 200])
    const edited = new Uint8ClampedArray([220, 120, 80, 128])
    const expected = compositePixelBuffers(original, edited, null, 0.8)
    expect(compositePixelBuffers(original, edited, null, 0.8, original)).toEqual(expected)
  })

  it('produces opposite OpenAI alpha and Gemini guide conventions', () => {
    const selection = new Uint8ClampedArray([255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 128])
    const result = maskPixelBuffers(selection)
    expect([...result.mask]).toEqual([255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 127])
    expect([...result.guide]).toEqual([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255])
    expect(result.hasSelection).toBe(true)
    expect(hasMaskSelection(new Uint8ClampedArray(8))).toBe(false)
    expect(maskPixelBuffers(new Uint8ClampedArray(8)).hasSelection).toBe(false)
  })

  it('protects exact original RGBA in both full-image and selected editing', () => {
    const original = new Uint8ClampedArray([23, 45, 67, 155, 90, 80, 70, 255])
    const edited = new Uint8ClampedArray([250, 240, 230, 255, 9, 8, 7, 255])
    const editMask = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255])
    const protection = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0])
    const expected = [23, 45, 67, 155, 9, 8, 7, 255]
    expect([...compositePixelBuffers(original, edited, null, 1, undefined, protection)]).toEqual(expected)
    expect([...compositePixelBuffers(original, edited, editMask, 1, undefined, protection)]).toEqual(expected)
    expect([...compositePixelBuffers(original, edited, editMask, 1, original, protection)]).toEqual(expected)
  })

  it('hard-protects anti-aliased alpha=1 edges while ordinary edit alpha still blends', () => {
    const original = new Uint8ClampedArray([12, 23, 34, 0, 0, 20, 40, 255, 7, 17, 27, 128])
    const edited = new Uint8ClampedArray([250, 240, 230, 255, 200, 220, 240, 255, 100, 100, 100, 255])
    const editMask = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 128, 255, 255, 255, 255])
    const protection = new Uint8ClampedArray([255, 255, 255, 1, 0, 0, 0, 0, 255, 255, 255, 128])
    expect([...compositePixelBuffers(original, edited, editMask, 1, undefined, protection)])
      .toEqual([12, 23, 34, 0, 100, 120, 140, 255, 7, 17, 27, 128])
  })

  it('subtracts hard protection from upload masks and detects fully protected selections', () => {
    const selected = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 128])
    const partial = new Uint8ClampedArray([255, 255, 255, 1, 0, 0, 0, 0])
    const result = maskPixelBuffers(selected, partial)
    expect([...result.mask]).toEqual([255, 255, 255, 255, 255, 255, 255, 127])
    expect([...result.guide]).toEqual([0, 0, 0, 255, 128, 128, 128, 255])
    expect(result.hasSelection).toBe(true)
    const allProtected = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 1])
    expect(maskPixelBuffers(selected, allProtected).hasSelection).toBe(false)
  })

  it('never promotes an empty editable mask to whole-image editing', () => {
    const original = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 90])
    const edited = new Uint8ClampedArray([200, 100, 50, 255, 90, 80, 70, 255])
    const empty = new Uint8ClampedArray(original.length)
    const protection = new Uint8ClampedArray([0, 0, 0, 1, 0, 0, 0, 0])
    expect(compositePixelBuffers(original, edited, empty, 1, undefined, protection)).toEqual(original)
    expect(maskPixelBuffers(empty, protection).hasSelection).toBe(false)
  })

  it('fades only the editable exterior while hard protection, green limits, and strength remain authoritative', () => {
    const original = new Uint8ClampedArray([10, 20, 30, 155, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255])
    const edited = new Uint8ClampedArray([210, 220, 230, 255, 210, 220, 230, 255, 210, 220, 230, 255, 210, 220, 230, 255])
    const protection = new Uint8ClampedArray([255, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const selection = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255])
    const exterior = new Uint8ClampedArray([255, 128, 255, 255])
    expect([...compositePixelBuffers(original, edited, selection, 0.5, undefined, protection, exterior)])
      .toEqual([10, 20, 30, 155, 60, 70, 80, 255, 10, 20, 30, 255, 110, 120, 130, 255])
    const expected = compositePixelBuffers(original, edited, selection, 0.5, undefined, protection, exterior)
    expect(compositePixelBuffers(original, edited, selection, 0.5, original, protection, exterior)).toEqual(expected)
    expect(() => compositePixelBuffers(original, edited, null, 1, undefined, protection, new Uint8ClampedArray(1))).toThrow('尺寸')
  })
})

describe('local finishing controls', () => {
  it('has a byte-identical zero position, including transparency', () => {
    const original = new Uint8ClampedArray([0, 13, 255, 0, 129, 7, 28, 151])
    expect(adjustPixelBuffer(original, { ...DEFAULT_ADJUSTMENTS })).toEqual(original)
  })

  it('applies one EV in linear light without blowing out middle gray or changing alpha', () => {
    expect([...adjustPixelBuffer(new Uint8ClampedArray([25, 50, 100, 120]), { ...DEFAULT_ADJUSTMENTS, exposure: 1 })])
      .toEqual([38, 71, 138, 120])
    expect([...adjustPixelBuffer(new Uint8ClampedArray([128, 128, 128, 255]), { ...DEFAULT_ADJUSTMENTS, exposure: 1 })])
      .toEqual([176, 176, 176, 255])
  })

  it('handles the sRGB dark segment, negative EV, and transparent pixels', () => {
    const shadows = new Uint8ClampedArray([0, 4, 8, 0, 128, 200, 255, 63])
    expect([...adjustPixelBuffer(shadows, { ...DEFAULT_ADJUSTMENTS, exposure: -1 })])
      .toEqual([0, 2, 4, 0, 92, 146, 188, 63])
    expect([...adjustPixelBuffer(new Uint8ClampedArray([0, 4, 8, 120]), { ...DEFAULT_ADJUSTMENTS, exposure: 1 })])
      .toEqual([0, 8, 15, 120])
  })

  it('keeps the other finishing controls byte-identical at zero EV', () => {
    const original = new Uint8ClampedArray([13, 79, 241, 17, 128, 90, 31, 255])
    const values = { ...DEFAULT_ADJUSTMENTS, contrast: -23, saturation: 31, temperature: 17, tint: -29 }
    expect([...adjustPixelBuffer(original, values)])
      .toEqual([24, 94, 240, 17, 137, 101, 36, 255])
  })

  it('moves temperature toward amber and tint toward magenta', () => {
    const gray = new Uint8ClampedArray([100, 100, 100, 255])
    const warm = adjustPixelBuffer(gray, { ...DEFAULT_ADJUSTMENTS, temperature: 100 })
    const magenta = adjustPixelBuffer(gray, { ...DEFAULT_ADJUSTMENTS, tint: 100 })
    expect(warm[0]).toBeGreaterThan(warm[2])
    expect(magenta[0]).toBeGreaterThan(magenta[1])
    expect(magenta[2]).toBeGreaterThan(magenta[1])
  })

  it('handles in-place adjustments and clips highlights', () => {
    const original = new Uint8ClampedArray([200, 100, 50, 255])
    const values = { ...DEFAULT_ADJUSTMENTS, exposure: 2, saturation: 50 }
    const expected = adjustPixelBuffer(original, values)
    expect(adjustPixelBuffer(original, values, original)).toEqual(expected)
    expect(original[0]).toBe(255)
  })
})
