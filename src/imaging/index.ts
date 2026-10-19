import {
  adjustPixelBuffer,
  clamp,
  compositePixelBuffers,
  hasMaskSelection,
  maskPixelBuffers,
} from './pixels'
import type { Adjustments } from './pixels'

export { DEFAULT_ADJUSTMENTS } from './pixels'
export type { Adjustments } from './pixels'

export const MAX_FILE_BYTES = 30 * 1024 * 1024
export const MAX_PHOTO_PIXELS = 40_000_000
export const DEFAULT_MODEL_EDGE = 2048

export interface LoadedPhoto {
  dataUrl: string
  width: number
  height: number
  name: string
  mimeType: string
}

interface DecodedImage {
  image: CanvasImageSource
  width: number
  height: number
  release: () => void
}

function canvas(width: number, height: number): {
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D
} {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width * height > MAX_PHOTO_PIXELS) {
    throw new Error('图片尺寸不受支持，请使用不超过 4000 万像素的照片。')
  }
  const element = document.createElement('canvas')
  element.width = width
  element.height = height
  const context = element.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('设备无法创建图片编辑画布。')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  return { canvas: element, context }
}

function assertSize(width: number, height: number): void {
  if (width < 1 || height < 1 || width * height > MAX_PHOTO_PIXELS) {
    throw new Error('照片超过 4000 万像素，请先缩小图片再导入。')
  }
}

function assertImageDataUrl(dataUrl: string): void {
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) {
    throw new Error('图片数据格式不正确，请重新导入照片。')
  }
}

async function decode(source: Blob | string): Promise<DecodedImage> {
  if (typeof source === 'string') assertImageDataUrl(source)
  // Explicitly honor EXIF orientation. ImageBitmap can be released as soon as the
  // image has been painted, keeping large photo allocations short-lived.
  if (typeof createImageBitmap === 'function') {
    try {
      const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
      return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() }
    } catch {
      // Some WebViews decode formats in <img> that ImageBitmap does not support.
    }
  }
  const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source)
  const image = new Image()
  image.decoding = 'async'
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('无法读取这张照片。请使用 JPEG、PNG 或 WebP；RAW 暂不支持。'))
      image.src = objectUrl ?? source as string
    })
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => {
        image.src = ''
        if (objectUrl) URL.revokeObjectURL(objectUrl)
      },
    }
  } catch (error) {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    throw error
  }
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('读取照片文件失败，请重试。'))
    reader.readAsDataURL(file)
  })
}

function toDataUrl(element: HTMLCanvasElement, mimeType = 'image/png', quality?: number): string {
  try {
    const result = element.toDataURL(mimeType, quality)
    if (result === 'data:,') throw new Error('empty canvas')
    return result
  } catch {
    throw new Error('图片编码失败，可能是设备内存不足。请尝试较小的照片。')
  }
}

export function dataUrlBase64(dataUrl: string): string {
  const separator = dataUrl.indexOf(',')
  if (separator < 0) throw new Error('图片数据格式不正确。')
  return dataUrl.slice(separator + 1)
}

/** Retain the compressed original; editing always happens on a separate canvas. */
export async function loadPhoto(file: File): Promise<LoadedPhoto> {
  if (file.size === 0) throw new Error('照片文件为空。')
  if (file.size > MAX_FILE_BYTES) throw new Error('单张照片不能超过 30 MB，请先压缩或缩小照片。')
  if (/\.(?:rw2|raw|dng|arw|cr2|cr3|nef|orf|raf)$/i.test(file.name)) {
    throw new Error('暂不支持 RAW，请在相机或电脑中导出 JPEG、PNG 或 WebP。')
  }
  if (file.type && !file.type.startsWith('image/')) throw new Error('请选择照片文件。')
  const image = await decode(file)
  let dimensions: { width: number; height: number }
  try {
    assertSize(image.width, image.height)
    dimensions = { width: image.width, height: image.height }
  } finally {
    image.release()
  }
  let dataUrl = await readDataUrl(file)
  const mimeType = file.type || inferMimeType(file.name)
  // Files from drag-and-drop can omit MIME. A valid data:image prefix is needed
  // for subsequent offline decoding, so repair it without changing photo bytes.
  if (!dataUrl.startsWith('data:image/')) dataUrl = `data:${mimeType};base64,${dataUrlBase64(dataUrl)}`
  return { dataUrl, ...dimensions, name: file.name, mimeType }
}

function inferMimeType(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase()
  const types: Record<string, string> = {
    png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', bmp: 'image/bmp',
  }
  return types[extension ?? ''] ?? 'image/jpeg'
}

export async function resizeForModel(dataUrl: string, maxEdge = DEFAULT_MODEL_EDGE): Promise<{
  base64: string; mimeType: string; width: number; height: number
}> {
  if (!Number.isFinite(maxEdge) || maxEdge < 1 || maxEdge > 4096) {
    throw new Error('模型图片长边必须介于 1 和 4096 像素之间。')
  }
  const image = await decode(dataUrl)
  try {
    assertSize(image.width, image.height)
    const scale = Math.min(1, Math.floor(maxEdge) / Math.max(image.width, image.height))
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    const target = canvas(width, height)
    target.context.fillStyle = '#ffffff'
    target.context.fillRect(0, 0, width, height)
    target.context.drawImage(image.image, 0, 0, width, height)
    return { base64: dataUrlBase64(toDataUrl(target.canvas, 'image/jpeg', 0.94)), mimeType: 'image/jpeg', width, height }
  } finally {
    image.release()
  }
}

