/**
 * Local, deterministic Dodge & Burn planning. This returns a smooth luminance
 * correction field, never a blurred replacement image. The caller applies one
 * equal increment to R/G/B, with its own strength, mask coverage and headroom.
 *
 * A fine/broad triangular-kernel decomposition isolates middle-scale unevenness;
 * another fine triangular kernel smooths the correction itself. Each triangular
 * kernel uses two normalized box passes, so its frequency response has no signed
 * sinc sidelobes that could turn a one-pixel texture into a sizeable correction.
 * Strong edges and excluded pixels are barriers. We suppress corrections whose
 * full square filter support could cross a barrier, then smoothly fade in beyond
 * it. The six normalized box passes and barrier distance passes are O(N),
 * independent of radius. All intermediate arrays are limited to skin bounds plus
 * the finite kernel halo, and no third-party filtering implementation is copied.
 */

const MAX_PIXELS = 40_000_000;
const MAX_CORRECTION = 10;
const STRONG_EDGE = 28;
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

/** Normalized masked box mean using reusable horizontal sums, then vertical sums. */
function boxMean(
  source: Float32Array,
  valid: Uint8Array,
  width: number,
  height: number,
  radius: number,
  output: Float32Array,
  horizontal: Float64Array,
  counts: Uint16Array,
): void {
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0, count = 0;
    for (let x = 0; x <= Math.min(radius, width - 1); x += 1) {
      if (valid[row + x]) { sum += source[row + x]; count++; }
    }
    for (let x = 0; x < width; x += 1) {
      const p = row + x;
      horizontal[p] = sum; counts[p] = count;
      const remove = x - radius, add = x + radius + 1;
      if (remove >= 0 && valid[row + remove]) { sum -= source[row + remove]; count--; }
      if (add < width && valid[row + add]) { sum += source[row + add]; count++; }
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0, count = 0;
    for (let y = 0; y <= Math.min(radius, height - 1); y += 1) {
      sum += horizontal[y * width + x]; count += counts[y * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      const p = y * width + x;
      output[p] = count > 0 ? sum / count : 0;
      const remove = y - radius, add = y + radius + 1;
      if (remove >= 0) { sum -= horizontal[remove * width + x]; count -= counts[remove * width + x]; }
      if (add < height) { sum += horizontal[add * width + x]; count += counts[add * width + x]; }
    }
  }
}

/** Chebyshev distance matches the square support of the finite box kernels. */
function barrierDistance(distance: Uint8Array, width: number, height: number): void {
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const p = y * width + x;
    let d = distance[p];
    if (x > 0) d = Math.min(d, distance[p - 1] + 1);
    if (y > 0) {
      d = Math.min(d, distance[p - width] + 1);
      if (x > 0) d = Math.min(d, distance[p - width - 1] + 1);
      if (x + 1 < width) d = Math.min(d, distance[p - width + 1] + 1);
    }
    distance[p] = d;
  }
  for (let y = height - 1; y >= 0; y -= 1) for (let x = width - 1; x >= 0; x -= 1) {
    const p = y * width + x;
    let d = distance[p];
    if (x + 1 < width) d = Math.min(d, distance[p + 1] + 1);
    if (y + 1 < height) {
      d = Math.min(d, distance[p + width] + 1);
      if (x > 0) d = Math.min(d, distance[p + width - 1] + 1);
      if (x + 1 < width) d = Math.min(d, distance[p + width + 1] + 1);
    }
    distance[p] = d;
  }
}

/**
 * source is straight RGBA; mask/protection contain one alpha byte per pixel.
 * mask=0, protection>0 (including 1), and nonopaque source pixels do not enter
 * statistics and have exactly zero correction. Feathered skin alpha is applied
 * by the caller: positive skin pixels here are binary neighborhood membership.
 * The returned full-size Float32Array contains RGB grey-level increments ±10.
 */
