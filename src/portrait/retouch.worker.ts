import { retouchPortraitPixels } from './retouch'
import type { NaturalRetouchSettings } from './retouch'

export type RetouchWorkerRequest = {
  source: ArrayBuffer
  width: number
  height: number
  subjects: Array<{ mask: ArrayBuffer; settings: NaturalRetouchSettings }>
}

export type RetouchWorkerResponse = { ok: true; delta: ArrayBuffer } | { ok: false; error: string }

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<RetouchWorkerRequest>) => void) | null
  postMessage: (message: RetouchWorkerResponse, transfer?: Transferable[]) => void
}

workerScope.onmessage = (event) => {
  try {
    const request = event.data
    const source = new Uint8ClampedArray(request.source)
    const subjects = request.subjects.map(subject => ({
      mask: new Uint8ClampedArray(subject.mask), settings: subject.settings,
    }))
    const output = retouchPortraitPixels(source, request.width, request.height, subjects)
    const delta = new Int16Array(request.width * request.height * 3)
    for (let pixel = 0; pixel < request.width * request.height; pixel += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        delta[pixel * 3 + channel] = output[pixel * 4 + channel] - source[pixel * 4 + channel]
      }
    }
    workerScope.postMessage({ ok: true, delta: delta.buffer }, [delta.buffer])
  } catch (error) {
    workerScope.postMessage({ ok: false, error: error instanceof Error ? error.message : '本地自然精修计算失败。' })
  }
}
