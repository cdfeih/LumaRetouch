import { describe, expect, it } from 'vitest';
import { createFaceDetailMasks, createFaceSkinMask, type PortraitFace } from './detection';

const OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
const EYE_LEFT = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246];
const EYE_RIGHT = [263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466];
const BROW_LEFT = [70,63,105,66,107,55,65,52,53,46];
const BROW_RIGHT = [300,293,334,296,336,285,295,282,283,276];
const MOUTH = [61,146,91,181,84,17,314,405,321,375,291,409,270,269,267,0,37,39,40,185];

function fixture(): PortraitFace {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  function ellipse(indices: number[], x: number, y: number, rx: number, ry: number) {
    indices.forEach((index, order) => {
      const angle = order / indices.length * Math.PI * 2 - Math.PI / 2;
      landmarks[index] = { x: x + rx * Math.cos(angle), y: y + ry * Math.sin(angle) };
    });
  }
  ellipse(OVAL, 0.5, 0.5, 0.3, 0.4);
  ellipse(EYE_LEFT, 0.38, 0.42, 0.06, 0.025);
  ellipse(EYE_RIGHT, 0.62, 0.42, 0.06, 0.025);
  ellipse(BROW_LEFT, 0.38, 0.33, 0.065, 0.012);
  ellipse(BROW_RIGHT, 0.62, 0.33, 0.065, 0.012);
  ellipse(MOUTH, 0.5, 0.67, 0.09, 0.035);
  return { id: 'face-1', label: '人物 1', bounds: { x: 0.2, y: 0.1, width: 0.6, height: 0.8 }, landmarks, thumbnail: '' };
}

describe('face skin mask', () => {
  it('limits all edits to the selected face and retains fully weighted cheek skin', () => {
    const mask = createFaceSkinMask(fixture(), 200, 200);
    expect(mask).toHaveLength(40_000);
    expect(mask[100 * 200 + 76]).toBe(255);
    expect(mask[110 * 200 + 124]).toBe(255);
    expect(mask[20 * 200 + 20]).toBe(0);
    expect(mask[100 * 200 + 10]).toBe(0);
    expect(mask[195 * 200 + 100]).toBe(0);
  });

  it('keeps eyes, eyebrows, lips and their margins unmodified', () => {
    const mask = createFaceSkinMask(fixture(), 200, 200);
    for (const [x, y] of [[76,84],[124,84],[76,66],[124,66],[100,134],[91,134]]) expect(mask[y * 200 + x]).toBe(0);
    // Expanded eye exclusion includes eyelid margins beyond the raw contour.
    expect(mask[84 * 200 + 91]).toBe(0);
  });

  it('feathers inward while keeping the entire outside exactly zero', () => {
    const mask = createFaceSkinMask(fixture(), 200, 200);
    expect([...mask].some(value => value > 0 && value < 255)).toBe(true);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
      if (x < 40 || x >= 160 || y < 20 || y >= 180) expect(mask[y * 200 + x]).toBe(0);
    }
  });

  it('maps normalized landmarks consistently onto a non-square photo', () => {
    const mask = createFaceSkinMask(fixture(), 400, 200);
    expect(mask).toHaveLength(80_000);
    expect(mask[100 * 400 + 152]).toBe(255);
    expect(mask[84 * 400 + 152]).toBe(0);
    expect(mask[100 * 400 + 30]).toBe(0);
  });

  it('supports a face touching the image boundary without spreading out of bounds', () => {
    const face = fixture();
    face.landmarks = face.landmarks.map(point => ({ x: point.x - 0.3, y: point.y }));
    const mask = createFaceSkinMask(face, 200, 200);
    expect(mask).toHaveLength(40_000);
    expect(mask[100 * 200 + 25]).toBe(255);
    expect(mask[100 * 200 + 130]).toBe(0);
  });

  it('rejects invalid dimensions and invalid face geometry instead of editing the full photo', () => {
    expect(() => createFaceSkinMask(fixture(), 0, 200)).toThrow('尺寸无效');
    expect(() => createFaceSkinMask(fixture(), 1.5, 200)).toThrow('尺寸无效');
    expect(() => createFaceSkinMask(fixture(), 100_000, 100_000)).toThrow('尺寸无效');
    expect(() => createFaceSkinMask({ ...fixture(), landmarks: [] }, 200, 200)).toThrow('关键点不完整');
    const face = fixture();
    face.landmarks[100].x = Number.NaN;
    expect(() => createFaceSkinMask(face, 200, 200)).toThrow('关键点不完整');
  });
});


describe('face detail geometry', () => {
  function detailedFace(): PortraitFace {
    const face = fixture()
    const inner = [78,95,88,178,87,14,317,402,318,324,308,415,310,311,312,13,82,81,80,191]
    const ellipse = (indices: number[], cx: number, cy: number, rx: number, ry: number) => indices.forEach((index, order) => {
      const angle = order / indices.length * Math.PI * 2 - Math.PI / 2
      face.landmarks[index] = { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }
    })
    // Match mesh ordering: outer corner, lower lid, inner corner, upper lid.
    for (const [indices, cx] of [[EYE_LEFT, 0.38], [EYE_RIGHT, 0.62]] as const) indices.forEach((index, order) => {
      const angle = Math.PI - order / indices.length * Math.PI * 2
      face.landmarks[index] = { x: cx + 0.06 * Math.cos(angle), y: 0.42 + 0.025 * Math.sin(angle) }
    })
    ellipse(inner, 0.5, 0.67, 0.06, 0.018)
    ellipse([469,470,471,472], 0.38, 0.42, 0.012, 0.018)
    ellipse([474,475,476,477], 0.62, 0.42, 0.012, 0.018)
    return face
  }

  it('separates inner mouth, lip ring and eye whites while excluding iris and feature margins', () => {
    const details = createFaceDetailMasks(detailedFace(), 400, 400)
    expect(details.teeth[268 * 400 + 200]).toBeGreaterThan(0)
    expect(details.lips[268 * 400 + 200]).toBe(0)
    expect(details.lips[256 * 400 + 200]).toBeGreaterThan(0)
    expect(details.teeth[256 * 400 + 200]).toBe(0)
    expect(details.eyes[168 * 400 + 152]).toBe(0)
    expect(details.eyes[168 * 400 + 248]).toBe(0)
    expect(details.eyes[168 * 400 + 140]).toBeGreaterThan(0)
    for (const mask of Object.values(details)) {
      expect(mask[20 * 400 + 20]).toBe(0)
      expect([...mask].some(value => value > 0 && value < 255)).toBe(true)
    }
  })

  it('limits the under-eye band to skin and keeps unrelated cheeks and eye interiors clear', () => {
    const face = detailedFace(), skin = createFaceSkinMask(face, 400, 200)
    const details = createFaceDetailMasks(face, 400, 200)
    expect([...details.underEyes].some(value => value > 0)).toBe(true)
    for (let pixel = 0; pixel < skin.length; pixel++) if (!skin[pixel]) expect(details.underEyes[pixel]).toBe(0)
    expect(details.underEyes[84 * 400 + 152]).toBe(0)
    expect(details.underEyes[120 * 400 + 152]).toBe(0)
    expect(() => createFaceDetailMasks(face, 0, 200)).toThrow('尺寸无效')
    expect(() => createFaceDetailMasks({ ...face, landmarks: [] }, 400, 200)).toThrow('关键点不完整')
  })
})