export async function createMaskPayload(maskCanvas: HTMLCanvasElement, width: number, height: number): Promise<{
  maskBase64: string; maskGuideBase64: string; hasSelection: boolean
}> {
  const selection = canvas(width, height)
  selection.context.drawImage(maskCanvas, 0, 0, width, height)
  const pixels = selection.context.getImageData(0, 0, width, height)
  const result = maskPixelBuffers(pixels.data)
  pixels.data.set(result.mask)
  selection.context.putImageData(pixels, 0, 0)
  const maskBase64 = dataUrlBase64(toDataUrl(selection.canvas))
  pixels.data.set(result.guide)
  selection.context.putImageData(pixels, 0, 0)
  return { maskBase64, maskGuideBase64: dataUrlBase64(toDataUrl(selection.canvas)), hasSelection: result.hasSelection }
}

/** Keep temporary pixel buffers in strips instead of copying full 40 MP images. */
export async function composeEdit(
  originalDataUrl: string,
  editedDataUrl: string,
  maskCanvas: HTMLCanvasElement | null,
  blend: number,
): Promise<string> {
  const original = await decode(originalDataUrl)
  let target: ReturnType<typeof canvas>
  try {
    assertSize(original.width, original.height)
    target = canvas(original.width, original.height)
    target.context.drawImage(original.image, 0, 0)
  } finally {
    original.release()
  }
  if (clamp(blend, 0, 1) === 0) return toDataUrl(target.canvas)
  const edited = await decode(editedDataUrl)
  try {
    assertSize(edited.width, edited.height)
    const { width, height } = target.canvas
    const originalAspect = width / height
    const editedAspect = edited.width / edited.height
    if (Math.abs(editedAspect / originalAspect - 1) > 0.03) {
      throw new Error('模型返回画幅与原图不一致，已保留当前照片。请补充“保持原图画幅和构图”的要求，或更换模型后重试。')
    }
    const stripHeight = Math.min(256, height)
    const editStrip = canvas(width, stripHeight)
    const maskStrip = maskCanvas ? canvas(width, stripHeight) : null
    const maskContext = maskCanvas?.getContext('2d')
    const selected = maskCanvas && maskContext
      ? hasMaskSelection(maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data)
      : false
    for (let y = 0; y < height; y += stripHeight) {
      const rows = Math.min(stripHeight, height - y)
      editStrip.context.clearRect(0, 0, width, stripHeight)
      editStrip.context.drawImage(edited.image, 0, -y, width, height)
      const originalPixels = target.context.getImageData(0, y, width, rows)
      const editPixels = editStrip.context.getImageData(0, 0, width, rows)
      let maskPixels: Uint8ClampedArray | null = null
      if (selected && maskCanvas && maskStrip) {
        maskStrip.context.clearRect(0, 0, width, stripHeight)
        maskStrip.context.drawImage(maskCanvas, 0, -y, width, height)
        maskPixels = maskStrip.context.getImageData(0, 0, width, rows).data
      }
      compositePixelBuffers(originalPixels.data, editPixels.data, maskPixels, blend, originalPixels.data)
      target.context.putImageData(originalPixels, 0, y)
    }
    return toDataUrl(target.canvas)
  } finally {
    edited.release()
  }
}

export async function applyAdjustments(dataUrl: string, adjustments: Adjustments): Promise<string> {
  const image = await decode(dataUrl)
  let target: ReturnType<typeof canvas>
  try {
    assertSize(image.width, image.height)
    target = canvas(image.width, image.height)
    target.context.drawImage(image.image, 0, 0)
  } finally {
    image.release()
  }
  for (let y = 0; y < target.canvas.height; y += 256) {
    const rows = Math.min(256, target.canvas.height - y)
    const pixels = target.context.getImageData(0, y, target.canvas.width, rows)
    adjustPixelBuffer(pixels.data, adjustments, pixels.data)
    target.context.putImageData(pixels, 0, y)
  }
  return toDataUrl(target.canvas)
}

export async function encodeExport(dataUrl: string, format: 'jpeg' | 'png', quality = 0.94): Promise<{
  base64: string; mimeType: string
}> {
  const image = await decode(dataUrl)
  try {
    assertSize(image.width, image.height)
    const target = canvas(image.width, image.height)
    if (format === 'jpeg') {
      target.context.fillStyle = '#ffffff'
      target.context.fillRect(0, 0, image.width, image.height)
    }
    target.context.drawImage(image.image, 0, 0)
    const mimeType = `image/${format}`
    return { base64: dataUrlBase64(toDataUrl(target.canvas, mimeType, clamp(quality, 0, 1))), mimeType }
  } finally {
    image.release()
  }
}
