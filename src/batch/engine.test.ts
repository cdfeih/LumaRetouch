import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortraitFace } from '../portrait/detection';
import type { PortraitBody } from '../portrait/body';
import { DEFAULT_PORTRAIT_SETTINGS, SHAPE_FIELDS, ZERO_PORTRAIT_SETTINGS } from '../portrait/settings';
import { processBatchPortrait } from './engine';
import type { BatchPortraitProgress } from './engine';

const mocks = vi.hoisted(() => ({ faces: vi.fn(), bodies: vi.fn(), natural: vi.fn(), warp: vi.fn() }));
vi.mock('../portrait/detection', () => ({ detectPortraitFaces: mocks.faces }));
vi.mock('../portrait/body', async importOriginal => ({ ...await importOriginal<typeof import('../portrait/body')>(), detectPortraitBodies: mocks.bodies }));
vi.mock('../portrait/render', () => ({ renderNaturalRetouch: mocks.natural }));
vi.mock('../portrait/warp-render', () => ({ renderPortraitWarp: mocks.warp }));

const SOURCE = 'data:image/png;base64,original-photo';
const SKIN = 'data:image/png;base64,local-skin-result';
const SHAPED = 'data:image/png;base64,local-shaped-result';

function face(id = 'face-1', x = 0.4): PortraitFace {
  const landmarks = Array.from({ length: 478 }, () => ({ x, y: 0.2 }));
  landmarks[10] = { x, y: 0.14 }; landmarks[152] = { x, y: 0.29 };
  landmarks[234] = { x: x - 0.05, y: 0.22 }; landmarks[454] = { x: x + 0.05, y: 0.22 };
  return { id, label: id, bounds: { x: x - 0.06, y: 0.13, width: 0.12, height: 0.17 }, landmarks, thumbnail: `${id}.jpg` };
}

function body(id = 'body-1', x = 0.4): PortraitBody {
  const landmarks = Array.from({ length: 33 }, () => ({ x, y: 0.2, visibility: 0.95 }));
  for (const [index, dx, y] of [[11, -0.1, 0.35], [12, 0.1, 0.35], [13, -0.15, 0.5], [14, 0.15, 0.5],
    [15, -0.2, 0.65], [16, 0.2, 0.65], [23, -0.06, 0.65], [24, 0.06, 0.65],
    [25, -0.06, 0.8], [26, 0.06, 0.8], [27, -0.06, 0.95], [28, 0.06, 0.95]]) {
    landmarks[index] = { x: x + dx, y, visibility: 0.95 };
  }
  return { id, label: id, bounds: { x: x - 0.22, y: 0.13, width: 0.44, height: 0.85 }, landmarks,
    mask: { width: 1, height: 1, data: new Uint8ClampedArray([255]) }, thumbnail: `${id}.jpg` };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.faces.mockReset().mockResolvedValue([face()]);
  mocks.bodies.mockReset().mockResolvedValue([body()]);
  mocks.natural.mockReset().mockResolvedValue(SKIN);
  mocks.warp.mockReset().mockResolvedValue(SHAPED);
});

