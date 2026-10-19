export interface Adjustments {
  /** Exposure compensation in EV, from -2 to 2. */
  exposure: number
  /** Local RGB contrast and saturation changes, from -50 to 50 percent. */
  contrast: number
  saturation: number
  /** Positive values move toward amber, negative values toward blue. */
  temperature: number
  /** Positive values move toward magenta, negative values toward green. */
  tint: number
}

export const DEFAULT_ADJUSTMENTS: Readonly<Adjustments> = Object.freeze({
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
})

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function checkBuffers(original: Uint8ClampedArray, other: Uint8ClampedArray): void {
  if (original.length % 4 !== 0 || original.length !== other.length) {
    throw new Error('像素缓冲区的尺寸不一致。')
  }
}

/** The drawing surface uses transparent pixels for protection and alpha for selection. */
export function hasMaskSelection(mask: Uint8ClampedArray): boolean {
  for (let i = 3; i < mask.length; i += 4) {
    if (mask[i] > 0) return true
  }
  return false
}

/**
 * Blend an edit using source-over alpha composition. Zero mask coverage preserves
 * every original byte. Passing original as output is safe and avoids another copy.
 */
export function compositePixelBuffers(
  original: Uint8ClampedArray,
  edited: Uint8ClampedArray,
  mask: Uint8ClampedArray | null,
  blend: number,
  output = new Uint8ClampedArray(original.length),
): Uint8ClampedArray {
  checkBuffers(original, edited)
  checkBuffers(original, output)
  if (mask) checkBuffers(original, mask)
  const strength = clamp(blend, 0, 1)

  for (let i = 0; i < original.length; i += 4) {
    const coverage = strength * (mask ? mask[i + 3] / 255 : 1)
    const sourceAlpha = (edited[i + 3] / 255) * coverage
    if (sourceAlpha === 0) {
      output[i] = original[i]
      output[i + 1] = original[i + 1]
      output[i + 2] = original[i + 2]
      output[i + 3] = original[i + 3]
      continue
    }

    const destinationAlpha = original[i + 3] / 255
    const outAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha)
    for (let channel = 0; channel < 3; channel += 1) {
      output[i + channel] = Math.round(
        (edited[i + channel] * sourceAlpha
          + original[i + channel] * destinationAlpha * (1 - sourceAlpha)) / outAlpha,
      )
    }
    output[i + 3] = Math.round(outAlpha * 255)
  }
  return output
}

/** Convert the paint mask into transparent-editable OpenAI and white-editable guide masks. */
export function maskPixelBuffers(selection: Uint8ClampedArray): {
  mask: Uint8ClampedArray
  guide: Uint8ClampedArray
  hasSelection: boolean
} {
  if (selection.length % 4 !== 0) throw new Error('蒙版像素格式不正确。')
  const mask = new Uint8ClampedArray(selection.length)
  const guide = new Uint8ClampedArray(selection.length)
  let hasSelection = false
  for (let i = 0; i < selection.length; i += 4) {
    const coverage = selection[i + 3]
    hasSelection ||= coverage > 0
    mask[i] = mask[i + 1] = mask[i + 2] = 255
    mask[i + 3] = 255 - coverage
    guide[i] = guide[i + 1] = guide[i + 2] = coverage
    guide[i + 3] = 255
  }
  return { mask, guide, hasSelection }
}

/** RGB finishing controls; this is local color grading, not AI skin retouching. */
export function adjustPixelBuffer(
  input: Uint8ClampedArray,
  adjustments: Adjustments,
  output = new Uint8ClampedArray(input.length),
): Uint8ClampedArray {
  checkBuffers(input, output)
  const finite = (value: number) => Number.isFinite(value) ? value : 0
  const exposure = clamp(finite(adjustments.exposure), -2, 2)
  const contrast = clamp(finite(adjustments.contrast), -50, 50)
  const saturation = clamp(finite(adjustments.saturation), -50, 50)
  const temperature = clamp(finite(adjustments.temperature), -100, 100)
  const tint = clamp(finite(adjustments.tint), -100, 100)
  if (exposure === 0 && contrast === 0 && saturation === 0 && temperature === 0 && tint === 0) {
    if (output !== input) output.set(input)
    return output
  }

  const exposureGain = 2 ** exposure
  const contrastGain = 1 + contrast / 100
  const saturationGain = 1 + saturation / 100
  const redGain = (1 + temperature * 0.002) * (1 + tint * 0.00075)
  const greenGain = 1 - tint * 0.0015
  const blueGain = (1 - temperature * 0.002) * (1 + tint * 0.00075)

  for (let i = 0; i < input.length; i += 4) {
    const r = (input[i] * exposureGain * redGain - 127.5) * contrastGain + 127.5
    const g = (input[i + 1] * exposureGain * greenGain - 127.5) * contrastGain + 127.5
    const b = (input[i + 2] * exposureGain * blueGain - 127.5) * contrastGain + 127.5
    const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722
    output[i] = Math.round(luminance + (r - luminance) * saturationGain)
    output[i + 1] = Math.round(luminance + (g - luminance) * saturationGain)
    output[i + 2] = Math.round(luminance + (b - luminance) * saturationGain)
    output[i + 3] = input[i + 3]
  }
  return output
}
