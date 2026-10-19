import { createFaceSkinMask } from './detection'
import type { PortraitFace } from './detection'
import type { NaturalRetouchSettings } from './retouch'
import type { RetouchWorkerRequest, RetouchWorkerResponse } from './retouch.worker'

export type NaturalRetouchSubject = { face: PortraitFace; settings: NaturalRetouchSettings }
export type NaturalRetouchOptions = {
  protection?: HTMLCanvasElement | null
  selection?: HTMLCanvasElement | null
  signal?: AbortSignal
}

const MAX_PIXELS = 40_000_000
const WORK_EDGE = 1600

function cancelled(): DOMException {
  return new DOMException('已取消本次自然精修。', 'AbortError')
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled()
}

function readImage(dataUrl: string, signal: AbortSignal): Promise<HTMLImageElement> {
  checkAbort(signal)
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) throw new Error('人像照片数据无效，请重新导入。')
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    const cleanup = () => {
      image.onload = image.onerror = null
      signal.removeEventListener('abort', abort)
    }
    const abort = () => { cleanup(); image.src = ''; reject(cancelled()) }
    image.onload = () => {
      cleanup()
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > MAX_PIXELS) {
        image.src = ''
        reject(new Error('照片尺寸无效或超过 4000 万像素，请缩小后重试。'))
      } else resolve(image)
    }
    image.onerror = () => { cleanup(); reject(new Error('照片解码失败，请重新导入后再进行自然精修。')) }
    signal.addEventListener('abort', abort, { once: true })
    image.src = dataUrl
  })
}

function surface(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('浏览器无法创建自然精修画布。')
  context.imageSmoothingQuality = 'high'
  return { canvas, context }
}

function maskHasPixels(canvas: HTMLCanvasElement | null | undefined): boolean {
  if (!canvas || canvas.width === 0 || canvas.height === 0) return false
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法读取人像编辑或保护选区。')
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) return true
  return false
}

function alphaChannel(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const result = new Uint8ClampedArray(rgba.length / 4)
  for (let pixel = 0; pixel < result.length; pixel += 1) result[pixel] = rgba[pixel * 4 + 3]
  return result
}

function runWorker(request: RetouchWorkerRequest, signal: AbortSignal): Promise<Int16Array> {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    let worker: Worker
    try { worker = new Worker(new URL('./retouch.worker.ts', import.meta.url), { type: 'module' }) }
    catch { reject(new Error('无法启动本地精修线程，请更新浏览器或使用安装版。')); return }
    const finish = () => { signal.removeEventListener('abort', abort); worker.terminate() }
    const abort = () => { finish(); reject(cancelled()) }
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<RetouchWorkerResponse>) => {
      finish()
      if (signal.aborted) { reject(cancelled()); return }
      if (!event.data.ok) { reject(new Error(event.data.error)); return }
      const delta = new Int16Array(event.data.delta)
      if (delta.length !== request.width * request.height * 3) reject(new Error('本地精修线程返回的图片尺寸不一致。'))
      else resolve(delta)
    }
    worker.onerror = () => { finish(); reject(new Error('本地自然精修线程加载或运行失败，请刷新后重试。')) }
    try {
      worker.postMessage(request, [request.source, ...request.subjects.map(subject => subject.mask)])
    } catch { finish(); reject(new Error('图片无法传入本地精修线程，请重试。')) }
  })
}

/**
 * In-place strip merge. Delta already includes the small skin mask's alpha;
 * full-resolution skin acts as an inward-only gate and is not multiplied again.
 * Protection is binary. Green selection alpha blends toward the fixed baseline
 * result; zero green/protected/non-skin pixels retain every current RGBA byte.
 */
