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
})

describe('local finishing controls', () => {
  it('has a byte-identical zero position, including transparency', () => {
    const original = new Uint8ClampedArray([0, 13, 255, 0, 129, 7, 28, 151])
    expect(adjustPixelBuffer(original, { ...DEFAULT_ADJUSTMENTS })).toEqual(original)
  })

  it('makes one EV exactly twice as bright without changing alpha', () => {
    expect([...adjustPixelBuffer(new Uint8ClampedArray([25, 50, 100, 120]), { ...DEFAULT_ADJUSTMENTS, exposure: 1 })])
      .toEqual([50, 100, 200, 120])
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
