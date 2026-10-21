export interface RawMetadata {
  decoder: string
  camera: string
  output: '8bit-srgb'
  source: 'sensor-demosaic'
  width: number
  height: number
}
export interface RawDecodeOptions {
  signal?: AbortSignal
  onProgress?: (message: string) => void
}
export type RawWorkerReply = { type: 'progress'; message: string } | { type: 'error'; message: string }
  | { type: 'result'; blob?: Blob; pixels?: Uint8Array<ArrayBuffer>; colors?: number; metadata: RawMetadata }
