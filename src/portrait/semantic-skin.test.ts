import { describe, expect, it } from 'vitest';
import { faceSkinConfidence, semanticCoverage } from './semantic-skin';
describe('conservative semantic face-skin confidence', () => {
  it('excludes hair, body-skin, clothes, accessories and ambiguous pixels', () => {
    const classes = Array.from({ length: 6 }, () => new Float32Array(7));
    for (let c = 0; c < 6; c++) classes[c][c] = .95;
    classes[3][6] = .58; classes[5][6] = .55;
    expect([...faceSkinConfidence(classes, 7, 1).data]).toEqual([0, 0, 0, 255, 0, 0, 0]);
  });
  it('never trusts non-finite model output or promotes a weak face prediction', () => {
    const classes = Array.from({ length: 6 }, () => new Float32Array(3));
    classes[3].set([NaN, .54, .9]); classes[1][2] = Infinity;
    expect([...faceSkinConfidence(classes, 3, 1).data]).toEqual([0, 0, 0]);
    expect(() => faceSkinConfidence(classes.slice(0, 5), 3, 1)).toThrow();
  });
  it('shrinks toward uncertainty rather than filling a hair/accessory hole when resampling', () => {
    const mask = { width: 3, height: 1, data: new Uint8ClampedArray([255, 0, 255]) };
    const values = Array.from({ length: 12 }, (_, x) => semanticCoverage(mask, x, 0, 12, 1));
    expect(values[4]).toBe(0); expect(values[5]).toBe(0); expect(values[6]).toBe(0); expect(values[7]).toBe(0);
    expect(semanticCoverage({ width: 1, height: 1, data: new Uint8ClampedArray([128]) }, 100, 100, 200, 200)).toBe(128);
  });
});