export function mergeNaturalRetouchStrip(
  baseline: Uint8ClampedArray,
  current: Uint8ClampedArray,
  skin: Uint8ClampedArray,
  delta: Int16Array,
  dimensions: { width: number; height: number; workWidth: number; workHeight: number; startY: number },
  protection?: Uint8ClampedArray | null,
  selection?: Uint8ClampedArray | null,
): boolean {
  const { width, height, workWidth, workHeight, startY } = dimensions
  if (![width, height, workWidth, workHeight].every(value => Number.isSafeInteger(value) && value > 0)
    || !Number.isSafeInteger(startY) || startY < 0
    || baseline.length !== current.length || current.length % 4 !== 0 || skin.length !== current.length / 4
    || skin.length % width !== 0 || startY + skin.length / width > height
    || (protection && protection.length !== skin.length) || (selection && selection.length !== skin.length)
    || delta.length !== workWidth * workHeight * 3) throw new Error('自然精修合成像素尺寸不一致。')
  let changed = false
  const rows = skin.length / width
  for (let row = 0; row < rows; row += 1) {
    const sampleY = Math.max(0, Math.min(workHeight - 1, (startY + row + 0.5) * workHeight / height - 0.5))
    const y0 = Math.floor(sampleY), y1 = Math.min(workHeight - 1, y0 + 1), fy = sampleY - y0
    for (let x = 0; x < width; x += 1) {
      const pixel = row * width + x, offset = pixel * 4
      if (skin[pixel] === 0 || baseline[offset + 3] === 0 || (protection && protection[pixel] > 0)
        || (selection && selection[pixel] === 0)) continue
      const sampleX = Math.max(0, Math.min(workWidth - 1, (x + 0.5) * workWidth / width - 0.5))
      const x0 = Math.floor(sampleX), x1 = Math.min(workWidth - 1, x0 + 1), fx = sampleX - x0
      const a = (y0 * workWidth + x0) * 3, b = (y0 * workWidth + x1) * 3
      const c = (y1 * workWidth + x0) * 3, d = (y1 * workWidth + x1) * 3
      const amount = selection ? selection[pixel] / 255 : 1
      for (let channel = 0; channel < 3; channel += 1) {
        const top = delta[a + channel] * (1 - fx) + delta[b + channel] * fx
        const bottom = delta[c + channel] * (1 - fx) + delta[d + channel] * fx
        const target = baseline[offset + channel] + top * (1 - fy) + bottom * fy
        const value = Math.round(Math.max(0, Math.min(255, current[offset + channel] + (target - current[offset + channel]) * amount)))
        if (value !== current[offset + channel]) changed = true
        current[offset + channel] = value
      }
    }
  }
  return changed
}

function encodePng(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<string> {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    let reader: FileReader | null = null
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reader?.abort(); reject(cancelled()) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      canvas.toBlob(blob => {
        if (signal.aborted) return
        if (!blob) { cleanup(); reject(new Error('自然精修结果编码失败，设备可能内存不足。')); return }
        reader = new FileReader()
        reader.onload = () => { cleanup(); resolve(reader!.result as string) }
        reader.onerror = () => { cleanup(); reject(new Error('读取自然精修结果失败，请重试。')) }
        reader.readAsDataURL(blob)
      }, 'image/png')
    } catch { cleanup(); reject(new Error('自然精修结果编码失败，请尝试较小的照片。')) }
  })
}

