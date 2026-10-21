import type { RawDecodeOptions, RawMetadata, RawWorkerReply } from './types'
export type { RawDecodeOptions, RawMetadata } from './types'

export const MAX_RAW_FILE_BYTES = 80 * 1024 * 1024
export const RAW_EXTENSIONS = /\.(?:rw2|raw|dng|arw|cr2|cr3|nef|nrw|orf|raf|pef|srw|3fr|iiq)$/i
export const isRawFile = (file: Pick<File, 'name' | 'type'>) => RAW_EXTENSIONS.test(file.name) || /image\/(?:x-)?(?:adobe-dng|panasonic-rw2|panasonic-raw|sony-arw|canon-cr2|canon-cr3|nikon-nef)/i.test(file.type)

function abortError(): Error { const error = new Error('已取消 RAW 导入。'); error.name = 'AbortError'; return error }

/** Each import owns a Worker: cancellation and completion reclaim its complete WASM heap. */
export async function decodeRaw(file: File, options: RawDecodeOptions = {}): Promise<{ blob: Blob; metadata: RawMetadata }> {
  if (!file.size) throw new Error('RAW 文件为空。')
  if (file.size > MAX_RAW_FILE_BYTES) throw new Error('单张 RAW 不能超过 80 MB。')
  if (options.signal?.aborted) throw abortError()
  const buffer = await file.arrayBuffer()
  if (options.signal?.aborted) throw abortError()
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  try {
    return await new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => { window.clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
      const finish = (run: () => void) => { if (settled) return; settled = true; cleanup(); run() }
      const abort = () => finish(() => reject(abortError()))
      const timer = window.setTimeout(() => finish(() => reject(new Error('RAW 解码超过 120 秒，设备可能内存不足。请先在电脑中转为 JPEG。'))), 120_000)
      options.signal?.addEventListener('abort', abort, { once: true })
      worker.onerror = () => finish(() => reject(new Error('本地 RAW 解码器运行失败，设备可能不支持 WebAssembly 或内存不足。')))
      worker.onmessage = (event: MessageEvent<RawWorkerReply>) => {
        if (settled) return
        const reply = event.data
        if (reply.type === 'progress') { options.onProgress?.(reply.message); return }
        if (reply.type === 'error') { finish(() => reject(new Error(reply.message))); return }
        if (reply.type === 'result') {
          void (async () => {
            let blob = reply.blob
            if (!blob && reply.pixels && reply.colors) {
              const { width, height } = reply.metadata
              const target = document.createElement('canvas'); target.width = width; target.height = height
              try {
                const context = target.getContext('2d')
                if (!context) throw new Error('设备无法创建 RAW 编辑画布。')
                const rgba = context.createImageData(width, height)
                for (let p = 0, i = 0; p < reply.pixels.length; p += reply.colors, i += 4) {
                  rgba.data[i] = reply.pixels[p]; rgba.data[i + 1] = reply.pixels[p + 1]; rgba.data[i + 2] = reply.pixels[p + 2]; rgba.data[i + 3] = 255
                }
                context.putImageData(rgba, 0, 0)
                blob = await new Promise<Blob>((ok, fail) => target.toBlob(value => value ? ok(value) : fail(new Error('RAW 图像编码失败。')), 'image/png'))
              } finally { target.width = target.height = 1 }
            }
            if (!blob || blob.type !== 'image/png') throw new Error('RAW 解码结果无效。')
            if (options.signal?.aborted) throw abortError()
            const result = { blob, metadata: reply.metadata }
            finish(() => resolve(result))
          })().catch(error => finish(() => reject(error)))
        }
      }
      if (options.signal?.aborted) abort()
      else worker.postMessage({ buffer }, [buffer])
    })
  } finally { worker.terminate() }
}