export function buildDodgeBurnCorrection(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8ClampedArray,
  protection?: Uint8ClampedArray | null,
): Float32Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width * height > MAX_PIXELS || source.length !== width * height * 4) {
    throw new Error('光影修饰图片尺寸与像素数据不一致。');
  }
  const count = width * height;
  if (mask.length !== count || protection && protection.length !== count) throw new Error('光影修饰皮肤或保护区尺寸不一致。');
  const correction = new Float32Array(count);
  if (Math.min(width, height) < 12) return correction;
  let left = width, right = -1, top = height, bottom = -1, skinCount = 0;
  for (let p = 0; p < count; p += 1) {
    if (!mask[p] || protection?.[p] || source[p * 4 + 3] !== 255) continue;
    const x = p % width, y = Math.floor(p / width);
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); skinCount++;
  }
  if (skinCount < 36 || Math.min(right - left + 1, bottom - top + 1) < 12) return correction;
  const faceSpan = Math.min(right - left + 1, bottom - top + 1);
  const fineRadius = clamp(Math.round(faceSpan / 240), 1, 2);
  const broadRadius = Math.max(2, Math.round(clamp(Math.round(faceSpan / 28), 3, 24) / 2));
  // Each mean is a pair of finite box passes. The broad source pair plus the
  // final fine pair has this total support; the fine source pair fits inside it.
  // Keep the extra barrier fade outside that complete support, never inside it.
  const support = broadRadius * 2 + fineRadius * 2;
  const fade = Math.max(2, fineRadius * 2);
  const halo = support + fade;
  left = Math.max(0, left - halo); right = Math.min(width - 1, right + halo);
  top = Math.max(0, top - halo); bottom = Math.min(height - 1, bottom + halo);
  const roiWidth = right - left + 1, roiHeight = bottom - top + 1, roiCount = roiWidth * roiHeight;
  const light = new Float32Array(roiCount), valid = new Uint8Array(roiCount), distance = new Uint8Array(roiCount);
  for (let y = 0; y < roiHeight; y += 1) for (let x = 0; x < roiWidth; x += 1) {
    const local = y * roiWidth + x, p = (y + top) * width + x + left, rgba = p * 4;
    const eligible = mask[p] > 0 && !protection?.[p] && source[rgba + 3] === 255;
    if (eligible) {
      valid[local] = 1;
      light[local] = source[rgba] * 0.2126 + source[rgba + 1] * 0.7152 + source[rgba + 2] * 0.0722;
    }
    // Image edges also truncate a kernel; guarding them preserves affine light.
    distance[local] = eligible && x > 0 && y > 0 && x + 1 < roiWidth && y + 1 < roiHeight ? halo : 0;
  }
  for (let y = 0; y < roiHeight; y += 1) for (let x = 0; x < roiWidth; x += 1) {
    const p = y * roiWidth + x;
    if (!valid[p]) continue;
    if (x + 1 < roiWidth && valid[p + 1] && Math.abs(light[p] - light[p + 1]) > STRONG_EDGE) distance[p] = distance[p + 1] = 0;
    if (y + 1 < roiHeight && valid[p + roiWidth] && Math.abs(light[p] - light[p + roiWidth]) > STRONG_EDGE) distance[p] = distance[p + roiWidth] = 0;
  }
  barrierDistance(distance, roiWidth, roiHeight);
  let hasInterior = false;
  for (const d of distance) if (d > support) { hasInterior = true; break; }
  if (!hasInterior) return correction;
  const fine = new Float32Array(roiCount), broad = new Float32Array(roiCount);
  const horizontal = new Float64Array(roiCount), counts = new Uint16Array(roiCount);
  boxMean(light, valid, roiWidth, roiHeight, fineRadius, fine, horizontal, counts);
  boxMean(fine, valid, roiWidth, roiHeight, fineRadius, fine, horizontal, counts);
  boxMean(light, valid, roiWidth, roiHeight, broadRadius, broad, horizontal, counts);
  boxMean(broad, valid, roiWidth, roiHeight, broadRadius, broad, horizontal, counts);
  for (let p = 0; p < roiCount; p += 1) broad[p] -= fine[p];
  boxMean(broad, valid, roiWidth, roiHeight, fineRadius, fine, horizontal, counts);
  boxMean(fine, valid, roiWidth, roiHeight, fineRadius, fine, horizontal, counts);
  for (let y = 0; y < roiHeight; y += 1) for (let x = 0; x < roiWidth; x += 1) {
    const local = y * roiWidth + x;
    if (!valid[local] || distance[local] <= support) continue;
    const t = Math.min(1, (distance[local] - support) / fade);
    const value = clamp(fine[local] * 0.85, -MAX_CORRECTION, MAX_CORRECTION) * t * t * (3 - 2 * t);
    // Remove numerical dust on constant/affine illumination, not real texture.
    if (Math.abs(value) > 0.0001) correction[(y + top) * width + x + left] = value;
  }
  return correction;
}
