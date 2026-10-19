import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortraitFace } from './detection';
import { associatePortraitPeople, detectPortraitBodies, type PortraitBody } from './body';

const mocks = vi.hoisted(() => ({ detect: vi.fn(), create: vi.fn() }));
vi.mock('@mediapipe/tasks-vision', () => ({ PoseLandmarker: { createFromOptions: mocks.create } }));

function body(id: string, x: number): PortraitBody {
  const landmarks = Array.from({ length: 33 }, () => ({ x, y: 0.6, visibility: 0.95 }));
  landmarks[0] = { x, y: 0.2, visibility: 0.95 };
  return { id, label: id, bounds: { x: x - 0.12, y: 0.1, width: 0.24, height: 0.8 }, landmarks,
    mask: { width: 1, height: 1, data: new Uint8ClampedArray([255]) }, thumbnail: `${id}.jpg` };
}

function face(id: string, x: number): PortraitFace {
  return { id, label: id, bounds: { x: x - 0.05, y: 0.15, width: 0.1, height: 0.1 },
    landmarks: Array.from({ length: 478 }, () => ({ x, y: 0.2 })), thumbnail: `${id}.jpg` };
}

describe('face and body geometry association', () => {
  it('matches by nose geometry, preserves face IDs and numbers people left to right', () => {
    const people = associatePortraitPeople([face('face-2', 0.7), face('face-1', 0.2)], [body('body-1', 0.7), body('body-2', 0.2)]);
    expect(people.map(person => [person.id, person.label, person.body?.id])).toEqual([
      ['face-1', '人物 1', 'body-2'], ['face-2', '人物 2', 'body-1'],
    ]);
    expect(people[0].thumbnail).toBe('face-1.jpg');
    expect(people[0].bounds.height).toBe(0.8);
  });

  it('does not attach a nearby face just because its body bounds overlap', () => {
    const wrong = body('body-1', 0.75); wrong.bounds = { x: 0, y: 0, width: 1, height: 1 };
    const people = associatePortraitPeople([face('face-1', 0.25)], [wrong]);
    expect(people).toHaveLength(2);
    expect(people.find(person => person.face)?.body).toBeUndefined();
  });

  it('retains body-only and face-only people, and never reuses one body for two faces', () => {
    const people = associatePortraitPeople([face('face-1', 0.2), face('face-2', 0.24)], [body('body-1', 0.2), body('body-2', 0.8)]);
    expect(people).toHaveLength(3);
    expect(people.filter(person => person.body?.id === 'body-1')).toHaveLength(1);
    expect(people.find(person => person.id === 'body-2')?.face).toBeUndefined();
  });

  it('uses visible eyes when the nose is hidden but does not guess from hidden head points', () => {
    const detected = body('body-1', 0.4); detected.landmarks[0].visibility = 0.1;
    detected.landmarks[2] = { x: 0.38, y: 0.195, visibility: 0.9 };
    detected.landmarks[5] = { x: 0.42, y: 0.195, visibility: 0.9 };
    expect(associatePortraitPeople([face('face-1', 0.4)], [detected])).toHaveLength(1);
    detected.landmarks[2].visibility = detected.landmarks[5].visibility = 0.1;
    expect(associatePortraitPeople([face('face-1', 0.4)], [detected])).toHaveLength(2);
  });

  it('supports no detections and caps the visible person list at ten', () => {
    expect(associatePortraitPeople([], [])).toEqual([]);
    const many = Array.from({ length: 12 }, (_, index) => body(`body-${index + 1}`, index / 20));
    expect(associatePortraitPeople([], many)).toHaveLength(10);
  });
});

describe('local pose detection resources and confidence', () => {
  beforeEach(() => {
    class TestImage {
      naturalWidth = 400; naturalHeight = 600;
      onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', TestImage);
    vi.stubGlobal('document', { baseURI: 'http://127.0.0.1:5178/', createElement: () => ({
      width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toDataURL: () => 'data:image/jpeg;base64,thumbnail',
    }) });
    mocks.create.mockResolvedValue({ detect: mocks.detect });
    mocks.detect.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  function result(points = body('body-1', 0.4).landmarks, values = new Float32Array(100).fill(0.8)) {
    const mask = { width: 10, height: 10, getAsFloat32Array: () => values, close: vi.fn() };
    const value = { landmarks: [points], segmentationMasks: [mask], close: vi.fn(() => mask.close()) };
    return { value, mask, values };
  }

  it('loads a local CPU IMAGE model with ten poses and copies masks before releasing resources', async () => {
    const fixture = result(); fixture.values[0] = Number.NaN; fixture.values[1] = 2; fixture.values[2] = -1;
    mocks.detect.mockReturnValue(fixture.value);
    const detected = await detectPortraitBodies('data:image/jpeg;base64,fake');
    expect(detected).toHaveLength(1);
    expect(detected[0].landmarks).toHaveLength(33);
    expect([...detected[0].mask.data.slice(0, 4)]).toEqual([0, 255, 0, 204]);
    fixture.values.fill(0);
    expect(detected[0].mask.data[3]).toBe(204);
    expect(fixture.mask.close).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      wasmLoaderPath: 'http://127.0.0.1:5178/models/vision_wasm_nosimd_internal.js',
    }), expect.objectContaining({ runningMode: 'IMAGE', numPoses: 10, outputSegmentationMasks: true,
      baseOptions: { modelAssetPath: 'http://127.0.0.1:5178/models/pose_landmarker_lite.task', delegate: 'CPU' } }));
  });

  it('rejects low-confidence bodies, empty masks and missing masks without inventing locations', async () => {
    const fixture = result(); fixture.value.landmarks[0].forEach(point => { point.visibility = 0.1; });
    mocks.detect.mockReturnValue(fixture.value);
    expect(await detectPortraitBodies('fake')).toEqual([]);
    expect(fixture.mask.close).toHaveBeenCalledOnce();
    const empty = result(undefined, new Float32Array(100)); mocks.detect.mockReturnValue(empty.value);
    expect(await detectPortraitBodies('fake')).toEqual([]);
    mocks.detect.mockReturnValue({ landmarks: [body('body-1', 0.5).landmarks], close: vi.fn() });
    expect(await detectPortraitBodies('fake')).toEqual([]);
  });

  it('returns an empty list for no person and reports detection failures in Chinese', async () => {
    mocks.detect.mockReturnValue({ landmarks: [], segmentationMasks: [], close: vi.fn() });
    expect(await detectPortraitBodies('fake')).toEqual([]);
    mocks.detect.mockImplementation(() => { throw new Error('internal failure'); });
    await expect(detectPortraitBodies('fake')).rejects.toThrow('本地身体识别失败');
  });

  it('does not clamp out-of-frame joints into the photo', async () => {
    const fixture = result(); fixture.value.landmarks[0][27] = { x: 0.4, y: 1.2, visibility: 0.2 };
    mocks.detect.mockReturnValue(fixture.value);
    expect((await detectPortraitBodies('fake'))[0].landmarks[27]).toEqual({ x: 0.4, y: 1.2, visibility: 0.2 });
  });

  it('honors cancellation before image decoding and releases masks if canceled during inference', async () => {
    const before = new AbortController(); before.abort();
    await expect(detectPortraitBodies('fake', before.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.detect).not.toHaveBeenCalled();
    const during = new AbortController(), fixture = result();
    mocks.detect.mockImplementation(() => { during.abort(); return fixture.value; });
    await expect(detectPortraitBodies('fake', during.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.mask.close).toHaveBeenCalledOnce();
  });
});
