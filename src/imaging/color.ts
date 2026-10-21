import { clamp } from './pixels'

export const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const
export type HslBand = typeof HSL_BANDS[number]
export interface HslAdjustment { hue: number; saturation: number; luminance: number }
export interface CurvePoint { x: number; y: number }
export interface AdvancedColorSettings {
  highlights: number
  shadows: number
  hsl: Record<HslBand, HslAdjustment>
  /** RGB composite curve; coordinates are normalized 0..1. */
  curve: CurvePoint[]
}

export const DEFAULT_ADVANCED_COLOR: Readonly<AdvancedColorSettings> = Object.freeze({
  highlights: 0, shadows: 0,
  hsl: Object.freeze(Object.fromEntries(HSL_BANDS.map(band => [band, Object.freeze({ hue: 0, saturation: 0, luminance: 0 })])) as Record<HslBand, HslAdjustment>),
  curve: Object.freeze([Object.freeze({ x: 0, y: 0 }), Object.freeze({ x: 1, y: 1 })]) as unknown as CurvePoint[],
})

const finite = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const adjustment = (value: unknown) => clamp(finite(value), -100, 100)

/** Bound imported settings and return independently owned, serializable values. */
export function normalizeAdvancedColor(input?: Partial<AdvancedColorSettings> | null): AdvancedColorSettings {
  const hsl = Object.fromEntries(HSL_BANDS.map(band => {
    const item = input?.hsl?.[band]
    return [band, { hue: adjustment(item?.hue), saturation: adjustment(item?.saturation), luminance: adjustment(item?.luminance) }]
  })) as Record<HslBand, HslAdjustment>
  const points = new Map<number, number>([[0, 0], [1, 1]])
  if (Array.isArray(input?.curve)) for (const point of input.curve.slice(0, 16)) {
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) points.set(clamp(point.x, 0, 1), clamp(point.y, 0, 1))
  }
  return { highlights: adjustment(input?.highlights), shadows: adjustment(input?.shadows), hsl,
    curve: [...points].sort(([a], [b]) => a - b).map(([x, y]) => ({ x, y })) }
}

export function hasAdvancedColor(input?: Partial<AdvancedColorSettings> | null): boolean {
  const value = normalizeAdvancedColor(input)
  return value.highlights !== 0 || value.shadows !== 0 || value.curve.some(point => point.x !== point.y)
    || HSL_BANDS.some(band => Object.values(value.hsl[band]).some(amount => amount !== 0))
}

/** Piecewise linear curves are predictable: no cubic overshoot or hidden clipping. */
export function createCurveLut(points: CurvePoint[]): Float64Array {
  const curve = normalizeAdvancedColor({ curve: points }).curve
  let segment = 0
  return Float64Array.from({ length: 256 }, (_, byte) => {
    const x = byte / 255
    while (segment < curve.length - 2 && x > curve[segment + 1].x) segment++
    const a = curve[segment], b = curve[segment + 1]
    const fraction = (x - a.x) / (b.x - a.x)
    return 255 * (a.y + fraction * (b.y - a.y))
  })
}

const HUE_CENTERS = [0, 30, 60, 120, 180, 240, 275, 315, 360]
function hslOffset(hue: number, hsl: Record<HslBand, HslAdjustment>): HslAdjustment {
  let section = 0
  while (section < 7 && hue >= HUE_CENTERS[section + 1]) section++
  const t = (hue - HUE_CENTERS[section]) / (HUE_CENTERS[section + 1] - HUE_CENTERS[section])
  const weight = t * t * (3 - 2 * t)
  const a = hsl[HSL_BANDS[section]], b = hsl[HSL_BANDS[(section + 1) % 8]]
  return { hue: a.hue * (1 - weight) + b.hue * weight,
    saturation: a.saturation * (1 - weight) + b.saturation * weight,
    luminance: a.luminance * (1 - weight) + b.luminance * weight }
}

function hueComponent(p: number, q: number, t: number): number {
  t = (t + 1) % 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

/** Finishing in 8-bit sRGB; this is deliberately not a RAW-domain / 16-bit claim. */
export function adjustAdvancedPixelBuffer(input: Uint8ClampedArray, inputSettings: Partial<AdvancedColorSettings>, output = new Uint8ClampedArray(input.length)): Uint8ClampedArray {
  if (input.length % 4 || output.length !== input.length) throw new Error('像素缓冲区的尺寸不一致。')
  const settings = normalizeAdvancedColor(inputSettings)
  if (!hasAdvancedColor(settings)) { if (output !== input) output.set(input); return output }
  const hasHsl = HSL_BANDS.some(band => Object.values(settings.hsl[band]).some(amount => amount !== 0))
  const curve = settings.curve.some(point => point.x !== point.y) ? createCurveLut(settings.curve) : null
  for (let i = 0; i < input.length; i += 4) {
    let r = input[i] / 255, g = input[i + 1] / 255, b = input[i + 2] / 255
    if (hasHsl) {
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
      if (d > 1e-6) {
        let l = (max + min) / 2
        let s = d / (1 - Math.abs(2 * l - 1))
        let h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60
        const offset = hslOffset(h, settings.hsl)
        h = ((h + offset.hue * .3 + 360) % 360) / 360
        s = clamp(s * (1 + offset.saturation / 100), 0, 1)
        l = clamp(l + offset.luminance / 100 * .6 * (offset.luminance >= 0 ? 1 - l : l), 0, 1)
        const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
        r = hueComponent(p, q, h + 1 / 3); g = hueComponent(p, q, h); b = hueComponent(p, q, h - 1 / 3)
      }
    }
    const y = r * .2126 + g * .7152 + b * .0722
    const delta = .25 * (settings.shadows / 100 * (1 - y) ** 3 + settings.highlights / 100 * y ** 3)
    r = clamp(r + delta, 0, 1); g = clamp(g + delta, 0, 1); b = clamp(b + delta, 0, 1)
    const lookup = (value: number) => {
      if (!curve) return value * 255
      const x = value * 255, low = Math.floor(x), high = Math.min(255, low + 1)
      return curve[low] + (curve[high] - curve[low]) * (x - low)
    }
    output[i] = Math.round(lookup(r)); output[i + 1] = Math.round(lookup(g)); output[i + 2] = Math.round(lookup(b)); output[i + 3] = input[i + 3]
  }
  return output
}
