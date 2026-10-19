export type LuminanceHistogram = number[] & { length: 64 }

export interface LuminanceAnalysis {
  /** 64 equal-width sRGB luminance bins, containing valid sample counts. */
  histogram: LuminanceHistogram
  /** sRGB luminance in the 0–255 range. */
  median: number
  shadowClipped: number
  highlightClipped: number
  suggestedExposure: number
  warnings: string[]
}

export interface PhotoAnalysis extends LuminanceAnalysis {
  width: number
  height: number
}

const linearLight = (encoded: number) => encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4

/** A scene-agnostic hint, not an exposure verdict or a detail-recovery tool. */
export function analyzeLuminance(pixels: Uint8ClampedArray): LuminanceAnalysis {
  if (pixels.length % 4 !== 0) throw new Error('照片体检的像素数据不完整。')
  const histogram = Array.from({ length: 64 }, () => 0) as LuminanceHistogram
  const precise = new Uint32Array(256)
  let count = 0, shadows = 0, highlights = 0
  for (let offset = 0; offset < pixels.length; offset += 4) {
    // Nearly transparent background is not useful photographic exposure data.
    if (pixels[offset + 3] < 128) continue
    const luminance = Math.round(pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722)
    precise[luminance]++
    histogram[Math.floor(luminance / 4)]++
    count++
    if (luminance <= 5) shadows++
    if (luminance >= 250) highlights++
  }
  if (!count) return { histogram, median: 128, shadowClipped: 0, highlightClipped: 0, suggestedExposure: 0, warnings: [] }

  const quantile = (fraction: number) => {
    const target = Math.max(1, Math.ceil(count * fraction))
    let total = 0
    for (let value = 0; value < precise.length; value++) {
      total += precise[value]
      if (total >= target) return value
    }
    return 255
  }
  const median = quantile(0.5), shadowClipped = shadows / count, highlightClipped = highlights / count
  const warnings: string[] = []
  let suggestedExposure = 0
  if (shadowClipped >= 0.98) {
    warnings.push('画面采样几乎全黑，可先检查原片；曝光调整不能找回原片没有记录的暗部细节。')
  } else if (highlightClipped >= 0.98) {
    warnings.push('画面采样几乎全白，可先检查原片；降低曝光不能找回原片没有记录的高光细节。')
  } else {
    // A broad neutral band avoids prescribing a change to every photo. Outside
    // it, use a conservative linear-light EV estimate rather than byte ratios.
    if (median > 0 && (median < 90 || median > 176)) {
      const estimate = Math.log2(linearLight(118 / 255) / linearLight(median / 255))
      suggestedExposure = Math.round(Math.max(-0.7, Math.min(0.7, estimate)) * 10) / 10
    }
    // Existing bright clipping or a bright top percentile vetoes more exposure.
    if (suggestedExposure > 0 && (highlightClipped >= 0.005 || quantile(0.99) >= 245)) suggestedExposure = 0
    if (median < 90) warnings.push('画面整体偏暗，可先检查主体亮度；夜景或逆光照片可能需要保留原有氛围。')
    if (median > 176) warnings.push('画面整体偏亮，可先检查主体和高光；雪景、白背景等场景可能本来就明亮。')
    if (shadowClipped > 0.08) warnings.push('接近纯黑的暗部较多，可放大检查；提亮可能放大噪点，不能保证恢复细节。')
    if (highlightClipped >= 0.005) warnings.push('部分高光接近纯白，建议先检查天空、皮肤或反光处，增加曝光可能加重过曝。')
  }
  return { histogram, median, shadowClipped, highlightClipped, suggestedExposure, warnings }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已取消照片体检。', 'AbortError')
}

/** Sample an oriented photo locally; no upload, mutation, or automatic edit. */
export async function analyzePhoto(source: string, signal?: AbortSignal): Promise<PhotoAnalysis> {
  checkAbort(signal)
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(source)) throw new Error('照片数据无效，请重新导入后体检。')
  let bitmap: ImageBitmap | null = null, image: HTMLImageElement | null = null, objectUrl: string | null = null
  let canvas: HTMLCanvasElement | null = null
  try {
    const blob = await (await fetch(source, { signal })).blob()
    checkAbort(signal)
    if (typeof createImageBitmap === 'function') {
      try { bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' }) }
      catch { checkAbort(signal) }
    }
    checkAbort(signal)
    let decoded: CanvasImageSource, width: number, height: number
    if (bitmap) { decoded = bitmap; width = bitmap.width; height = bitmap.height }
    else {
      image = new Image()
      image.decoding = 'async'
      objectUrl = URL.createObjectURL(blob)
      const pending = image
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { pending.onload = pending.onerror = null; signal?.removeEventListener('abort', abort) }
        const abort = () => { cleanup(); pending.src = ''; reject(new DOMException('已取消照片体检。', 'AbortError')) }
        pending.onload = () => { cleanup(); resolve() }
        pending.onerror = () => { cleanup(); reject(new Error('照片解码失败，请重新导入后体检。')) }
        signal?.addEventListener('abort', abort, { once: true })
        pending.src = objectUrl!
        if (signal?.aborted) abort()
      })
      decoded = image; width = image.naturalWidth; height = image.naturalHeight
    }
    checkAbort(signal)
    if (!width || !height || width * height > 40_000_000) throw new Error('照片尺寸无效或超过 4000 万像素。')
    const scale = Math.min(1, 512 / Math.max(width, height))
    canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('设备无法创建照片体检画布。')
    context.imageSmoothingQuality = 'high'
    context.drawImage(decoded, 0, 0, canvas.width, canvas.height)
    checkAbort(signal)
    const result = analyzeLuminance(context.getImageData(0, 0, canvas.width, canvas.height).data)
    if (Math.min(width, height) < 1080) result.warnings.push('原图短边小于 1080 像素，大幅裁剪或放大可能显得模糊；可优先使用相机原片。')
    return { ...result, width, height }
  } finally {
    bitmap?.close()
    if (image) image.src = ''
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    if (canvas) canvas.width = canvas.height = 1
  }
}
