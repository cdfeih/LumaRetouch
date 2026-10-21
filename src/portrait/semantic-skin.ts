import type { ImageSegmenter } from '@mediapipe/tasks-vision';

/** Confidence-only face-skin gate, intersected with anatomical feature masks.
 * It never generates skin, infers identity, or expands the editable face. */
export interface SemanticSkinMask { width: number; height: number; data: Uint8ClampedArray }
let segmenterPromise: Promise<ImageSegmenter> | undefined;
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('已取消皮肤分割。', 'AbortError'); };
const smooth = (n: number) => { const t = Math.max(0, Math.min(1, n)); return t * t * (3 - 2 * t); };

export function faceSkinConfidence(classes: readonly Float32Array[], width: number, height: number): SemanticSkinMask {
  const count = width * height;
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0) || count > 4_000_000 || classes.length !== 6 || classes.some(values => values.length !== count)) throw new Error('本地皮肤分割输出尺寸无效。');
  const data = new Uint8ClampedArray(count);
  for (let p = 0; p < count; p++) {
    const face = classes[3][p];
    if (!Number.isFinite(face) || face < .55 || face > 1) continue;
    let rival = 0, valid = true;
    for (let c = 0; c < 6; c++) {
      const value = classes[c][p];
      if (!Number.isFinite(value) || value < 0 || value > 1) { valid = false; break; }
      if (c !== 3) rival = Math.max(rival, value);
    }
    if (valid && face - rival > .1) data[p] = Math.round(255 * smooth((face - .55) / .3) * smooth((face - rival - .1) / .25));
  }
  return { width, height, data };
}

/** Conservative resampling: a hole in any adjacent semantic cell remains a
 * veto. We do not interpolate positive skin coverage into hair/accessories. */
export function semanticCoverage(mask: SemanticSkinMask, x: number, y: number, width: number, height: number): number {
  const sx = Math.max(0, Math.min(mask.width - 1, (x + .5) * mask.width / width - .5));
  const sy = Math.max(0, Math.min(mask.height - 1, (y + .5) * mask.height / height - .5));
  const x0 = Math.floor(sx), x1 = Math.min(mask.width - 1, x0 + 1), y0 = Math.floor(sy), y1 = Math.min(mask.height - 1, y0 + 1);
  return Math.min(mask.data[y0 * mask.width + x0], mask.data[y0 * mask.width + x1], mask.data[y1 * mask.width + x0], mask.data[y1 * mask.width + x1]);
}

async function getSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) segmenterPromise = (async () => {
    const { ImageSegmenter } = await import('@mediapipe/tasks-vision');
    const asset = (name: string) => new URL(`${import.meta.env.BASE_URL}models/${name}`, document.baseURI).href;
    return ImageSegmenter.createFromOptions({ wasmLoaderPath: asset('vision_wasm_nosimd_internal.js'), wasmBinaryPath: asset('vision_wasm_nosimd_internal.wasm') }, {
      baseOptions: { modelAssetPath: asset('selfie_multiclass_256x256.tflite'), delegate: 'CPU' },
      runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
    });
  })().catch(() => { segmenterPromise = undefined; throw new Error('本地皮肤分割模型加载失败，照片未改动。请刷新或检查 models 资源后重试。'); });
  return segmenterPromise;
}

/** Google MediaPipe SelfieMulticlass v1, Apache-2.0 weights and SDK. All assets
 * are bundled locally; no user photo or inference request leaves the device. */
export async function segmentFaceSkin(input: HTMLCanvasElement, signal?: AbortSignal): Promise<SemanticSkinMask> {
  check(signal); const segmenter = await getSegmenter(); check(signal);
  const result = segmenter.segment(input);
  try {
    check(signal);
    const masks = result.confidenceMasks;
    if (!masks || masks.length !== 6) throw new Error('本地皮肤分割未返回六类置信度，已保留当前照片。');
    const width = masks[0].width, height = masks[0].height;
    if (masks.some(mask => mask.width !== width || mask.height !== height)) throw new Error('本地皮肤分割蒙版尺寸不一致。');
    const mask = faceSkinConfidence(masks.map(item => item.getAsFloat32Array()), width, height);
    check(signal); return mask;
  } finally { result.close(); }
}
