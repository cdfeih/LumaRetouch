import { describe, expect, it } from 'vitest';
import { faceInRegion, planFaceWorkRegion, protectionInRegion } from './regions';
import type { PortraitFace } from './detection';
const face = (bounds: PortraitFace['bounds']): PortraitFace => ({ id: '1', label: '1', thumbnail: '', bounds, landmarks: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }] });
describe('original-pixel face work regions', () => {
  it('keeps distant faces at native resolution instead of shrinking with a 40MP photo', () => {
    const region = planFaceWorkRegion(face({ x: .4, y: .3, width: .04, height: .06 }), 8000, 5000);
    expect(region.width).toBeGreaterThan(320); expect(region.height).toBeGreaterThan(300);
    expect(region.workWidth).toBe(region.width); expect(region.workHeight).toBe(region.height);
  });
  it('bounds close-up work buffers, clips crop to edges and round-trips landmark positions', () => {
    const person = face({ x: 0, y: 0, width: .9, height: .9 }), region = planFaceWorkRegion(person, 8000, 5000);
    expect(region.x).toBe(0); expect(region.y).toBe(0); expect(Math.max(region.workWidth, region.workHeight)).toBe(1600);
    const local = faceInRegion(person, 8000, 5000, region);
    expect(local.landmarks[0].x * region.width + region.x).toBeCloseTo(person.landmarks[0].x * 8000);
    expect(local.landmarks[0].y * region.height + region.y).toBeCloseTo(person.landmarks[0].y * 5000);
  });
  it('preserves alpha-1 protection through offset crops and downsampling', () => {
    const source = new Uint8ClampedArray(100); source[5 * 10 + 5] = 1;
    expect([...protectionInRegion(source, 10, 10, 100, 100, { x: 40, y: 40, width: 40, height: 40 }, 2, 2)]).toEqual([255, 0, 0, 0]);
    expect([...protectionInRegion(source, 10, 10, 100, 100, { x: 0, y: 0, width: 20, height: 20 }, 2, 2)]).toEqual([0, 0, 0, 0]);
  });
  it('rejects invalid dimensions without allocating a work grid', () => {
    expect(() => planFaceWorkRegion(face({ x: 0, y: 0, width: .2, height: .2 }), 8001, 5000)).toThrow();
    expect(() => protectionInRegion(new Uint8ClampedArray(1), 2, 2, 10, 10, { x: 0, y: 0, width: 10, height: 10 }, 2, 2)).toThrow();
  });
});
