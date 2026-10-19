/**
 * Deterministic local skin finishing. Face detection and exclusion of eyes,
 * eyebrows, nostrils, and lips belong to the caller's skin masks. These routines
 * neither detect facial features nor generate or move any image content.
 */
export type NaturalRetouchSettings = {
  smoothing: number
  blemish: number
  evenness: number
  brightening: number
  shine: number
}

export const DEFAULT_NATURAL_SETTINGS: Readonly<NaturalRetouchSettings> = Object.freeze({
  smoothing: 28,
  blemish: 24,
  evenness: 20,
  brightening: 16,
  shine: 12,
})

export type PortraitRetouchSubject = {
  /** One alpha byte per pixel: 0 leaves source untouched; 255 applies full settings. */
  mask: Uint8ClampedArray
  settings: NaturalRetouchSettings
}

const KEYS = ['smoothing', 'blemish', 'evenness', 'brightening', 'shine'] as const
const luminance = (r: number, g: number, b: number) => r * 0.2126 + g * 0.7152 + b * 0.0722
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function normalized(settings: NaturalRetouchSettings): NaturalRetouchSettings {
  return Object.fromEntries(KEYS.map(key => [key,
    Number.isFinite(settings[key]) ? clamp(settings[key], 0, 100) / 100 : 0,
  ])) as NaturalRetouchSettings
}

/**
 * Always evaluate every subject against the immutable source, never against a
 * prior slider result. For overlapping masks the greater coverage wins; ties
 * belong to the earlier subject. Alpha and all unselected/protected RGBA bytes
 * are retained, including protection alpha=1. Output is a new pixel buffer.
 *
 * Neighborhood filtering is limited to selected skin from that same subject.
 * Blemish reduction is a conservative local redness heuristic, not medical acne
 * detection; callers should not describe it as semantic lesion recognition.
 */
