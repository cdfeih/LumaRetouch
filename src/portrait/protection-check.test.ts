import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectPortraitFaces, type PortraitFace } from './detection';
import { assertProtectedFaceAlignment, assertProtectedFaceGeometry, compareFaceGeometry, protectedPortraitFaces, type ProtectionMaskPixels } from './protection-check';

vi.mock('./detection', () => ({ detectPortraitFaces: vi.fn() }));
const OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];

function face(cx = 0.5, id = 'face-1'): PortraitFace {
  const landmarks = Array.from({ length: 478 }, () => ({ x: cx, y: 0.5 }));
  OVAL.forEach((index, order) => {
    const angle = order / OVAL.length * Math.PI * 2 - Math.PI / 2;
    landmarks[index] = { x: cx + 0.1 * Math.cos(angle), y: 0.5 + 0.16 * Math.sin(angle) };
  });
  for (const [index, x, y] of [[33,-0.065,-0.04],[133,-0.025,-0.04],[362,0.025,-0.04],[263,0.065,-0.04],[1,0,0],[61,-0.04,0.065],[291,0.04,0.065]]) landmarks[index] = { x: cx + x, y: 0.5 + y };
  return { id, label: id, bounds: { x: cx - 0.1, y: 0.34, width: 0.2, height: 0.32 }, landmarks, thumbnail: '' };
}

function transformed(source: PortraitFace, options: { dx?: number; dy?: number; scale?: number; rotation?: number; aspect?: number } = {}): PortraitFace {
  const { dx = 0, dy = 0, scale = 1, rotation = 0, aspect = 1 } = options;
  const center = { x: source.bounds.x + source.bounds.width / 2, y: source.bounds.y + source.bounds.height / 2 };
  const angle = rotation / 180 * Math.PI;
  const transform = (point: { x: number; y: number }) => {
    const x = (point.x - center.x) * aspect, y = point.y - center.y;
    return { x: center.x + (Math.cos(angle) * x - Math.sin(angle) * y) * scale / aspect + dx, y: center.y + (Math.sin(angle) * x + Math.cos(angle) * y) * scale + dy };
  };
  const landmarks = source.landmarks.map(transform), outline = OVAL.map(index => landmarks[index]);
  const x = Math.min(...outline.map(point => point.x)), y = Math.min(...outline.map(point => point.y));
  return { ...source, id: 'output-order-can-change', landmarks, bounds: { x, y, width: Math.max(...outline.map(point => point.x)) - x, height: Math.max(...outline.map(point => point.y)) - y } };
}

function mask(rect = [0,0,1,1], alpha = 255): ProtectionMaskPixels {
  const width = 200, height = 100, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (x / width >= rect[0] && x / width < rect[2] && y / height >= rect[1] && y / height < rect[3]) data.set([255,255,255,alpha], (y * width + x) * 4);
  }
  return { width, height, data };
}

describe('red face coverage', () => {
  it('uses alpha, including alpha=1, and never treats RGB as protection', () => {
    expect(protectedPortraitFaces([face()], mask([0,0,1,1], 1))).toHaveLength(1);
    expect(protectedPortraitFaces([face()], mask([0,0,1,1], 0))).toHaveLength(0);
  });
  it('ignores ordinary background protection and tiny isolated face marks', () => {
    expect(protectedPortraitFaces([face()], mask([0,0,0.2,0.2]))).toHaveLength(0);
    expect(protectedPortraitFaces([face()], mask([0.497,0.497,0.503,0.503]))).toHaveLength(0);
  });
  it('detects protected eyes using multiple anchors even when the face grid coverage is small', () => {
    expect(protectedPortraitFaces([face()], mask([0.42,0.45,0.58,0.47]))).toHaveLength(1);
  });
  it('only selects the sufficiently covered person in a group', () => {
    const first = face(0.25), second = face(0.75, 'face-2');
    expect(protectedPortraitFaces([first,second], mask([0.15,0.3,0.36,0.7])).map(item => item.id)).toEqual(['face-1']);
  });
  it('rejects malformed mask buffers and skips incomplete landmarks', () => {
    expect(() => protectedPortraitFaces([face()], { ...mask(), data: new Uint8ClampedArray(4) })).toThrow('像素无效');
    expect(protectedPortraitFaces([{ ...face(), landmarks: [] }], mask())).toEqual([]);
  });
});

