import { describe, expect, it } from 'vitest';
import { automaticScopeSignature, captureAutomaticScopeSignature } from './automatic-scope';
import type { AutomaticScopePixels } from './automatic-scope';

const alpha = (values: number[], width = values.length, height = 1): AutomaticScopePixels => ({ width, height, data: Uint8ClampedArray.from(values), stride: 1 });
const rgba = (values: number[], color = 0): AutomaticScopePixels => ({ width: values.length, height: 1, data: Uint8ClampedArray.from(values.flatMap(value => [color, 255 - color, color, value])) });
const canvas = (pixels: AutomaticScopePixels) => ({ width: pixels.width, height: pixels.height, getContext: () => ({ getImageData: () => ({ data: pixels.data }) }) }) as unknown as HTMLCanvasElement;

describe('fixed-baseline mask scope identity', () => {
  it('treats missing and completely erased masks as the same unrestricted range', () => {
    const blank = automaticScopeSignature();
    expect(automaticScopeSignature(alpha([0, 0, 0]), null)).toBe(blank);
    expect(automaticScopeSignature(null, rgba([0, 0], 220))).toBe(blank);
    expect(automaticScopeSignature(alpha([], 0, 0), rgba([0]))).toBe(blank);
    expect(captureAutomaticScopeSignature(canvas(rgba([0, 0, 0])), null)).toBe(blank);
  });

  it('ignores display RGB but records even alpha 1 and alpha changes', () => {
    expect(automaticScopeSignature(rgba([0, 1, 255], 0))).toBe(automaticScopeSignature(rgba([0, 1, 255], 180)));
    expect(automaticScopeSignature(alpha([0, 1, 255]))).toBe(automaticScopeSignature(rgba([0, 1, 255])));
    expect(automaticScopeSignature(alpha([0, 1, 0]))).not.toBe(automaticScopeSignature());
    expect(automaticScopeSignature(alpha([0, 1, 0]))).not.toBe(automaticScopeSignature(alpha([0, 2, 0])));
  });

  it('detects moved, resized or role-swapped ranges instead of reusing the previous baseline', () => {
    expect(automaticScopeSignature(alpha([1, 0, 0]))).not.toBe(automaticScopeSignature(alpha([0, 1, 0])));
    expect(automaticScopeSignature(alpha([1, 0, 0, 0], 2, 2))).not.toBe(automaticScopeSignature(alpha([1, 0, 0, 0], 4, 1)));
    expect(automaticScopeSignature(alpha([0, 255]))).not.toBe(automaticScopeSignature(null, alpha([0, 255])));
    expect(automaticScopeSignature(alpha([1, 0]), alpha([0, 1]))).not.toBe(automaticScopeSignature(alpha([0, 1]), alpha([1, 0])));
  });

  it('is stable across cloned buffers and reads both canvases without changing them', () => {
    const red = rgba([0, 1, 255]), green = rgba([255, 0, 0]);
    const before = [...red.data, ...green.data];
    const expected = automaticScopeSignature(red, green);
    expect(captureAutomaticScopeSignature(canvas(red), canvas(green))).toBe(expected);
    expect(automaticScopeSignature({ ...red, data: red.data.slice() }, { ...green, data: green.data.slice() })).toBe(expected);
    expect([...red.data, ...green.data]).toEqual(before);
  });

  it('refuses malformed or oversized buffers rather than treating them as an empty mask', () => {
    expect(() => automaticScopeSignature({ width: 1, height: 2, data: new Uint8Array(4) })).toThrow(/尺寸/);
    expect(() => automaticScopeSignature({ width: -1, height: 2, data: new Uint8Array(0) })).toThrow(/尺寸/);
    expect(() => automaticScopeSignature({ width: 40_000_001, height: 1, data: new Uint8Array(0) })).toThrow(/尺寸/);
    const unavailable = { width: 1, height: 1, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => captureAutomaticScopeSignature(unavailable)).toThrow(/无法读取/);
  });
});
