/**
 * Deterministic local skin finishing. Face detection and exclusion of eyes,
 * eyebrows, nostrils, and lips belong to the caller's skin masks. These routines
 * neither detect facial features nor generate or move any image content.
 */
import { buildDodgeBurnCorrection } from './dodge-burn'

export type NaturalRetouchSettings = {
  smoothing: number
  blemish: number
  evenness: number
  brightening: number
  shine: number
  /** Opt-in local dodge and burn; old presets keep it disabled. */
  dodgeBurn?: number
  /** Signed temperature adjustment; all added controls are opt-in. */
  warmth?: number
  deYellow?: number
  deRedness?: number
  rosiness?: number
  darkCircles?: number
  teethWhitening?: number
  eyeWhitening?: number
  lipColor?: number
}

export const DEFAULT_NATURAL_SETTINGS: Readonly<NaturalRetouchSettings> = Object.freeze({
  smoothing: 28,
  blemish: 24,
  evenness: 20,
  brightening: 16,
  shine: 12,
  dodgeBurn: 0,
  warmth: 0,
  deYellow: 0,
  deRedness: 0,
  rosiness: 0,
  darkCircles: 0,
  teethWhitening: 0,
  eyeWhitening: 0,
  lipColor: 0,
})

export type PortraitDetailMasks = {
  underEyes: Uint8ClampedArray
  teeth: Uint8ClampedArray
  eyes: Uint8ClampedArray
  lips: Uint8ClampedArray
}

export type PortraitRetouchSubject = {
  /** One alpha byte per pixel: 0 leaves source untouched; 255 applies full settings. */
  mask: Uint8ClampedArray
  /** More conservative skin gate excluding nose structure as well as eye/lip holes. */
  dodgeBurnMask?: Uint8ClampedArray
  settings: NaturalRetouchSettings
  details?: PortraitDetailMasks
}

const KEYS = ['smoothing', 'blemish', 'evenness', 'brightening', 'shine', 'dodgeBurn', 'warmth', 'deYellow', 'deRedness', 'rosiness', 'darkCircles', 'teethWhitening', 'eyeWhitening', 'lipColor'] as const
const luminance = (r: number, g: number, b: number) => r * 0.2126 + g * 0.7152 + b * 0.0722
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function normalized(settings: NaturalRetouchSettings): Required<NaturalRetouchSettings> {
  return Object.fromEntries(KEYS.map(key => [key,
    typeof settings[key] === 'number' && Number.isFinite(settings[key])
      ? clamp(settings[key]!, key === 'warmth' ? -100 : 0, 100) / 100 : 0,
  ])) as Required<NaturalRetouchSettings>
}

/** Conservative color guards inside detected feature geometry. */
export function isTeethPixel(r: number, g: number, b: number): boolean {
  const light = luminance(r, g, b)
  return light > 105 && Math.max(r, g, b) - Math.min(r, g, b) < 70
    && Math.abs(r - g) < 35 && r - b < 72 && g - b < 65
}

export function isEyeWhitePixel(r: number, g: number, b: number): boolean {
  return luminance(r, g, b) > 135 && Math.max(r, g, b) - Math.min(r, g, b) < 48
}

