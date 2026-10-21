import type { PortraitFace } from './detection';

export interface FaceWorkRegion { x: number; y: number; width: number; height: number; workWidth: number; workHeight: number }
export const FACE_WORK_EDGE = 1600;

/** Crop original pixels around one face, retaining context for finite filters.
 * Small faces are never downsampled just because their photo is very large. */
export function planFaceWorkRegion(face: PortraitFace, photoWidth: number, photoHeight: number): FaceWorkRegion {
  if (![photoWidth, photoHeight].every(n => Number.isSafeInteger(n) && n > 0) || photoWidth * photoHeight > 40_000_000) throw new Error('人像原片尺寸无效。');
  const b = face.bounds;
  if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) throw new Error('人脸范围无效，请重新识别。');
  const halo = Math.max(20, Math.ceil(Math.max(b.width * photoWidth, b.height * photoHeight) * .12));
  const x = Math.max(0, Math.floor(b.x * photoWidth) - halo), y = Math.max(0, Math.floor(b.y * photoHeight) - halo);
  const right = Math.min(photoWidth, Math.ceil((b.x + b.width) * photoWidth) + halo), bottom = Math.min(photoHeight, Math.ceil((b.y + b.height) * photoHeight) + halo);
  if (right <= x || bottom <= y) throw new Error('人脸在照片范围外，请重新识别。');
  const width = right - x, height = bottom - y, scale = Math.min(1, FACE_WORK_EDGE / Math.max(width, height));
  return { x, y, width, height, workWidth: Math.max(1, Math.round(width * scale)), workHeight: Math.max(1, Math.round(height * scale)) };
}

export function faceInRegion(face: PortraitFace, photoWidth: number, photoHeight: number, region: Pick<FaceWorkRegion, 'x' | 'y' | 'width' | 'height'>): PortraitFace {
  const point = (p: { x: number; y: number }) => ({ x: (p.x * photoWidth - region.x) / region.width, y: (p.y * photoHeight - region.y) / region.height });
  return { ...face, bounds: { ...point(face.bounds), width: face.bounds.width * photoWidth / region.width, height: face.bounds.height * photoHeight / region.height }, landmarks: face.landmarks.map(point) };
}

/** Max-coverage mask reprojection. Alpha=1 and subpixel thin lines survive a
 * crop/downsample; no full-resolution protection buffer is needed. */
export function protectionInRegion(source: Uint8ClampedArray, maskWidth: number, maskHeight: number, photoWidth: number, photoHeight: number, region: Pick<FaceWorkRegion, 'x' | 'y' | 'width' | 'height'>, targetWidth: number, targetHeight: number): Uint8ClampedArray {
  if (![maskWidth, maskHeight, photoWidth, photoHeight, region.width, region.height, targetWidth, targetHeight].every(n => Number.isSafeInteger(n) && n > 0)
    || source.length !== maskWidth * maskHeight || !Number.isFinite(region.x) || !Number.isFinite(region.y)) throw new Error('保护区裁块尺寸无效。');
  const result = new Uint8ClampedArray(targetWidth * targetHeight);
  const x0 = Math.max(0, Math.floor(region.x * maskWidth / photoWidth)), x1 = Math.min(maskWidth, Math.ceil((region.x + region.width) * maskWidth / photoWidth));
  const y0 = Math.max(0, Math.floor(region.y * maskHeight / photoHeight)), y1 = Math.min(maskHeight, Math.ceil((region.y + region.height) * maskHeight / photoHeight));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (!source[y * maskWidth + x]) continue;
    const left = Math.max(0, Math.floor((x * photoWidth / maskWidth - region.x) * targetWidth / region.width));
    const right = Math.min(targetWidth, Math.ceil(((x + 1) * photoWidth / maskWidth - region.x) * targetWidth / region.width));
    const top = Math.max(0, Math.floor((y * photoHeight / maskHeight - region.y) * targetHeight / region.height));
    const bottom = Math.min(targetHeight, Math.ceil(((y + 1) * photoHeight / maskHeight - region.y) * targetHeight / region.height));
    for (let row = top; row < bottom; row++) if (right > left) result.fill(255, row * targetWidth + left, row * targetWidth + right);
  }
  return result;
}