export function retouchPortraitPixels(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  subjects: PortraitRetouchSubject[],
  protection?: Uint8ClampedArray | null,
): Uint8ClampedArray {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || source.length !== width * height * 4) {
    throw new Error('人像图片尺寸与像素数据不一致。')
  }
  const count = width * height
  if (protection && protection.length !== count) throw new Error('人像保护区尺寸不一致。')
  for (const subject of subjects) {
    if (subject.mask.length !== count) throw new Error('人像皮肤选区尺寸不一致。')
  }
  const output = new Uint8ClampedArray(source)
  if (subjects.length === 0) return output
  // One byte per pixel is enough to resolve overlapping subjects, avoiding
  // intermediate full-resolution RGB images for each person's settings.
  const coverage = new Uint8ClampedArray(count)
  const radius = clamp(Math.round(Math.min(width, height) / 800), 1, 3)

  for (const subject of subjects) {
    const mask = subject.mask
    const settings = normalized(subject.settings)
    const isIdentity = KEYS.every(key => settings[key] === 0)
    let left = width, top = height, right = -1, bottom = -1
    let meanR = 0, meanG = 0, meanB = 0, total = 0
    // Find each person's skin bounds and illumination/chroma baseline once.
    for (let pixel = 0; pixel < count; pixel += 1) {
      const alpha = mask[pixel]
      const offset = pixel * 4
      if (alpha === 0 || source[offset + 3] === 0) continue
      const x = pixel % width, y = Math.floor(pixel / width)
      left = Math.min(left, x); right = Math.max(right, x)
      top = Math.min(top, y); bottom = Math.max(bottom, y)
      const weight = alpha / 255
      meanR += source[offset] * weight
      meanG += source[offset + 1] * weight
      meanB += source[offset + 2] * weight
      total += weight
    }
    if (total === 0) continue
    meanR /= total; meanG /= total; meanB /= total
    const meanY = luminance(meanR, meanG, meanB)
    const meanRedChroma = meanR - meanY, meanBlueChroma = meanB - meanY
    const needsNeighborhood = settings.smoothing > 0 || settings.blemish > 0

    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const pixel = y * width + x, amount = mask[pixel]
        const offset = pixel * 4
        if (amount === 0 || amount <= coverage[pixel] || source[offset + 3] === 0
          || (protection && protection[pixel] > 0)) continue
        coverage[pixel] = amount
        const r = source[offset], g = source[offset + 1], b = source[offset + 2]
        let red = r, green = g, blue = b

        if (!isIdentity) {
          if (needsNeighborhood) {
            let smoothR = r, smoothG = g, smoothB = b, smoothWeight = 1
            let nearbyR = 0, nearbyG = 0, nearbyB = 0, nearbyWeight = 0, neighbors = 0
            for (let dy = -radius; dy <= radius; dy += 1) {
              const ny = y + dy
              if (ny < 0 || ny >= height) continue
              for (let dx = -radius; dx <= radius; dx += 1) {
                const nx = x + dx
                if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue
                const neighbor = ny * width + nx, no = neighbor * 4
                if (mask[neighbor] === 0 || source[no + 3] === 0) continue
                const nr = source[no], ng = source[no + 1], nb = source[no + 2]
                const spatial = mask[neighbor] / 255 / (1 + dx * dx + dy * dy)
                const colorDistance = (nr - r) ** 2 + (ng - g) ** 2 + (nb - b) ** 2
                const edgeWeight = spatial / (1 + colorDistance / 900) ** 2
                smoothR += nr * edgeWeight; smoothG += ng * edgeWeight; smoothB += nb * edgeWeight
                smoothWeight += edgeWeight
                nearbyR += nr * spatial; nearbyG += ng * spatial; nearbyB += nb * spatial
                nearbyWeight += spatial; neighbors += 1
              }
            }
            // Color-range weights preserve strong boundaries; blending retains
            // high-frequency source texture even at the maximum control value.
            const soften = settings.smoothing * 0.58
            red += (smoothR / smoothWeight - r) * soften
            green += (smoothG / smoothWeight - g) * soften
            blue += (smoothB / smoothWeight - b) * soften
            if (settings.blemish > 0 && nearbyWeight > 0 && neighbors >= 3) {
              const localR = nearbyR / nearbyWeight, localG = nearbyG / nearbyWeight, localB = nearbyB / nearbyWeight
              const redExcess = r - (g + b) * 0.5 - (localR - (localG + localB) * 0.5)
              const localContrast = Math.abs(luminance(r, g, b) - luminance(localR, localG, localB))
              // Neutral dark freckles/moles are intentionally not selected by
              // this redness-only heuristic. Large/high-contrast edges are kept.
              if (redExcess > 12 && r > g * 1.08 && r > b * 1.05 && localContrast < 85) {
                const reduce = settings.blemish * 0.65 * clamp((redExcess - 12) / 40, 0, 1)
                red += (localR - red) * reduce
                green += (localG - green) * reduce
                blue += (localB - blue) * reduce
              }
            }
          }

          let light = luminance(red, green, blue)
          if (settings.evenness > 0 && meanY > 0) {
            // Harmonize chroma gently while preserving the pixel's luminance,
            // so face lighting and cheek/jaw structure are not flattened.
            const shade = clamp(light / meanY, 0.6, 1.4)
            const uniformity = settings.evenness * 0.18
            const redChroma = (red - light) * (1 - uniformity) + meanRedChroma * shade * uniformity
            const blueChroma = (blue - light) * (1 - uniformity) + meanBlueChroma * shade * uniformity
            red = light + redChroma; blue = light + blueChroma
            green = (light - red * 0.2126 - blue * 0.0722) / 0.7152
          }

          if (settings.shine > 0) {
            const spread = Math.max(r, g, b) - Math.min(r, g, b)
            const highlight = clamp((luminance(r, g, b) - Math.max(180, meanY + 24)) / 55, 0, 1)
            const specular = 1 - clamp(spread / 80, 0, 1)
            const reduction = Math.min(26, Math.max(0, light - meanY - 26) * 0.3)
              * settings.shine * highlight * specular
            red -= reduction; green -= reduction; blue -= reduction
            light -= reduction
          }
          const lift = Math.min(
            Math.max(0, 255 - light) * settings.brightening * 0.16,
            Math.max(0, 255 - Math.max(red, green, blue)),
          )
          red += lift; green += lift; blue += lift
        }

        const mix = amount / 255
        output[offset] = Math.round(r + (red - r) * mix)
        output[offset + 1] = Math.round(g + (green - g) * mix)
        output[offset + 2] = Math.round(b + (blue - b) * mix)
        // Output alpha is the untouched source alpha from the initial copy.
      }
    }
  }
  return output
}