export function isLipPixel(r: number, g: number, b: number): boolean {
  return luminance(r, g, b) > 22 && r - g > 10 && r > b * 1.02
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
    if (subject.dodgeBurnMask && subject.dodgeBurnMask.length !== count) throw new Error('中性灰皮肤选区尺寸不一致。')
    if (subject.details && Object.values(subject.details).some(mask => mask.length !== count)) throw new Error('人像细节选区尺寸不一致。')
  }
  const output = new Uint8ClampedArray(source)
  if (subjects.length === 0) return output
  // One byte per pixel is enough to resolve overlapping subjects, avoiding
  // intermediate full-resolution RGB images for each person's settings.
  const coverage = new Uint8ClampedArray(count)
  const detailCoverage = new Uint8ClampedArray(count)
  const radius = clamp(Math.round(Math.min(width, height) / 800), 1, 3)

  for (const subject of subjects) {
    const mask = subject.mask
    const details = subject.details
    const settings = normalized(subject.settings)
    const dodgeBurn = settings.dodgeBurn > 0
      ? buildDodgeBurnCorrection(source, width, height, subject.dodgeBurnMask ?? mask, protection) : null
    const isIdentity = KEYS.every(key => settings[key] === 0)
    let left = width, top = height, right = -1, bottom = -1
    let meanR = 0, meanG = 0, meanB = 0, total = 0
    // Find each person's skin bounds and illumination/chroma baseline once.
    for (let pixel = 0; pixel < count; pixel += 1) {
      const alpha = mask[pixel]
      const offset = pixel * 4
      if (alpha === 0 || source[offset + 3] === 0 || protection?.[pixel]) continue
      const x = pixel % width, y = Math.floor(pixel / width)
      left = Math.min(left, x); right = Math.max(right, x)
      top = Math.min(top, y); bottom = Math.max(bottom, y)
      const weight = alpha / 255
      meanR += source[offset] * weight
      meanG += source[offset + 1] * weight
      meanB += source[offset + 2] * weight
      total += weight
    }
    if (total > 0) { meanR /= total; meanG /= total; meanB /= total }
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
                if (mask[neighbor] === 0 || source[no + 3] === 0 || protection?.[neighbor]) continue
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

          if (dodgeBurn) {
            // Add a slowly varying achromatic correction, retaining the source
            // texture and channel differences instead of replacing RGB by blur.
            const feather = subject.dodgeBurnMask ? subject.dodgeBurnMask[pixel] / amount : 1
            const correction = clamp(dodgeBurn[pixel] * settings.dodgeBurn * feather,
              -Math.max(0, Math.min(red, green, blue) - 1), Math.max(0, 254 - Math.max(red, green, blue)))
            red += correction; green += correction; blue += correction
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
          // All complexion controls remain inside the supplied face-skin mask.
          // Preserve luminance for chroma work and keep changes bounded.
          const colorLight = luminance(red, green, blue)
          red += settings.warmth * 8
          blue -= settings.warmth * 10
          const yellow = Math.max(0, Math.min(red, green) - blue)
          const yellowAmount = settings.deYellow * 0.38 * clamp(yellow / 45, 0, 1)
          blue += yellow * yellowAmount
          const redness = Math.max(0, red - (green + blue) * 0.5 - 16)
          const redAmount = settings.deRedness * 0.4 * clamp(redness / 35, 0, 1)
          red -= redness * redAmount
          green += redness * redAmount * 0.22
          red += settings.rosiness * 7
          green -= settings.rosiness * 2
          const chromaShift = luminance(red, green, blue) - colorLight
          red -= chromaShift; green -= chromaShift; blue -= chromaShift
          if (settings.darkCircles > 0 && details?.underEyes[pixel]) {
            // Lift only a detected under-eye skin band, never the eyelid/eye.
            const shadow = Math.max(0, meanY - luminance(red, green, blue))
            const reduce = settings.darkCircles * details.underEyes[pixel] / 255
            const correction = Math.min(18, shadow * 0.32) * reduce
            red += correction; green += correction; blue += correction
          }
          light = luminance(red, green, blue)
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
    // Eyes, teeth and lips are separate, opt-in color operations. They do not
    // inherit the skin mask and never regenerate or move facial features.
    if (details) {
      for (let pixel = 0; pixel < count; pixel += 1) {
        const offset = pixel * 4
        if (source[offset + 3] === 0 || (protection && protection[pixel] > 0)) continue
        const r = source[offset], g = source[offset + 1], b = source[offset + 2]
        let red = r, green = g, blue = b, amount = 0
        if (subject.settings.teethWhitening !== undefined && details.teeth[pixel] && isTeethPixel(r, g, b)) {
          amount = details.teeth[pixel]
          const strength = settings.teethWhitening
          const light = luminance(r, g, b)
          const lift = Math.min(18, (255 - light) * 0.16) * strength
          const neutral = strength * 0.3
          red = r + (light - r) * neutral + lift
          green = g + (light - g) * neutral + lift
          blue = b + (light - b) * neutral + lift
        } else if (subject.settings.eyeWhitening !== undefined && details.eyes[pixel] && isEyeWhitePixel(r, g, b)) {
          amount = details.eyes[pixel]
          const strength = settings.eyeWhitening
          const light = luminance(r, g, b)
          const lift = Math.min(12, (255 - light) * 0.12) * strength
          red = r + (light - r) * strength * 0.22 + lift
          green = g + (light - g) * strength * 0.22 + lift
          blue = b + (light - b) * strength * 0.22 + lift
        } else if (subject.settings.lipColor !== undefined && details.lips[pixel] && isLipPixel(r, g, b)) {
          amount = details.lips[pixel]
          const strength = settings.lipColor
          red = r + Math.min(12, 255 - r) * strength
          green = g - Math.min(6, g * 0.05) * strength
          blue = b + 2 * strength
        }
        if (amount === 0 || amount <= detailCoverage[pixel]) continue
        detailCoverage[pixel] = amount
        const mix = amount / 255
        output[offset] = Math.round(r + (red - r) * mix)
        output[offset + 1] = Math.round(g + (green - g) * mix)
        output[offset + 2] = Math.round(b + (blue - b) * mix)
      }
    }
  }
  return output
}
