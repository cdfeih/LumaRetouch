/// <reference lib="webworker" />
import { LibRaw } from '@colorhythm/libraw-wasm'
import wasmUrl from '@colorhythm/libraw-wasm/libraw.wasm?url'
import type { RawMetadata, RawWorkerReply } from './types'

const scope = self as unknown as DedicatedWorkerGlobalScope
const send = (reply: RawWorkerReply, transfer: Transferable[] = []) => scope.postMessage(reply, transfer)
let running = false

scope.onmessage = async (event: MessageEvent<{ buffer: ArrayBuffer }>) => {
  if (running) { send({ type: 'error', message: 'RAW 解码器正忙，请逐张导入。' }); return }
  running = true
  let decoder: LibRaw | undefined
  try {
    const buffer = event.data?.buffer
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16 || buffer.byteLength > 80 * 1024 * 1024) throw new Error('RAW 文件无效或超过 80 MB。')
    send({ type: 'progress', message: '正在加载本地 RAW 解码器…' })
    const response = await fetch(wasmUrl)
    if (!response.ok) throw new Error('本地 RAW 解码资源加载失败，请重新打开应用。')
    await LibRaw.initialize(await response.arrayBuffer())
    decoder = new LibRaw()
    await decoder.waitUntilReady()
    decoder.open(buffer)
    const params = decoder.getIParams()
    if (decoder.getActiveWidth() * decoder.getActiveHeight() > 40_000_000) throw new Error('RAW 超过 4000 万像素，请先在电脑中转为较小的 JPEG。')
    send({ type: 'progress', message: '正在解码传感器数据并转为 sRGB…' })
    decoder.setUseCameraWb(1)
    decoder.setOutputColor(1)
    decoder.setOutputBps(8)
    decoder.setGamma(0, 1 / 2.4)
    decoder.setGamma(1, 12.92)
    decoder.setHalfSize(0)
    decoder.setDemosaic(3)
    decoder.unpack()
    decoder.dcrawProcess()
    const image = decoder.dcrawMakeMemImage()
    if (image.type_ !== 'LIBRAW_IMAGE_BITMAP' || image.bits !== 8 || ![3, 4].includes(image.colors)
      || image.width < 1 || image.height < 1 || image.width * image.height > 40_000_000
      || image.data.length !== image.width * image.height * image.colors) throw new Error('RAW 解码器没有返回有效的完整 RGB 图像。')
    const metadata: RawMetadata = { decoder: `LibRaw ${LibRaw.version()}`, camera: `${params.make} ${params.model}`.trim(),
      output: '8bit-srgb', source: 'sensor-demosaic', width: image.width, height: image.height }
    // dcrawMakeMemImage returns an owned copy. Free the sensor buffers before PNG encoding.
    const rgb = image.data
    decoder.dispose(); decoder = undefined
    send({ type: 'progress', message: '正在编码本地编辑图像…' })
    if (typeof OffscreenCanvas === 'function') {
      const target = new OffscreenCanvas(image.width, image.height)
      const context = target.getContext('2d')
      if (!context) throw new Error('设备无法创建 RAW 编辑画布。')
      const pixels = context.createImageData(image.width, image.height)
      for (let p = 0, i = 0; p < rgb.length; p += image.colors, i += 4) {
        pixels.data[i] = rgb[p]; pixels.data[i + 1] = rgb[p + 1]; pixels.data[i + 2] = rgb[p + 2]; pixels.data[i + 3] = 255
      }
      context.putImageData(pixels, 0, 0)
      const blob = await target.convertToBlob({ type: 'image/png' })
      target.width = target.height = 1
      send({ type: 'result', blob, metadata })
    } else send({ type: 'result', pixels: rgb, colors: image.colors, metadata }, [rgb.buffer])
  } catch (error) {
    const message = error instanceof Error && /^(?:RAW (?:文件|超过|解码器)|本地|设备)/.test(error.message) ? error.message
      : '无法完整解码这张 RAW。该机型或压缩模式可能未被当前解码器支持；请改用相机 JPEG 或先转换为 DNG。不会用内嵌预览冒充 RAW 成片。'
    send({ type: 'error', message })
  } finally { decoder?.dispose(); running = false }
}
