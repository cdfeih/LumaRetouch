import { createFaceContourMask, createFaceDetailMasks, createFaceDodgeBurnMask, createFaceSkinMask } from './detection'
import { isEyeWhitePixel, isLipPixel, isTeethPixel } from './retouch'
import type { PortraitFace } from './detection'
import type { NaturalRetouchSettings, PortraitDetailMasks } from './retouch'
import type { RetouchWorkerRequest, RetouchWorkerResponse } from './retouch.worker'
import { faceInRegion, planFaceWorkRegion, protectionInRegion } from './regions'
import { segmentFaceSkin, semanticCoverage } from './semantic-skin'

export type NaturalRetouchSubject = { face: PortraitFace; settings: NaturalRetouchSettings }
export type NaturalRetouchOptions = {
  protection?: HTMLCanvasElement | null
  selection?: HTMLCanvasElement | null
  signal?: AbortSignal
  /** Unselected faces also remain barriers during local neighborhood analysis. */
  excludedFaces?: PortraitFace[]
  /** Geometry-only mode is reserved for analytic synthetic fixtures. The
   * production default also excludes uncertain/non-face semantic regions. */
  skinProtection?: 'semantic' | 'geometry'
}

const MAX_PIXELS = 40_000_000

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

/** Any source protection coverage survives resampling to the worker grid. */
export function scaleProtectionAlpha(source: Uint8ClampedArray, width: number, height: number, targetWidth: number, targetHeight: number): Uint8ClampedArray {
  if (![width, height, targetWidth, targetHeight].every(value => Number.isSafeInteger(value) && value > 0)
    || source.length !== width * height) throw new Error('人像保护区缩放尺寸不一致。')
  const result = new Uint8ClampedArray(targetWidth * targetHeight)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!source[y * width + x]) continue
    const left = Math.floor(x * targetWidth / width), right = Math.ceil((x + 1) * targetWidth / width)
    const top = Math.floor(y * targetHeight / height), bottom = Math.ceil((y + 1) * targetHeight / height)
    for (let row = top; row < bottom; row++) result.fill(255, row * targetWidth + left, row * targetWidth + right)
  }
  return result
}

const OTHER_SKIN_CONTROLS = ['smoothing', 'blemish', 'evenness', 'brightening', 'shine', 'warmth', 'deYellow', 'deRedness', 'rosiness'] as const
const COLOR_CONTROLS = [...OTHER_SKIN_CONTROLS, 'dodgeBurn', 'darkCircles', 'teethWhitening', 'eyeWhitening', 'lipColor'] as const
const isDodgeBurnSkinOnly = (settings: NaturalRetouchSettings) => OTHER_SKIN_CONTROLS.every(key => !settings[key])

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
      worker.postMessage(request, [request.source, ...(request.protection ? [request.protection] : []),
        ...request.subjects.flatMap(subject => [subject.mask, ...(subject.dodgeBurnMask ? [subject.dodgeBurnMask] : []), ...Object.values(subject.details ?? {})])])
    } catch { finish(); reject(new Error('图片无法传入本地精修线程，请重试。')) }
  })
}

