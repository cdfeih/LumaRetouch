import { describe, expect, it } from 'vitest';
import { analyzeFaceSkinPixels } from './auto-statistics';
import { planAutomaticExposure, planAutomaticRetouch, planFaceSettings, refineAutomaticExposure } from './auto-retouch';
import type { AutomaticRetouchProfile } from './auto-retouch';
import { PORTRAIT_FIELDS, SHAPE_FIELDS, ZERO_PORTRAIT_SETTINGS } from './settings';
import type { PhotoAnalysis } from '../imaging/analysis';

const width = 64, height = 64;
function photo(color = [180,140,120], sample?: (x: number, y: number) => number) {
  const source = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) source.set([...color.map(value => value + (sample?.(x,y) ?? 0)),255], (y * width + x) * 4);
  return source;
}
const mask = () => new Uint8ClampedArray(width * height).fill(255);
const statistics = (source: Uint8ClampedArray, eligible = mask()) => analyzeFaceSkinPixels(source, width, height, eligible, { originalFaceWidth: 128, originalFaceHeight: 160, faceWidthInSamples: 64, candidateSamples: width * height });
const analysis = (extra: Partial<PhotoAnalysis> = {}): PhotoAnalysis => ({ width: 2400, height: 1600, median: 80, histogram: new Array(64).fill(0) as PhotoAnalysis['histogram'], shadowClipped: 0, highlightClipped: 0, suggestedExposure: .7, warnings: [], ...extra });

describe('measured skin demand, not an identical preset for every photo', () => {
  it('does not invent problems on a constant, adequately exposed skin patch', () => {
    const s = statistics(photo()); expect(s.reliable).toBe(true);
    expect(s.fineTexture).toBe(0); expect(s.midToneUnevenness).toBe(0); expect(s.redSpotFraction).toBe(0); expect(s.shineFraction).toBe(0);
    expect(planFaceSettings(s, 'natural')).toEqual(ZERO_PORTRAIT_SETTINGS);
    expect(planFaceSettings(s, 'texture')).toEqual(ZERO_PORTRAIT_SETTINGS);
  });
  it('responds to fine texture, with a lower ordinary-smoothing ceiling in texture mode', () => {
    const s = statistics(photo([180,140,120], (x,y) => (x+y)%2 ? 4 : -4));
    expect(s.fineTexture).toBeGreaterThan(2); expect(s.redSpotFraction).toBe(0);
    const natural = planFaceSettings(s, 'natural'), texture = planFaceSettings(s, 'texture');
    expect(natural.smoothing).toBeGreaterThan(0); expect(texture.smoothing).toBe(0);
  });
  it('detects sparse local red excess but does not classify uniform red warmth as acne', () => {
    const points = photo();
    for (let y = 8; y < 58; y += 8) for (let x = 8; x < 58; x += 8) points.set([210,100,90,255], (y*width+x)*4);
    const spotted = statistics(points), warm = statistics(photo([190,110,100]));
    expect(spotted.redSpotFraction).toBeGreaterThan(.001); expect(planFaceSettings(spotted,'natural').blemish).toBeGreaterThan(0);
    expect(warm.redSpotFraction).toBe(0); expect(planFaceSettings(warm,'natural')).toEqual(ZERO_PORTRAIT_SETTINGS);
  });
  it('does not turn neutral dark moles or a strong brightness edge into red-point repairs', () => {
    const source = photo();
    for (let y = 8; y < 58; y += 8) for (let x = 8; x < 58; x += 8) source.set([80,70,60,255],(y*width+x)*4);
    expect(statistics(source).redSpotFraction).toBe(0); expect(planFaceSettings(statistics(source),'natural').blemish).toBe(0);
    const edge = statistics(photo([130,130,130], x => x < 32 ? -30 : 60));
    expect(edge.fineTexture).toBe(0); expect(planFaceSettings(edge,'natural').smoothing).toBe(0);
  });
  it('never samples protected/excluded pixels or uses them as filter neighbours', () => {
    const a = photo(), b = photo(), eligible = mask();
    for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) { const p = y*width+x; eligible[p] = 0; b.set([255,0,0,255],p*4); }
    expect(statistics(a,eligible)).toEqual(statistics(b,eligible));
  });
  it('requires reliable native face size, usable coverage, opacity and non-clipped data', () => {
    const source = photo(), tinyMask = new Uint8ClampedArray(width*height); tinyMask.fill(255,100,150);
    expect(statistics(source,tinyMask).reliable).toBe(false);
    const small = analyzeFaceSkinPixels(source,width,height,mask(),{originalFaceWidth:40,originalFaceHeight:60}); expect(small.reliable).toBe(false);
    expect(planFaceSettings(small,'bright')).toEqual(ZERO_PORTRAIT_SETTINGS);
    expect(statistics(photo([255,255,255])).reliable).toBe(false); expect(statistics(photo([0,0,0])).reliable).toBe(false);
    for (let i = 3; i < source.length; i += 4) source[i] = 120;
    expect(statistics(source).validSamples).toBe(0); expect(statistics(source).reliable).toBe(false);
  });
  it('does not assume that darker intrinsic skin must be whitened', () => {
    const s = statistics(photo([90,60,45])); expect(s.reliable).toBe(true); expect(s.medianLuminance).toBeLessThan(100); expect(s.shadowFraction).toBe(0);
    expect(planFaceSettings(s,'natural').brightening).toBe(0);
    for (const profile of ['natural','bright','texture'] as const) {
      const p = planFaceSettings(s,profile); expect(p.warmth).toBe(0); expect(p.deYellow).toBe(0); expect(p.rosiness).toBe(0);
    }
  });
  it('reduces local lifting after positive global exposure instead of brightening twice', () => {
    const s = { ...statistics(photo()), medianLuminance: 70, shadowFraction: .25 };
    expect(planFaceSettings(s,'natural').brightening).toBeGreaterThan(0);
    expect(planFaceSettings(s,'natural',{exposureEV:.35}).brightening).toBe(0);
    expect(planFaceSettings(s,'bright',{exposureEV:.2}).brightening).toBeLessThan(planFaceSettings(s,'bright').brightening);
  });
  it('bounds even extreme measured demand and leaves all shape/facial reconstruction controls off', () => {
    const s = { ...statistics(photo()), fineTexture: 200, midToneUnevenness: 200, redSpotFraction: 1, redChromaSpread: 200, shineFraction: 1, shadowFraction: .5, medianLuminance: 45 };
    for (const profile of ['natural','bright','texture'] as const) {
      const p = planFaceSettings(s,profile);
      for (const field of PORTRAIT_FIELDS) expect(p[field.key]).toBeGreaterThanOrEqual(field.min);
      expect(p.smoothing).toBeLessThanOrEqual(20); expect(p.dodgeBurn).toBeLessThanOrEqual(35); expect(p.brightening).toBeLessThanOrEqual(20); expect(p.blemish).toBeLessThanOrEqual(22);
      for (const key of [...SHAPE_FIELDS,'darkCircles','teethWhitening','eyeWhitening','lipColor'] as const) expect(p[key]).toBe(0);
    }
    expect(planFaceSettings({...s,fineTexture:NaN},'natural')).toEqual(ZERO_PORTRAIT_SETTINGS);
  });
  it('rejects malformed pixel buffers and supports pre-cancelled analysis without loading models', async () => {
    expect(() => analyzeFaceSkinPixels(photo(),width,height,new Uint8ClampedArray(1),{originalFaceWidth:128,originalFaceHeight:160})).toThrow();
    const c = new AbortController(); c.abort(); await expect(planAutomaticRetouch('',{profile:'natural',signal:c.signal})).rejects.toMatchObject({name:'AbortError'});
    await expect(planAutomaticRetouch('invalid',{profile:'natural'})).rejects.toThrow('照片数据无效');
  });
});

