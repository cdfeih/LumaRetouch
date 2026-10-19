import { expect, it } from 'vitest';
import { cloudResultBlend } from './blend';
import { compositePixelBuffers } from '../imaging/pixels';

it('retouch and photographic color strength actually controls original/result pixels', () => {
  const original = new Uint8ClampedArray([20,40,60,255]);
  const edited = new Uint8ClampedArray([220,140,100,255]);
  for (const tool of ['smooth', 'blemish', 'match', 'style'] as const) {
    expect([...compositePixelBuffers(original, edited, null, cloudResultBlend(tool, 25))]).toEqual([70,65,70,255]);
    expect(cloudResultBlend(tool, 100)).toBe(1);
    expect(cloudResultBlend(tool, -1)).toBe(0);
  }
});
it('object generation and art results remain complete rather than translucent', () => {
  for (const tool of ['add', 'remove', 'people', 'sky'] as const) expect(cloudResultBlend(tool, 10)).toBe(1);
  expect(cloudResultBlend('style', 10, 'art')).toBe(1);
  expect(cloudResultBlend('smooth', Number.NaN)).toBe(0.45);
});