/** Add only color-qualified detail pixels to an original-resolution edit gate. */
export function includePortraitDetailPixels(
  editable: Uint8ClampedArray,
  details: PortraitDetailMasks,
  source: Uint8ClampedArray,
  settings: NaturalRetouchSettings,
  adjustment?: Uint8ClampedArray,
): void {
  if (source.length !== editable.length * 4 || (adjustment && adjustment.length !== editable.length) || Object.values(details).some(mask => mask.length !== editable.length)) throw new Error('人像细节合成尺寸不一致。')
  for (let pixel = 0; pixel < editable.length; pixel++) {
    const offset = pixel * 4, r = source[offset], g = source[offset + 1], b = source[offset + 2]
    const teeth = details.teeth[pixel] && isTeethPixel(r, g, b)
    const eyes = details.eyes[pixel] && isEyeWhitePixel(r, g, b)
    const lips = details.lips[pixel] && isLipPixel(r, g, b)
    if ((settings.teethWhitening !== undefined && teeth) || (settings.eyeWhitening !== undefined && eyes)
      || (settings.lipColor !== undefined && lips)) editable[pixel] = 255
    if (adjustment && (((settings.teethWhitening ?? 0) > 0 && teeth) || ((settings.eyeWhitening ?? 0) > 0 && eyes)
      || ((settings.lipColor ?? 0) > 0 && lips) || ((settings.darkCircles ?? 0) > 0 && details.underEyes[pixel]))) adjustment[pixel] = 255
  }
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
  dimensions: { width: number; height: number; workWidth: number; workHeight: number; startY: number; achromatic?: boolean },
  protection?: Uint8ClampedArray | null,
  selection?: Uint8ClampedArray | null,
  adjustment?: Uint8ClampedArray | null,
  achromatic?: Uint8ClampedArray | null,
): boolean {
  const { width, height, workWidth, workHeight, startY } = dimensions
  if (![width, height, workWidth, workHeight].every(value => Number.isSafeInteger(value) && value > 0)
    || !Number.isSafeInteger(startY) || startY < 0
    || baseline.length !== current.length || current.length % 4 !== 0 || skin.length !== current.length / 4
    || skin.length % width !== 0 || startY + skin.length / width > height
    || (protection && protection.length !== skin.length) || (selection && selection.length !== skin.length)
    || (adjustment && adjustment.length !== skin.length) || (achromatic && achromatic.length !== skin.length)
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
      let achromaticDelta: number | null = null
      if (dimensions.achromatic || achromatic?.[pixel]) {
        const upper = delta[a] * (1 - fx) + delta[b] * fx
        const lower = delta[c] * (1 - fx) + delta[d] * fx
        const requested = (upper * (1 - fy) + lower * fy) * (adjustment ? adjustment[pixel] / 255 : 1)
        // Original pixels may have brighter highlights than the downsampled
        // work image. One shared limit preserves chroma and prevents clipping.
        achromaticDelta = Math.max(-Math.max(0, Math.min(baseline[offset], baseline[offset + 1], baseline[offset + 2]) - 1),
          Math.min(Math.max(0, 254 - Math.max(baseline[offset], baseline[offset + 1], baseline[offset + 2])), requested))
      }
      for (let channel = 0; channel < 3; channel += 1) {
        const top = delta[a + channel] * (1 - fx) + delta[b + channel] * fx
        const bottom = delta[c + channel] * (1 - fx) + delta[d + channel] * fx
        const target = baseline[offset + channel] + (achromaticDelta ?? (top * (1 - fy) + bottom * fy) * (adjustment ? adjustment[pixel] / 255 : 1))
        const value = Math.round(Math.max(0, Math.min(255, baseline[offset + channel] + (target - baseline[offset + channel]) * amount)))
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
    const protectionPixels = protection ? alphaChannel(protection.getContext('2d')!.getImageData(0, 0, protection.width, protection.height).data) : null
    const target = make(width, height)
    target.context.drawImage(currentImage, 0, 0)
    let changed = false
    // One bounded work crop/Worker at a time. A distant face retains its native
    // pixels even on a 40MP photo; no full-photo mask/delta per person is kept.
    for (let subjectIndex = 0; subjectIndex < subjects.length; subjectIndex++) {
      checkAbort(signal)
      const subject = subjects[subjectIndex], settings = subject.settings
      const region = planFaceWorkRegion(subject.face, width, height)
      const localFace = faceInRegion(subject.face, width, height, region)
      const { workWidth, workHeight } = region
      const work = make(workWidth, workHeight)
      work.context.drawImage(baselineImage, region.x, region.y, region.width, region.height, 0, 0, workWidth, workHeight)
      const workSource = work.context.getImageData(0, 0, workWidth, workHeight).data
      const workSkin = createFaceSkinMask(localFace, workWidth, workHeight)
      const hasDodgeBurn = (settings.dodgeBurn ?? 0) > 0
      const workDodge = hasDodgeBurn ? createFaceDodgeBurnMask(localFace, workWidth, workHeight) : null
      const hasDetails = ['darkCircles', 'teethWhitening', 'eyeWhitening', 'lipColor'].some(key => settings[key as keyof NaturalRetouchSettings] !== undefined)
      const workDetails = hasDetails ? createFaceDetailMasks(localFace, workWidth, workHeight) : null
      const workDetailMasks = Object.values(workDetails ?? {})
      const workProtection = protectionPixels && protection ? protectionInRegion(protectionPixels, protection.width, protection.height, width, height, region, workWidth, workHeight) : null
      const activeSettings = COLOR_CONTROLS.some(key => { const value = settings[key]; return typeof value === 'number' && Number.isFinite(value) && value !== 0 })
      const semantic = options.skinProtection !== 'geometry' && activeSettings ? await segmentFaceSkin(work.canvas, signal) : null
      if (semantic) for (let y = 0; y < workHeight; y++) for (let x = 0; x < workWidth; x++) {
        const p = y * workWidth + x, coverage = semanticCoverage(semantic, x, y, workWidth, workHeight) / 255
        workSkin[p] = Math.round(workSkin[p] * coverage)
        if (workDodge) workDodge[p] = Math.round(workDodge[p] * coverage)
        for (const mask of workDetailMasks) mask[p] = Math.round(mask[p] * coverage)
      }
      // Overlapping face silhouettes have unknown depth. Conservatively leave
      // their overlap alone instead of blending one person's skin into another.
      const others = [...subjects.filter((_, index) => index !== subjectIndex).map(item => item.face), ...(options.excludedFaces ?? [])]
      const overlappingFaces: PortraitFace[] = []
      for (const other of others) {
        const a = other.bounds, b = subject.face.bounds
        if (a.x >= b.x + b.width || a.x + a.width <= b.x || a.y >= b.y + b.height || a.y + a.height <= b.y) continue
        const localOther = faceInRegion(other, width, height, region)
        overlappingFaces.push(localOther)
        const smallOther = createFaceContourMask(localOther, workWidth, workHeight)
        for (let p = 0; p < workSkin.length; p++) if (smallOther[p]) {
          workSkin[p] = 0; if (workDodge) workDodge[p] = 0
          for (const mask of workDetailMasks) mask[p] = 0
        }
      }
      const delta = await runWorker({ source: workSource.buffer as ArrayBuffer, width: workWidth, height: workHeight,
        subjects: [{ mask: workSkin.buffer as ArrayBuffer, dodgeBurnMask: workDodge?.buffer as ArrayBuffer | undefined, settings,
          details: workDetails ? { underEyes: workDetails.underEyes.buffer as ArrayBuffer, teeth: workDetails.teeth.buffer as ArrayBuffer, eyes: workDetails.eyes.buffer as ArrayBuffer, lips: workDetails.lips.buffer as ArrayBuffer } : undefined }],
        protection: workProtection?.buffer as ArrayBuffer | undefined }, signal)
      work.canvas.width = work.canvas.height = 1
      const otherSkinAdjustment = OTHER_SKIN_CONTROLS.some(key => { const value = settings[key as keyof NaturalRetouchSettings]; return typeof value === 'number' && Number.isFinite(value) && value !== 0 })
      const rows = Math.min(128, region.height), baseStrip = make(region.width, rows)
      const protectionStrip = protection ? make(region.width, rows) : null, selectionStrip = selection ? make(region.width, rows) : null
      if (protectionStrip) protectionStrip.context.imageSmoothingEnabled = false
      if (selectionStrip) selectionStrip.context.imageSmoothingEnabled = false
      for (let localY = 0; localY < region.height; localY += rows) {
        checkAbort(signal)
        const stripRows = Math.min(rows, region.height - localY), globalY = region.y + localY
        baseStrip.context.clearRect(0, 0, region.width, rows)
        baseStrip.context.drawImage(baselineImage, region.x, globalY, region.width, stripRows, 0, 0, region.width, stripRows)
        const before = baseStrip.context.getImageData(0, 0, region.width, stripRows), pixels = target.context.getImageData(region.x, globalY, region.width, stripRows)
        const maskAlpha = (mask: HTMLCanvasElement | null, strip: ReturnType<typeof surface> | null) => {
          if (!mask || !strip) return null
          strip.context.clearRect(0, 0, region.width, rows); strip.context.drawImage(mask, -region.x, -globalY, width, height)
          return alphaChannel(strip.context.getImageData(0, 0, region.width, stripRows).data)
        }
        const protectionAlpha = maskAlpha(protection, protectionStrip), selectionAlpha = maskAlpha(selection, selectionStrip)
        // Geometry is also built in bounded strips. 32px context covers the
        // 14px skin and 12px D&B/detail inward feathers before trimming; a
        // close-up on a 40MP photo never allocates a full-photo mask per face.
        const first = Math.max(0, localY - 32), end = Math.min(region.height, localY + stripRows + 32)
        const bandRegion = { x: 0, y: first, width: region.width, height: end - first }
        const band = faceInRegion(localFace, region.width, region.height, bandRegion)
        const offset = (localY - first) * region.width, count = region.width * stripRows
        const skin = createFaceSkinMask(band, region.width, end - first).subarray(offset, offset + count)
        const dodge = hasDodgeBurn ? createFaceDodgeBurnMask(band, region.width, end - first).subarray(offset, offset + count) : null
        const editable = new Uint8ClampedArray(region.width * stripRows)
        for (let p = 0; p < editable.length; p++) {
          if (skin[p]) editable[p] = otherSkinAdjustment ? 11 : 1
          if (dodge?.[p]) editable[p] |= isDodgeBurnSkinOnly(settings) ? 6 : 2
        }
        const adjustment = Uint8ClampedArray.from(editable, flags => flags & 2 ? 255 : 0)
        const achromatic = hasDodgeBurn ? Uint8ClampedArray.from(editable, flags => flags & 4 && !(flags & 8) ? 255 : 0) : null
        if (hasDetails) {
          const detailBand = createFaceDetailMasks(band, region.width, end - first)
          const details = Object.fromEntries(Object.entries(detailBand).map(([key, mask]) => [key, mask.subarray(offset, offset + count)])) as PortraitDetailMasks
          includePortraitDetailPixels(editable, details, before.data, settings, adjustment)
        }
        for (const other of overlappingFaces) {
          const otherBand = faceInRegion(other, region.width, region.height, bandRegion)
          const blocked = createFaceContourMask(otherBand, region.width, end - first).subarray(offset, offset + count)
          for (let p = 0; p < editable.length; p++) if (blocked[p]) editable[p] = 0
        }
        if (semantic) for (let y = 0; y < stripRows; y++) for (let x = 0; x < region.width; x++) {
          if (!semanticCoverage(semantic, x, localY + y, region.width, region.height)) editable[y * region.width + x] = 0
        }
        const stripChanged = mergeNaturalRetouchStrip(before.data, pixels.data, editable, delta,
          { width: region.width, height: region.height, workWidth, workHeight, startY: localY }, protectionAlpha, selectionAlpha, adjustment, achromatic)
        if (stripChanged) { target.context.putImageData(pixels, region.x, globalY); changed = true }
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      baseStrip.canvas.width = baseStrip.canvas.height = 1
      if (protectionStrip) protectionStrip.canvas.width = protectionStrip.canvas.height = 1
      if (selectionStrip) selectionStrip.canvas.width = selectionStrip.canvas.height = 1
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
