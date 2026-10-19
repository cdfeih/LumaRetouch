import { describe, expect, it } from 'vitest'
import { mergeNaturalRetouchStrip } from './render'

describe('original-resolution natural finishing merge', () => {
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