describe('automatic global exposure is a conservative suggestion', () => {
  it('uses profile limits without clipping already bright highlights', () => {
    expect(planAutomaticExposure(analysis(),'natural')).toBe(.3); expect(planAutomaticExposure(analysis(),'bright')).toBe(.5); expect(planAutomaticExposure(analysis(),'texture')).toBe(.2);
    expect(planAutomaticExposure(analysis({highlightClipped:.006}),'bright')).toBe(0);
    expect(planAutomaticExposure(analysis({suggestedExposure:-.7}),'natural')).toBe(-.3);
  });
  it('disables whole-image exposure for hard mask limits or unrecoverable clipping', () => {
    expect(planAutomaticExposure(analysis(),'natural',true)).toBe(0);
    expect(planAutomaticExposure(analysis({shadowClipped:1}),'bright')).toBe(0);
    expect(planAutomaticExposure(analysis({highlightClipped:1,suggestedExposure:-.7}),'bright')).toBe(0);
    expect(() => planAutomaticExposure(analysis(),'unknown' as AutomaticRetouchProfile)).toThrow();
  });
  it('does not chase dark or white backgrounds at the expense of already adequate face exposure', () => {
    const adequate = statistics(photo());
    expect(refineAutomaticExposure(.3,[adequate],'natural').exposure).toBe(0);
    expect(refineAutomaticExposure(.2,[adequate],'texture').exposure).toBe(0);
    expect(refineAutomaticExposure(.5,[adequate],'bright').exposure).toBe(.5);
    expect(refineAutomaticExposure(-.3,[adequate],'bright').exposure).toBe(0);
    expect(refineAutomaticExposure(.5,[{...adequate,medianLuminance:190}],'bright').exposure).toBe(0);
    expect(refineAutomaticExposure(-.3,[{...adequate,medianLuminance:200}],'natural').exposure).toBe(-.3);
  });
});