/** Face finishing from a fixed source, with current outside all editable skin retained. */
export async function renderNaturalRetouch(
  baseline: string,
  current: string,
  subjects: NaturalRetouchSubject[],
  options: NaturalRetouchOptions = {},
): Promise<string> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const signal = controller.signal
  const surfaces: HTMLCanvasElement[] = []
  let baselineImage: HTMLImageElement | undefined, currentImage: HTMLImageElement | undefined
  const make = (w: number, h: number) => { const result = surface(w, h); surfaces.push(result.canvas); return result }
  try {
    checkAbort(signal)
    if (subjects.length === 0) return current
    const images = await Promise.all([readImage(baseline, signal), baseline === current ? Promise.resolve(null) : readImage(current, signal)])
    baselineImage = images[0]; currentImage = images[1] ?? baselineImage
    const width = baselineImage.naturalWidth, height = baselineImage.naturalHeight
    if (currentImage.naturalWidth !== width || currentImage.naturalHeight !== height) throw new Error('当前照片与自然精修基准的尺寸不一致，请重新识别人像。')
    checkAbort(signal)
    const snapshot = (mask: HTMLCanvasElement | null | undefined) => {
      if (!maskHasPixels(mask)) return null
      const frozen = make(mask!.width, mask!.height)
      frozen.context.drawImage(mask!, 0, 0)
      return frozen.canvas
    }
    const selection = snapshot(options.selection)
    const protection = snapshot(options.protection)
    const scale = Math.min(1, WORK_EDGE / Math.max(width, height))
    const workWidth = Math.max(1, Math.round(width * scale)), workHeight = Math.max(1, Math.round(height * scale))
    const work = make(workWidth, workHeight)
    work.context.drawImage(baselineImage, 0, 0, workWidth, workHeight)
    const workSource = work.context.getImageData(0, 0, workWidth, workHeight).data
    const workSubjects = subjects.map(subject => ({ mask: createFaceSkinMask(subject.face, workWidth, workHeight).buffer as ArrayBuffer, settings: subject.settings }))
    const delta = await runWorker({ source: workSource.buffer as ArrayBuffer, width: workWidth, height: workHeight, subjects: workSubjects }, signal)
    work.canvas.width = work.canvas.height = 1
    checkAbort(signal)
    const union = new Uint8ClampedArray(width * height)
    for (const subject of subjects) {
      const mask = createFaceSkinMask(subject.face, width, height)
      for (let pixel = 0; pixel < union.length; pixel += 1) union[pixel] = Math.max(union[pixel], mask[pixel])
      checkAbort(signal)
    }
    const target = make(width, height)
    target.context.drawImage(currentImage, 0, 0)
    // Only two small RGBA strips are read. No full-resolution RGBA copy of the
    // baseline or each person's mask is retained alongside current output.
    const rows = Math.min(128, height), baseStrip = make(width, rows)
    const protectionStrip = protection ? make(width, rows) : null
    if (protectionStrip) protectionStrip.context.imageSmoothingEnabled = false
    const selectionStrip = selection ? make(width, rows) : null
    // Keep the user's zero-alpha green region a hard spatial limit. Brush alpha
    // still feathers within its own selected pixels, without interpolation spill.
    if (selectionStrip) selectionStrip.context.imageSmoothingEnabled = false
    let changed = false
    for (let y = 0; y < height; y += rows) {
      checkAbort(signal)
      const stripRows = Math.min(rows, height - y)
      baseStrip.context.clearRect(0, 0, width, rows)
      baseStrip.context.drawImage(baselineImage, 0, -y, width, height)
      const before = baseStrip.context.getImageData(0, 0, width, stripRows)
      const pixels = target.context.getImageData(0, y, width, stripRows)
      let protectionAlpha: Uint8ClampedArray | null = null, selectionAlpha: Uint8ClampedArray | null = null
      if (protection && protectionStrip) {
        protectionStrip.context.clearRect(0, 0, width, rows)
        protectionStrip.context.drawImage(protection, 0, -y, width, height)
        protectionAlpha = alphaChannel(protectionStrip.context.getImageData(0, 0, width, stripRows).data)
      }
      if (selection && selectionStrip) {
        selectionStrip.context.clearRect(0, 0, width, rows)
        selectionStrip.context.drawImage(selection, 0, -y, width, height)
        selectionAlpha = alphaChannel(selectionStrip.context.getImageData(0, 0, width, stripRows).data)
      }
      const stripChanged = mergeNaturalRetouchStrip(before.data, pixels.data, union.subarray(y * width, (y + stripRows) * width), delta,
        { width, height, workWidth, workHeight, startY: y }, protectionAlpha, selectionAlpha)
      if (stripChanged) { target.context.putImageData(pixels, 0, y); changed = true }
      // Yield so cancellation and pointer/UI events can run during large exports.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    checkAbort(signal)
    return changed ? await encodePng(target.canvas, signal) : current
  } finally {
    controller.abort()
    options.signal?.removeEventListener('abort', abort)
    if (baselineImage) baselineImage.src = ''
    if (currentImage && currentImage !== baselineImage) currentImage.src = ''
    for (const canvas of surfaces) canvas.width = canvas.height = 1
  }
}
