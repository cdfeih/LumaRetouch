import { describe, expect, it } from 'vitest';
import { buildDodgeBurnCorrection } from './dodge-burn';

function photo(width: number, height: number, value: (x: number, y: number) => number = () => 140) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const light = value(x, y); pixels.set([light, light, light, 255], (y * width + x) * 4);
  }
  return pixels;
}
function skin(width: number, height: number) { return new Uint8ClampedArray(width * height).fill(255); }
function largest(field: Float32Array) { let maximum = 0; for (const value of field) maximum = Math.max(maximum, Math.abs(value)); return maximum; }
const gaussian = (x: number, y: number, cx: number, cy: number, sigma: number) => Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma ** 2));

function textureAmplitude(values: Float64Array, width: number, period: number, phase: number, vertical: boolean) {
  let dot = 0, norm = 0;
  for (let y = 32; y < 128; y++) for (let x = 32; x < 128; x++) {
    const basis = Math.cos(2 * Math.PI * (vertical ? y : x) / period + phase);
    dot += (values[y * width + x] - 128) * basis; norm += basis * basis;
  }
  return dot / norm;
}

describe('local Dodge & Burn luminance correction', () => {
  it('lightens dark mid-scale patches and darkens bright patches without changing inputs', () => {
    const width = 128, height = 128;
    const source = photo(width, height, (x, y) => 140 - 16 * gaussian(x, y, 37, 64, 3) + 16 * gaussian(x, y, 91, 64, 3));
    const mask = skin(width, height), before = new Uint8ClampedArray(source), maskBefore = new Uint8ClampedArray(mask);
    const field = buildDodgeBurnCorrection(source, width, height, mask);
    const dark = 64 * width + 37, bright = 64 * width + 91;
    expect(field[dark]).toBeGreaterThan(3); expect(field[bright]).toBeLessThan(-3);
    expect(Math.abs(source[dark * 4] + field[dark] - 140)).toBeLessThan(13);
    expect(Math.abs(source[bright * 4] + field[bright] - 140)).toBeLessThan(13);
    expect(source).toEqual(before); expect(mask).toEqual(maskBefore);
    expect(largest(field)).toBeLessThanOrEqual(10);
  });

  it('retains at least 98% of one-pixel texture contrast while correcting a broader patch', () => {
    const width = 128, height = 128;
    const source = photo(width, height, (x, y) => 140 - 14 * gaussian(x, y, 64, 64, 4) + ((x + y) % 2 ? -4 : 4));
    const field = buildDodgeBurnCorrection(source, width, height, skin(width, height));
    let before = 0, after = 0, samples = 0, maxAdjacent = 0;
    for (let y = 32; y < 96; y += 2) for (let x = 32; x < 96; x += 2) {
      const indices = [y * width + x, y * width + x + 1, (y + 1) * width + x, (y + 1) * width + x + 1];
      const contrast = (values: number[]) => Math.abs((values[0] + values[3] - values[1] - values[2]) / 4);
      before += contrast(indices.map(p => source[p * 4]));
      after += contrast(indices.map(p => source[p * 4] + field[p])); samples++;
      maxAdjacent = Math.max(maxAdjacent, Math.abs(field[indices[0]] - field[indices[1]]));
    }
    expect(samples).toBe(1024);
    expect(after / before).toBeGreaterThan(0.98); expect(after / before).toBeLessThan(1.02);
    expect(field[64 * width + 64]).toBeGreaterThan(2);
    expect(maxAdjacent).toBeLessThan(2);
  });

  it('preserves quantized 2/3/4px one-dimensional textures across phase and orientation', () => {
    const width = 160, height = 160, mask = skin(width, height);
    for (const period of [2, 3, 4]) for (const phase of [0, Math.PI / 6, Math.PI / 4]) for (const vertical of [false, true]) {
      const source = photo(width, height, (x, y) => 128 + Math.round(6 * Math.cos(2 * Math.PI * (vertical ? y : x) / period + phase)));
      const before = Float64Array.from(mask, (_value, p) => source[p * 4]);
      const field = buildDodgeBurnCorrection(source, width, height, mask);
      const after = Float64Array.from(before, (value, p) => Math.round(value + field[p]));
      const retained = textureAmplitude(after, width, period, phase, vertical) / textureAmplitude(before, width, period, phase, vertical);
      expect(retained, `period=${period}, phase=${phase}, vertical=${vertical}`).toBeGreaterThanOrEqual(0.95);
      expect(retained).toBeLessThanOrEqual(1.05);
      expect(largest(field)).toBeLessThan(0.49);
    }
  });

  it('preserves quantized fine texture while reducing a mixed mid-scale patch by at least 10%', () => {
    const width = 160, height = 160, mask = skin(width, height), center = 80 * width + 80;
    for (const period of [2, 3, 4]) for (const phase of [0, Math.PI / 6, Math.PI / 4]) {
      const texture = (x: number) => 128 + Math.round(6 * Math.cos(2 * Math.PI * x / period + phase));
      const source = photo(width, height, (x, y) => texture(x) - 16 * gaussian(x, y, 80, 80, 4));
      const before = Float64Array.from(mask, (_value, p) => source[p * 4]);
      const field = buildDodgeBurnCorrection(source, width, height, mask);
      const after = Float64Array.from(before, (value, p) => Math.round(value + field[p]));
      const retained = textureAmplitude(after, width, period, phase, false) / textureAmplitude(before, width, period, phase, false);
      expect(retained).toBeGreaterThanOrEqual(0.95); expect(retained).toBeLessThanOrEqual(1.05);
      const originalPatch = Math.abs(before[center] - texture(80)), correctedPatch = Math.abs(after[center] - texture(80));
      expect(correctedPatch).toBeLessThanOrEqual(originalPatch * 0.9);
    }
  });

  it('adapts the broad correction scale to a large face while preserving finer-than-patch detail', () => {
    const width = 960, height = 960, center = 480 * width + 480;
    const source = photo(width, height, (x, y) => 140 - 16 * gaussian(x, y, 480, 480, width * 0.018) + (x % 2 ? -4 : 4));
    const field = buildDodgeBurnCorrection(source, width, height, skin(width, height));
    expect(field[center]).toBeGreaterThan(1.6);
    let before = 0, after = 0;
    for (let y = 432; y < 528; y++) for (let x = 432; x < 528; x += 2) {
      const p = y * width + x;
      before += source[p * 4] - source[(p + 1) * 4];
      after += Math.round(source[p * 4] + field[p]) - Math.round(source[(p + 1) * 4] + field[p + 1]);
    }
    expect(after / before).toBeGreaterThanOrEqual(0.95); expect(after / before).toBeLessThanOrEqual(1.05);
  });

  it('returns exactly zero on uniform color and affine illumination, including image edges', () => {
    const width = 96, height = 96, mask = skin(width, height);
    const uniform = photo(width, height);
    for (let p = 0; p < mask.length; p++) uniform.set([182, 143, 119, 255], p * 4);
    expect(largest(buildDodgeBurnCorrection(uniform, width, height, mask))).toBe(0);
    const affine = photo(width, height, (x, y) => 30 + x + y);
    expect(largest(buildDodgeBurnCorrection(affine, width, height, mask))).toBe(0);
  });

  it('keeps broad natural illumination nearly unchanged instead of flattening facial volume', () => {
    const width = 128, height = 128;
    const source = photo(width, height, (x, y) => 120 + 28 * gaussian(x, y, 64, 64, 45));
    const field = buildDodgeBurnCorrection(source, width, height, skin(width, height));
    let energy = 0;
    for (const value of field) energy += value * value;
    expect(Math.sqrt(energy / field.length)).toBeLessThan(0.2);
    expect(Math.abs(field[64 * width + 64])).toBeLessThan(0.3);
  });

  it('does not create halos across horizontal, vertical, or diagonal strong boundaries', () => {
    const width = 128, height = 128, mask = skin(width, height);
    for (const split of [(x: number, _y: number) => x < 64, (_x: number, y: number) => y < 64, (x: number, y: number) => x < y]) {
      const source = photo(width, height, (x, y) => split(x, y) ? 75 : 205);
      expect(largest(buildDodgeBurnCorrection(source, width, height, mask))).toBe(0);
    }
  });

  it('never uses excluded eye/mouth pixels, and masked islands cannot bleed across holes', () => {
    const width = 128, height = 128, mask = skin(width, height);
    const source = photo(width, height, (x, y) => 140 - 14 * gaussian(x, y, 65, 88, 3));
    for (let y = 35; y <= 49; y++) for (let x = 27; x <= 47; x++) mask[y * width + x] = 0;
    for (let y = 75; y <= 82; y++) for (let x = 47; x <= 81; x++) mask[y * width + x] = 0;
    const altered = new Uint8ClampedArray(source);
    for (let p = 0; p < mask.length; p++) if (!mask[p]) altered.set([255, 0, 255, 255], p * 4);
    const a = buildDodgeBurnCorrection(source, width, height, mask), b = buildDodgeBurnCorrection(altered, width, height, mask);
    expect(a).toEqual(b);
    for (let p = 0; p < mask.length; p++) if (!mask[p]) expect(a[p]).toBe(0);
    const stripe = skin(width, height);
    for (let y = 0; y < height; y++) stripe[y * width + 64] = 0;
    const islands = photo(width, height, (x, _y) => x < 64 ? 130 : 150);
    expect(largest(buildDodgeBurnCorrection(islands, width, height, stripe))).toBe(0);
  });

  it('hard-excludes protection alpha 1/128/255 from output and neighborhood statistics', () => {
    const width = 128, height = 128, mask = skin(width, height), protection = new Uint8ClampedArray(width * height);
    const source = photo(width, height, (x, y) => 140 - 14 * gaussian(x, y, 64, 64, 4));
    const indices = [58 * width + 62, 58 * width + 64, 58 * width + 66];
    indices.forEach((p, index) => { protection[p] = [1, 128, 255][index]; });
    const changed = new Uint8ClampedArray(source);
    indices.forEach(p => changed.set([0, 255, 0, 255], p * 4));
    const result = buildDodgeBurnCorrection(source, width, height, mask, protection);
    expect(result).toEqual(buildDodgeBurnCorrection(changed, width, height, mask, protection));
    for (const p of indices) expect(result[p]).toBe(0);
    expect(protection[indices[0]]).toBe(1);
  });

  it('ignores hidden RGB under transparency and conservatively leaves translucent pixels untouched', () => {
    const width = 64, height = 64, mask = skin(width, height), source = photo(width, height);
    for (let p = 0; p < mask.length; p++) source[p * 4 + 3] = p % 2 ? 0 : 128;
    expect(largest(buildDodgeBurnCorrection(source, width, height, mask))).toBe(0);
    const opaque = photo(128, 128, (x, y) => 140 - 14 * gaussian(x, y, 64, 64, 3));
    const hidden = new Uint8ClampedArray(opaque);
    for (let y = 50; y <= 52; y++) for (let x = 60; x <= 62; x++) {
      const p = (y * 128 + x) * 4; opaque[p + 3] = hidden[p + 3] = 0; hidden.set([250, 1, 255, 0], p);
    }
    expect(buildDodgeBurnCorrection(opaque, 128, 128, skin(128, 128)))
      .toEqual(buildDodgeBurnCorrection(hidden, 128, 128, skin(128, 128)));
  });

  it('is translation invariant within a larger image and ignores colors outside the skin ROI', () => {
    const smallWidth = 128, bigWidth = 320, offsetX = 100, offsetY = 80;
    const small = photo(smallWidth, smallWidth, (x, y) => 140 - 15 * gaussian(x, y, 64, 64, 3));
    const smallMask = new Uint8ClampedArray(smallWidth * smallWidth);
    const large = photo(bigWidth, bigWidth, (x, y) => (x * 13 + y * 7) % 256), largeMask = new Uint8ClampedArray(bigWidth * bigWidth);
    for (let y = 16; y < 112; y++) for (let x = 16; x < 112; x++) {
      smallMask[y * smallWidth + x] = 255;
      const p = (y + offsetY) * bigWidth + x + offsetX;
      largeMask[p] = 255; large.set(small.subarray((y * smallWidth + x) * 4, (y * smallWidth + x) * 4 + 4), p * 4);
    }
    const a = buildDodgeBurnCorrection(small, smallWidth, smallWidth, smallMask);
    const b = buildDodgeBurnCorrection(large, bigWidth, bigWidth, largeMask);
    for (let y = 0; y < smallWidth; y++) for (let x = 0; x < smallWidth; x++) expect(b[(y + offsetY) * bigWidth + x + offsetX]).toBe(a[y * smallWidth + x]);
    expect(largest(a)).toBeGreaterThan(1.5);
  });

  it('bounds extreme corrections, produces no NaN, and is deterministic on fixed input', () => {
    const width = 192, height = 192;
    const source = photo(width, height, (x, y) => 128 - 70 * gaussian(x, y, 62, 95, 5) + 70 * gaussian(x, y, 128, 95, 5));
    const mask = skin(width, height), result = buildDodgeBurnCorrection(source, width, height, mask);
    expect(result.length).toBe(width * height); expect(result.every(Number.isFinite)).toBe(true);
    expect(largest(result)).toBeLessThanOrEqual(10); expect(largest(result)).toBeGreaterThan(8);
    expect(result).toEqual(buildDodgeBurnCorrection(source, width, height, mask));
  });

  it('short-circuits tiny/empty/sparse/fully protected skin and rejects inconsistent buffers', () => {
    expect(largest(buildDodgeBurnCorrection(photo(8, 8), 8, 8, skin(8, 8)))).toBe(0);
    expect(largest(buildDodgeBurnCorrection(photo(32, 32), 32, 32, new Uint8ClampedArray(1024)))).toBe(0);
    const sparse = new Uint8ClampedArray(1024); sparse[500] = 255;
    expect(largest(buildDodgeBurnCorrection(photo(32, 32), 32, 32, sparse))).toBe(0);
    expect(largest(buildDodgeBurnCorrection(photo(32, 32), 32, 32, skin(32, 32), skin(32, 32)))).toBe(0);
    expect(() => buildDodgeBurnCorrection(photo(32, 32), 0, 32, skin(32, 32))).toThrow('尺寸');
    expect(() => buildDodgeBurnCorrection(photo(32, 32), 32, 32, new Uint8ClampedArray(1))).toThrow('尺寸');
    expect(() => buildDodgeBurnCorrection(photo(32, 32), 32, 32, skin(32, 32), new Uint8ClampedArray(1))).toThrow('尺寸');
  });

  it('keeps a large-frame/small-face computation practical using only a bounded skin ROI', () => {
    const width = 2048, height = 1536, source = new Uint8ClampedArray(width * height * 4).fill(140), mask = new Uint8ClampedArray(width * height);
    for (let y = 550; y < 806; y++) for (let x = 850; x < 1106; x++) {
      const p = y * width + x, value = 140 - 15 * gaussian(x, y, 978, 678, 5);
      source.set([value, value, value, 255], p * 4); mask[p] = 255;
    }
    const started = performance.now();
    const correction = buildDodgeBurnCorrection(source, width, height, mask);
    expect(performance.now() - started).toBeLessThan(2500);
    expect(correction[678 * width + 978]).toBeGreaterThan(3);
    expect(correction[0]).toBe(0);
  });
});
