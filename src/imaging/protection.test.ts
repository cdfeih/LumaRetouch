import { describe, expect, it } from 'vitest'
import { protectionTransitionCoverage, protectionTransitionRadius } from './protection'

function protection(width: number, height: number, points: Array<[number, number, number]>) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (const [x, y, alpha] of points) pixels[(y * width + x) * 4 + 3] = alpha
  return pixels
}

describe('exterior protection transition', () => {
  it('scales eight model pixels to the original with bounded radius and tiny-image compatibility', () => {
    expect(protectionTransitionRadius(2048, 1151)).toBe(8)
    expect(protectionTransitionRadius(4272, 2400)).toBe(17)
    expect(protectionTransitionRadius(64, 64)).toBe(2)
    expect(protectionTransitionRadius(16000, 2500)).toBe(32)
    expect(protectionTransitionRadius(8, 4)).toBe(0)
  })

  it('keeps all nonzero alpha seeds hard and changes only the narrow exterior', () => {
    const pixels = protection(13, 9, [[4, 4, 1], [5, 4, 128], [6, 4, 255]])
    const result = protectionTransitionCoverage(pixels, 13, 9, 3)
    expect([result[4 * 13 + 4], result[4 * 13 + 5], result[4 * 13 + 6]]).toEqual([0, 0, 0])
    const outside = [result[4 * 13 + 7], result[4 * 13 + 8], result[4 * 13 + 9]]
    expect(outside[0]).toBeGreaterThan(0)
    expect(outside[0]).toBeLessThan(outside[1])
    expect(outside[1]).toBeLessThan(outside[2])
    expect(outside[2]).toBe(255)
    expect(result[0]).toBe(255)
    expect(result[4 * 13 + 12]).toBe(255)
  })

  it('uses alpha alone and is symmetric around a seed, including diagonals', () => {
    const pixels = protection(11, 11, [[5, 5, 1]])
    pixels[(5 * 11 + 5) * 4] = 255
    const one = protectionTransitionCoverage(pixels, 11, 11, 4)
    pixels[(5 * 11 + 5) * 4 + 3] = 255
    const opaque = protectionTransitionCoverage(pixels, 11, 11, 4)
    expect(one).toEqual(opaque)
    expect(one[5 * 11 + 6]).toBe(one[5 * 11 + 4])
    expect(one[5 * 11 + 6]).toBe(one[4 * 11 + 5])
    expect(one[4 * 11 + 4]).toBe(one[6 * 11 + 6])
    expect(one[4 * 11 + 4]).toBeGreaterThan(one[4 * 11 + 5])
  })

  it('produces identical central rows from halo strips, without a seam at strip boundaries', () => {
    const width = 15, height = 24, radius = 4
    const pixels = protection(width, height, [[6, 7, 1], [8, 15, 255], [1, 17, 128]])
    const full = protectionTransitionCoverage(pixels, width, height, radius)
    for (let y = 0; y < height; y += 8) {
      const rows = Math.min(8, height - y)
      const top = Math.max(0, y - radius), bottom = Math.min(height, y + rows + radius)
      const halo = pixels.subarray(top * width * 4, bottom * width * 4)
      expect(protectionTransitionCoverage(halo, width, bottom - top, radius, y - top, rows))
        .toEqual(full.subarray(y * width, (y + rows) * width))
    }
  })

  it('leaves an empty protection field fully editable and handles zero-radius hard protection', () => {
    expect([...protectionTransitionCoverage(protection(4, 2, []), 4, 2, 3)]).toEqual(Array(8).fill(255))
    expect([...protectionTransitionCoverage(protection(4, 2, [[1, 1, 1]]), 4, 2, 0)])
      .toEqual([255, 255, 255, 255, 255, 0, 255, 255])
    expect(() => protectionTransitionCoverage(new Uint8ClampedArray(8), 4, 2, 3)).toThrow('尺寸')
    expect(() => protectionTransitionCoverage(protection(4, 2, []), 4, 2, 3, 1, 2)).toThrow('尺寸')
  })
})
