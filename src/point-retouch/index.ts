import { MAX_PHOTO_PIXELS } from '../imaging';
import { repairSpotPixels } from './pixels';
import type { SpotDonorImage } from './pixels';

export interface SpotRepairOptions {
  /** x/y are fractions of full photo width/height; radius is a fraction of its shorter edge. */
  x: number; y: number; radius: number;
  sourcePoint?: { x: number; y: number };
  protection?: HTMLCanvasElement | null;
  signal?: AbortSignal;
}
export interface SpotRepairResult { dataUrl: string; changed: boolean; warning?: string }
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('已取消本地点修。', 'AbortError'); };
const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));

/** A local sampled texture patch with color matching and feathering. This is not generative inpainting. */
export async function repairSpot(source: string, options: SpotRepairOptions): Promise<SpotRepairResult> {
  abort(options.signal);
  if (!/^data:image\/(?:png|jpe?g|webp);base64,/i.test(source) || ![options.x, options.y, options.radius].every(Number.isFinite)
    || options.x < 0 || options.x > 1 || options.y < 0 || options.y > 1 || options.radius <= 0 || options.radius > .12
    || options.sourcePoint && (![options.sourcePoint.x, options.sourcePoint.y].every(Number.isFinite)
      || options.sourcePoint.x < 0 || options.sourcePoint.x > 1 || options.sourcePoint.y < 0 || options.sourcePoint.y > 1)) throw new Error('点修坐标无效，请在照片内点选，并使用较小的修复画笔。');
  // Capture the protection layer before any await so subsequent brush edits cannot change this stroke.
  let protection: { width: number; height: number; canvas: HTMLCanvasElement } | undefined;
  if (options.protection?.width && options.protection.height) {
    const snapshot = document.createElement('canvas'); snapshot.width = options.protection.width; snapshot.height = options.protection.height;
    const context = snapshot.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法读取保护画笔，本次点修未执行。');
    context.drawImage(options.protection, 0, 0); protection = { width: snapshot.width, height: snapshot.height, canvas: snapshot };
  }
  let bitmap: ImageBitmap | undefined, canvas: HTMLCanvasElement | undefined;
  try {
    const blob = await (await fetch(source, { signal: options.signal })).blob(); abort(options.signal);
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' }); abort(options.signal);
    const width = bitmap.width, height = bitmap.height;
    if (!width || !height || width * height > MAX_PHOTO_PIXELS) throw new Error('点修暂支持不超过 4000 万像素的照片。');
    const radius = options.radius * Math.min(width, height);
    if (radius < 2 || radius > 192) return { dataUrl: source, changed: false, warning: radius < 2 ? '画笔小于 2 个原始像素，请稍微放大画笔。' : '单笔点修半径最多 192 个原始像素，请缩小画笔分次修复。' };
    const target = { x: clamp(options.x * width, width - 1), y: clamp(options.y * height, height - 1) };
    const donor = options.sourcePoint ? { x: clamp(options.sourcePoint.x * width, width - 1), y: clamp(options.sourcePoint.y * height, height - 1) } : undefined;
    // Read two separate small ROIs for distant manual samples, never their full-frame bounding rectangle.
    const reach = donor ? radius * 1.1 + 2 : radius * 5.85 + 2;
    const x0 = Math.max(0, Math.floor(target.x - reach)), y0 = Math.max(0, Math.floor(target.y - reach));
    const x1 = Math.min(width, Math.ceil(target.x + reach) + 1), y1 = Math.min(height, Math.ceil(target.y + reach) + 1);
    canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('设备无法创建点修画布，请减少照片尺寸后重试。');
    context.drawImage(bitmap, 0, 0); bitmap.close(); bitmap = undefined;
    const patch = context.getImageData(x0, y0, x1 - x0, y1 - y0);
    let donorImage: SpotDonorImage | undefined;
    if (donor) {
      const dx0 = Math.max(0, Math.floor(donor.x - reach)), dy0 = Math.max(0, Math.floor(donor.y - reach));
      const dx1 = Math.min(width, Math.ceil(donor.x + reach) + 1), dy1 = Math.min(height, Math.ceil(donor.y + reach) + 1);
      const sample = context.getImageData(dx0, dy0, dx1 - dx0, dy1 - dy0);
      donorImage = { pixels: sample.data, width: sample.width, height: sample.height, x: donor.x - dx0, y: donor.y - dy0 };
    }
    let protectionAlpha: Uint8Array | undefined;
    if (protection) {
      const mx = Math.floor(x0 / width * protection.width), my = Math.floor(y0 / height * protection.height);
      const mw = Math.min(protection.width - mx, Math.ceil(x1 / width * protection.width) - mx);
      const mh = Math.min(protection.height - my, Math.ceil(y1 / height * protection.height) - my);
      const mask = protection.canvas.getContext('2d')!.getImageData(mx, my, mw, mh).data;
      protectionAlpha = new Uint8Array(patch.width * patch.height);
      // Sample alpha with nearest neighbors. Even alpha=1 remains a hard protection lock.
      for (let y = 0; y < patch.height; y++) {
        if (y % 128 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); abort(options.signal); }
        const maskY = clamp(Math.floor((y + y0) / height * protection.height) - my, mh - 1);
        for (let x = 0; x < patch.width; x++) {
          const maskX = clamp(Math.floor((x + x0) / width * protection.width) - mx, mw - 1);
          protectionAlpha[y * patch.width + x] = mask[(maskY * mw + maskX) * 4 + 3];
        }
      }
    }
    const result = await repairSpotPixels(patch.data, patch.width, patch.height, {
      x: target.x - x0, y: target.y - y0, radius, sourcePoint: donor ? { x: donor.x - x0, y: donor.y - y0 } : undefined,
      donorImage, protectionAlpha, signal: options.signal,
    });
    abort(options.signal);
    if (!result.changedPixels) return { dataUrl: source, changed: false, warning: result.warning };
    context.putImageData(new ImageData(result.pixels as Uint8ClampedArray<ArrayBuffer>, patch.width, patch.height), x0, y0);
    const output = await new Promise<Blob>((resolve, reject) => canvas!.toBlob(value => value ? resolve(value) : reject(new Error('点修图片编码失败，可能是内存不足。')), 'image/png'));
    abort(options.signal);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('无法读取点修结果，请重试。')); reader.readAsDataURL(output);
    });
    abort(options.signal);
    return { dataUrl, changed: true, warning: result.warning };
  } finally {
    bitmap?.close();
    if (canvas) canvas.width = canvas.height = 1;
    if (protection) protection.canvas.width = protection.canvas.height = 1;
  }
}
