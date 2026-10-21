import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processAutomaticBatchPortrait } from './automatic';
import { SHAPE_FIELDS, ZERO_PORTRAIT_SETTINGS } from '../portrait/settings';
import type { AutomaticRetouchResult } from '../portrait/auto-render';
const mocks = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('../portrait/auto-render', () => ({ renderAutomaticRetouch: mocks.render }));
function rendered(source = 'photo-A', exposure = .2): AutomaticRetouchResult {
  return { image: `${source}-retouched`, skinBaseline: `${source}-exposure`, changed: true, plan: {
    profile: 'natural', exposure, summary: '逐张光线与逐脸皮肤计划', warnings: ['复杂光线需复核'],
    faces: [{ id: 'face-1', label: '人物1' }, { id: 'face-2', label: '人物2' }],
    subjects: [{ face: { id: 'face-1', label: '人物1' }, settings: { ...ZERO_PORTRAIT_SETTINGS, smoothing: 18, dodgeBurn: 12 } },
      { face: { id: 'face-2', label: '人物2' }, settings: { ...ZERO_PORTRAIT_SETTINGS, smoothing: 4, dodgeBurn: 25 } }],
  } } as unknown as AutomaticRetouchResult;
}
beforeEach(() => { mocks.render.mockReset().mockResolvedValue(rendered()); });
describe('intelligent per-photo batch adapter', () => {
  it('uses the shared renderer once with the exact source/profile and no editor masks', async () => {
    const signal = new AbortController().signal;
    const result = await processAutomaticBatchPortrait('photo-A', 'texture', { signal });
    expect(mocks.render).toHaveBeenCalledOnce();
    const [source, options] = mocks.render.mock.calls[0];
    expect(source).toBe('photo-A'); expect(options.profile).toBe('texture'); expect(options.signal).toBe(signal);
    expect(Object.keys(options).sort()).toEqual(['onProgress', 'profile', 'signal']);
    expect(result.faceCount).toBe(2); expect(result.bodyCount).toBe(0); expect(result.image).toBe('photo-A-retouched');
  });
  it('stores each actual face plan separately without claiming the first face is a global preset', async () => {
    const plan = rendered(); mocks.render.mockResolvedValue(plan);
    const result = await processAutomaticBatchPortrait('photo-A', 'natural');
    expect(result.automatic.subjects.map(subject => subject.settings.smoothing)).toEqual([18, 4]);
    expect(result.automatic.exposure).toBe(.2);
    expect(result.automatic.subjects.every(subject => SHAPE_FIELDS.every(key => subject.settings[key] === 0))).toBe(true);
    plan.plan.subjects[0].settings.smoothing = 99;
    expect(result.automatic.subjects[0].settings.smoothing).toBe(18);
    expect(result.automatic).not.toHaveProperty('faces'); expect(result.automatic).not.toHaveProperty('settings');
    expect(result.automatic.warnings).toEqual(['复杂光线需复核']);
  });
  it('keeps different photo exposure/skin plans independent, including the selected bright profile', async () => {
    mocks.render.mockResolvedValueOnce(rendered('photo-A', .1)).mockResolvedValueOnce(rendered('photo-B', -.3));
    const a = await processAutomaticBatchPortrait('photo-A', 'natural'), b = await processAutomaticBatchPortrait('photo-B', 'bright');
    expect(a.automatic.exposure).toBe(.1); expect(b.automatic.exposure).toBe(-.3); expect(b.automatic.profile).toBe('bright');
    expect(mocks.render.mock.calls.map(call => call[0])).toEqual(['photo-A', 'photo-B']);
  });
  it('records only steps actually emitted and preserves an unchanged result for the existing skip contract', async () => {
    const progress: string[] = [];
    mocks.render.mockImplementation(async (_source, options) => {
      options.onProgress('分析光线'); options.onProgress('分析光线'); options.onProgress('分析各张脸');
      return { ...rendered('photo-A', 0), image: 'photo-A', changed: false };
    });
    const result = await processAutomaticBatchPortrait('photo-A', 'natural', { onProgress: label => progress.push(label) });
    expect(result.changed).toBe(false); expect(result.image).toBe('photo-A');
    expect(result.automatic.steps).toEqual(['分析光线', '分析各张脸']);
    expect(progress).toEqual(['分析光线', '分析光线', '分析各张脸']);
  });
  it('does not accept a late result after cancellation and rejects a pre-cancelled job before work', async () => {
    const pre = new AbortController(); pre.abort();
    await expect(processAutomaticBatchPortrait('photo-A', 'natural', { signal: pre.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.render).not.toHaveBeenCalled();
    let release!: (result: AutomaticRetouchResult) => void;
    mocks.render.mockImplementation(() => new Promise<AutomaticRetouchResult>(resolve => { release = resolve; }));
    const controller = new AbortController(), pending = processAutomaticBatchPortrait('photo-A', 'natural', { signal: controller.signal });
    controller.abort(); release(rendered());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