describe('protected face geometry', () => {
  it('accepts identical geometry, independent of IDs and detection ordering', () => {
    const first = face(0.25), second = face(0.75, 'face-2');
    expect(() => assertProtectedFaceGeometry([first,second], [transformed(second),transformed(first)], 1.8)).not.toThrow();
    expect(compareFaceGeometry(first, first, 1.8)).toEqual({ displacement: 0, scale: 1, rotationDegrees: 0, residual: 0 });
  });
  it('normalizes both horizontal and vertical displacement by photo-space face width', () => {
    const source = face();
    expect(compareFaceGeometry(source, transformed(source, { dx: 0.02 }), 2).displacement).toBeCloseTo(0.1);
    expect(compareFaceGeometry(source, transformed(source, { dy: 0.04 }), 2).displacement).toBeCloseTo(0.1);
    expect(() => assertProtectedFaceGeometry([source], [transformed(source, { dx: 0.021 })], 2)).toThrow('明显偏移');
  });
  it('allows small detector jitter but blocks material scale changes', () => {
    const source = face();
    expect(() => assertProtectedFaceGeometry([source], [transformed(source, { dx: 0.002, dy: 0.001, scale: 1.02, rotation: 1, aspect: 1.8 })], 1.8)).not.toThrow();
    expect(() => assertProtectedFaceGeometry([source], [transformed(source, { scale: 1.13 })], 1)).toThrow('大小');
    expect(() => assertProtectedFaceGeometry([source], [transformed(source, { scale: 0.87 })], 1)).toThrow('大小');
  });
  it('measures rotation correctly on wide photos and rejects over six degrees', () => {
    const source = face(), result = transformed(source, { rotation: 8, aspect: 16 / 9 });
    expect(compareFaceGeometry(source, result, 16 / 9).rotationDegrees).toBeCloseTo(8);
    expect(() => assertProtectedFaceGeometry([source], [result], 16 / 9)).toThrow('角度');
  });
  it('does not reuse a single output face for multiple protected source faces', () => {
    const source = face();
    expect(() => assertProtectedFaceGeometry([source,face(0.52, 'face-2')], [source], 1)).toThrow('可靠定位');
  });
  it('rejects missing or ambiguous matches instead of silently pasting a head', () => {
    const source = face();
    expect(() => assertProtectedFaceGeometry([source], [], 1)).toThrow('头颈断层');
    expect(() => assertProtectedFaceGeometry([source], [transformed(source, { dx: 0.002 }),transformed(source, { dx: -0.002 })], 1)).toThrow('无法可靠匹配');
    expect(() => assertProtectedFaceGeometry([], [], 1)).not.toThrow();
  });
  it('rejects degenerate geometry and impossible aspect ratios', () => {
    const source = face();
    expect(() => compareFaceGeometry(source, source, 0)).toThrow('关键点无效');
    expect(() => compareFaceGeometry({ ...source, landmarks: source.landmarks.map(() => ({ x: 0.5, y: 0.5 })) }, source, 1)).toThrow('关键点不足');
  });
});

describe('local cloud-result guard', () => {
  const detected = vi.mocked(detectPortraitFaces);
  const canvas = (pixels: ProtectionMaskPixels) => ({ width: pixels.width, height: pixels.height, getContext: () => ({ getImageData: () => ({ data: pixels.data }) }) }) as unknown as HTMLCanvasElement;
  beforeEach(() => {
    detected.mockReset();
    vi.stubGlobal('Image', class { src = ''; naturalWidth = 1600; naturalHeight = 900; decode() { return Promise.resolve(); } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does not load models for missing or empty protection', async () => {
    expect(await assertProtectedFaceAlignment('source', 'result', null)).toEqual({ sourceFaces: 0, coveredFaces: 0, checkedFaces: 0 });
    await assertProtectedFaceAlignment('source', 'result', canvas(mask([0,0,1,1], 0)));
    expect(detected).not.toHaveBeenCalled();
  });
  it('does not detect output faces when only background is protected', async () => {
    detected.mockResolvedValue([face()]);
    expect(await assertProtectedFaceAlignment('source', 'result', canvas(mask([0,0,0.2,0.2])))).toEqual({ sourceFaces: 1, coveredFaces: 0, checkedFaces: 0 });
    expect(detected).toHaveBeenCalledTimes(1);
  });
  it('reports zero checked faces when the source detector finds no face', async () => {
    detected.mockResolvedValue([]);
    expect(await assertProtectedFaceAlignment('source', 'result', canvas(mask()))).toEqual({ sourceFaces: 0, coveredFaces: 0, checkedFaces: 0 });
    expect(detected).toHaveBeenCalledTimes(1);
  });
  it('compares only covered faces and exposes local progress labels', async () => {
    detected.mockResolvedValueOnce([face()]).mockResolvedValueOnce([face()]);
    const onProgress = vi.fn();
    expect(await assertProtectedFaceAlignment('source', 'result', canvas(mask()), { onProgress })).toEqual({ sourceFaces: 1, coveredFaces: 1, checkedFaces: 1 });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(detected.mock.calls).toEqual([['source'],['result']]);
  });
  it('blocks a failed source or output detector with a clear preserved-photo error', async () => {
    detected.mockRejectedValueOnce(new Error('模型加载失败'));
    await expect(assertProtectedFaceAlignment('source', 'result', canvas(mask()))).rejects.toThrow('无法完成人脸保护位置检查，已保留当前照片');
    detected.mockResolvedValueOnce([face()]).mockRejectedValueOnce(new Error('检测失败'));
    await expect(assertProtectedFaceAlignment('source', 'result', canvas(mask()))).rejects.toThrow('无法检查生成结果中的受保护人脸，已保留当前照片');
  });
  it('blocks an output with no visible protected face', async () => {
    detected.mockResolvedValueOnce([face()]).mockResolvedValueOnce([]);
    await expect(assertProtectedFaceAlignment('source', 'result', canvas(mask()))).rejects.toThrow('可靠定位');
  });
  it('cancels without waiting for a pending model and never detects the output', async () => {
    const controller = new AbortController();
    detected.mockReturnValue(new Promise(() => {}));
    const checking = assertProtectedFaceAlignment('source', 'result', canvas(mask()), { signal: controller.signal });
    controller.abort();
    await expect(checking).rejects.toMatchObject({ name: 'AbortError' });
    expect(detected).toHaveBeenCalledTimes(1);
  });
});