describe('local batch portrait engine', () => {
  it('short-circuits all-zero settings without detection, rendering, or preset mutation', async () => {
    const parameters = Object.freeze({ ...ZERO_PORTRAIT_SETTINGS });
    const progress: BatchPortraitProgress[] = [];
    expect(await processBatchPortrait(SOURCE, parameters, { onProgress: value => progress.push(value) }))
      .toEqual({ image: SOURCE, faceCount: 0, bodyCount: 0, changed: false, warnings: [] });
    expect(mocks.faces).not.toHaveBeenCalled(); expect(mocks.bodies).not.toHaveBeenCalled();
    expect(mocks.natural).not.toHaveBeenCalled(); expect(mocks.warp).not.toHaveBeenCalled();
    expect(progress.map(value => value.stage)).toEqual(['done']);
    expect(parameters).toEqual(ZERO_PORTRAIT_SETTINGS);
  });

  it('runs default natural finishing locally without loading body detection or warp', async () => {
    const signal = new AbortController().signal;
    const result = await processBatchPortrait(SOURCE, { ...DEFAULT_PORTRAIT_SETTINGS }, { signal });
    expect(result).toEqual({ image: SKIN, faceCount: 1, bodyCount: 0, changed: true, warnings: [] });
    expect(mocks.faces).toHaveBeenCalledExactlyOnceWith(SOURCE);
    expect(mocks.bodies).not.toHaveBeenCalled(); expect(mocks.warp).not.toHaveBeenCalled();
    expect(mocks.natural).toHaveBeenCalledWith(SOURCE, SOURCE, [{ face: face(), settings: DEFAULT_PORTRAIT_SETTINGS }], { signal });
  });

  it('applies all twenty preset parameters once from this photo and does not inherit editor masks/history', async () => {
    const settings = { ...DEFAULT_PORTRAIT_SETTINGS, warmth: -16, deYellow: 12, deRedness: 9, rosiness: 7,
      darkCircles: 18, teethWhitening: 10, eyeWhitening: 8, lipColor: 6, faceSlim: 15, jawSlim: 12, chinLength: -5,
      waistSlim: 13, armSlim: 12, legSlim: 11, shoulderWidth: -10 };
    const before = structuredClone(settings);
    const progress: BatchPortraitProgress[] = [];
    const result = await processBatchPortrait(SOURCE, settings, { onProgress: value => progress.push(value) });
    expect(result.faceCount).toBe(1); expect(result.bodyCount).toBe(1); expect(result.changed).toBe(true);
    expect(result.image).toBe(SHAPED);
    expect(mocks.bodies).toHaveBeenCalledExactlyOnceWith(SOURCE, undefined);
    expect(mocks.natural).toHaveBeenCalledOnce(); expect(mocks.warp).toHaveBeenCalledOnce();
    expect(mocks.natural.mock.calls[0][2][0].settings).toEqual(settings);
    expect(mocks.warp.mock.calls[0]).toEqual([SKIN, SOURCE, [{ face: face(), body: body(),
      settings: Object.fromEntries(SHAPE_FIELDS.map(key => [key, settings[key]])) }], { signal: undefined }]);
    expect(settings).toEqual(before);
    expect(progress.map(value => value.stage)).toEqual(['detect-face', 'detect-body', 'retouch', 'shape', 'done']);
    expect(progress.map(value => value.percent)).toEqual([0, 20, 40, 65, 100]);
  });

  it('snapshots the preset before asynchronous work and uses fresh detection for each photo', async () => {
    let release!: (value: PortraitFace[]) => void;
    mocks.faces.mockImplementationOnce(() => new Promise<PortraitFace[]>(resolve => { release = resolve; }));
    const settings = { ...DEFAULT_PORTRAIT_SETTINGS };
    const pending = processBatchPortrait(SOURCE, settings);
    settings.smoothing = 99; settings.legSlim = 50;
    release([face()]); await pending;
    expect(mocks.natural.mock.calls[0][2][0].settings).toEqual(DEFAULT_PORTRAIT_SETTINGS);
    expect(mocks.bodies).not.toHaveBeenCalled();
    await processBatchPortrait('data:image/png;base64,second-photo', { ...DEFAULT_PORTRAIT_SETTINGS });
    expect(mocks.faces).toHaveBeenCalledTimes(2);
    expect(mocks.natural.mock.calls[1][0]).toBe('data:image/png;base64,second-photo');
    expect(mocks.natural.mock.calls[1][1]).toBe('data:image/png;base64,second-photo');
  });

  it('reports no visible face as unprocessed instead of succeeding with a re-encoded original', async () => {
    mocks.faces.mockResolvedValue([]);
    const result = await processBatchPortrait(SOURCE, { ...DEFAULT_PORTRAIT_SETTINGS });
    expect(result.image).toBe(SOURCE); expect(result.changed).toBe(false);
    expect(result.faceCount).toBe(0); expect(result.bodyCount).toBe(0);
    expect(result.warnings.join('')).toContain('本张未处理');
    expect(mocks.bodies).not.toHaveBeenCalled(); expect(mocks.natural).not.toHaveBeenCalled(); expect(mocks.warp).not.toHaveBeenCalled();
  });

  it('allows body-only photos with usable joints and warns if face finishing cannot apply', async () => {
    mocks.faces.mockResolvedValue([]);
    const result = await processBatchPortrait(SOURCE, { ...DEFAULT_PORTRAIT_SETTINGS, waistSlim: 20 });
    expect(result).toMatchObject({ image: SHAPED, faceCount: 0, bodyCount: 1, changed: true });
    expect(result.warnings.join('')).toContain('没有可见人脸');
    expect(mocks.natural).not.toHaveBeenCalled(); expect(mocks.warp).toHaveBeenCalledOnce();
    expect(mocks.warp.mock.calls[0][0]).toBe(SOURCE);
  });

  it('skips skin rendering when the preset only requests shape controls', async () => {
    await processBatchPortrait(SOURCE, { ...ZERO_PORTRAIT_SETTINGS, faceSlim: 15 });
    expect(mocks.bodies).not.toHaveBeenCalled(); expect(mocks.natural).not.toHaveBeenCalled();
    expect(mocks.warp.mock.calls[0].slice(0, 2)).toEqual([SOURCE, SOURCE]);
  });

  it('rejects absent or incomplete faces for nonzero face shaping before any rendering', async () => {
    mocks.faces.mockResolvedValueOnce([]);
    await expect(processBatchPortrait(SOURCE, { ...DEFAULT_PORTRAIT_SETTINGS, chinLength: -10 })).rejects.toThrow('无法应用面部塑形');
    const incomplete = face(); incomplete.landmarks = incomplete.landmarks.slice(0, 100);
    mocks.faces.mockResolvedValueOnce([incomplete]);
    await expect(processBatchPortrait(SOURCE, { ...DEFAULT_PORTRAIT_SETTINGS, faceSlim: 10 })).rejects.toThrow('完整面部关键点');
    expect(mocks.natural).not.toHaveBeenCalled(); expect(mocks.warp).not.toHaveBeenCalled();
  });

  it('rejects a body preset if there are no reliable bodies, instead of applying skin alone', async () => {
    mocks.bodies.mockResolvedValue([]);
    await expect(processBatchPortrait(SOURCE, { ...DEFAULT_PORTRAIT_SETTINGS, waistSlim: 20 })).rejects.toThrow('身体关键点');
    expect(mocks.natural).not.toHaveBeenCalled(); expect(mocks.warp).not.toHaveBeenCalled();
  });

  it('rejects the whole photo if any requested body adjustment lacks joints', async () => {
    const incomplete = body(); incomplete.landmarks[23].visibility = 0.1;
    mocks.bodies.mockResolvedValue([incomplete]);
    await expect(processBatchPortrait(SOURCE, { ...DEFAULT_PORTRAIT_SETTINGS, armSlim: 20, waistSlim: 20 })).rejects.toThrow('瘦腰');
    expect(mocks.natural).not.toHaveBeenCalled(); expect(mocks.warp).not.toHaveBeenCalled();
  });

  it('refuses partial shaping of a group when one person has no matching body', async () => {
    mocks.faces.mockResolvedValue([face('face-1', 0.3), face('face-2', 0.75)]);
    mocks.bodies.mockResolvedValue([body('body-1', 0.3)]);
    await expect(processBatchPortrait(SOURCE, { ...DEFAULT_PORTRAIT_SETTINGS, shoulderWidth: -10 })).rejects.toThrow('人物 2');
    expect(mocks.natural).not.toHaveBeenCalled(); expect(mocks.warp).not.toHaveBeenCalled();
  });

  it('supports shoulders in half-body photos, but rejects out-of-frame or hidden limb points', async () => {
    const half = body();
    for (let index = 23; index <= 28; index += 1) half.landmarks[index] = { x: 0.4, y: 1.2, visibility: 0.9 };
    mocks.bodies.mockResolvedValue([half]);
    await expect(processBatchPortrait(SOURCE, { ...ZERO_PORTRAIT_SETTINGS, shoulderWidth: -12 })).resolves.toMatchObject({ changed: true });
    mocks.natural.mockClear(); mocks.warp.mockClear();
    await expect(processBatchPortrait(SOURCE, { ...DEFAULT_PORTRAIT_SETTINGS, legSlim: 10 })).rejects.toThrow('瘦腿');
    expect(mocks.natural).not.toHaveBeenCalled(); expect(mocks.warp).not.toHaveBeenCalled();
  });

  it('accepts a reliable visible arm segment without requiring hidden joints on the other side', async () => {
    const partial = body();
    for (const index of [12, 14, 15, 16]) partial.landmarks[index].visibility = 0.1;
    mocks.bodies.mockResolvedValue([partial]);
    await expect(processBatchPortrait(SOURCE, { ...ZERO_PORTRAIT_SETTINGS, armSlim: 20 })).resolves.toMatchObject({ changed: true });
  });

  it('rejects an already cancelled task even for zero settings', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(processBatchPortrait(SOURCE, { ...ZERO_PORTRAIT_SETTINGS }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.faces).not.toHaveBeenCalled();
  });

  it('cancels during face detection promptly and ignores its late result', async () => {
    const controller = new AbortController();
    let release!: (value: PortraitFace[]) => void;
    mocks.faces.mockImplementation(() => new Promise<PortraitFace[]>(resolve => { release = resolve; }));
    const pending = processBatchPortrait(SOURCE, { ...DEFAULT_PORTRAIT_SETTINGS }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    release([face()]); await Promise.resolve();
    expect(mocks.natural).not.toHaveBeenCalled(); expect(mocks.warp).not.toHaveBeenCalled();
  });

  it('never returns a skin-only intermediate when cancelled before shaping', async () => {
    const controller = new AbortController();
    await expect(processBatchPortrait(SOURCE, { ...DEFAULT_PORTRAIT_SETTINGS, faceSlim: 10 }, {
      signal: controller.signal,
      onProgress: value => { if (value.stage === 'shape') controller.abort(); },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.natural).toHaveBeenCalledOnce(); expect(mocks.warp).not.toHaveBeenCalled();
  });

  it('preserves renderer failures and does not claim completion when rendering changes no pixels', async () => {
    mocks.natural.mockRejectedValueOnce(new Error('本地线程失败'));
    await expect(processBatchPortrait(SOURCE, { ...DEFAULT_PORTRAIT_SETTINGS })).rejects.toThrow('本地线程失败');
    mocks.natural.mockResolvedValueOnce(SOURCE);
    expect(await processBatchPortrait(SOURCE, { ...DEFAULT_PORTRAIT_SETTINGS }))
      .toMatchObject({ image: SOURCE, changed: false, faceCount: 1 });
  });
});
