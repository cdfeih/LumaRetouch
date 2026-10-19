import { detectPortraitFaces, type PortraitFace, type PortraitPoint } from './detection';

export type ProtectionMaskPixels = { width: number; height: number; data: Uint8ClampedArray };
export type ProtectedFaceAlignmentReport = { sourceFaces: number; coveredFaces: number; checkedFaces: number };
export type ProtectedFaceAlignmentOptions = { signal?: AbortSignal; onProgress?: (label: string) => void };
export type FaceGeometryDifference = { displacement: number; scale: number; rotationDegrees: number; residual: number };

const OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
// Stable facial anchors avoid relying on a generated image's detector order or IDs.
const ANCHORS = [33,133,362,263,1,61,291];
const COVERAGE_ANCHORS = [...ANCHORS,10,152,234,454];
const LIMITS = { displacement: 0.10, scale: 0.12, rotationDegrees: 6, residual: 0.08 };

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已取消保护区位置检查。', 'AbortError');
}

function inPolygon(point: PortraitPoint, polygon: PortraitPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function validFace(face: PortraitFace): boolean {
  return face.bounds.width > 0 && face.bounds.height > 0 && [...OVAL,...COVERAGE_ANCHORS].every(index => {
    const point = face.landmarks[index];
    return point && Number.isFinite(point.x) && Number.isFinite(point.y);
  });
}

/** Only faces substantially touched by the red mask need output-face detection. */
export function protectedPortraitFaces(faces: PortraitFace[], mask: ProtectionMaskPixels): PortraitFace[] {
  const { width, height, data } = mask;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || data.length !== width * height * 4) throw new Error('保护区像素无效，请重新涂画保护区。');
  const covered = (point: PortraitPoint) => {
    if (point.x < 0 || point.x >= 1 || point.y < 0 || point.y >= 1) return false;
    return data[(Math.floor(point.y * height) * width + Math.floor(point.x * width)) * 4 + 3] > 0;
  };
  return faces.filter(face => {
    if (!validFace(face)) return false;
    const anchors = COVERAGE_ANCHORS.filter(index => covered(face.landmarks[index])).length;
    if (anchors >= 3) return true;
    const outline = OVAL.map(index => face.landmarks[index]);
    let samples = 0, protectedSamples = 0;
    for (let y = 0; y < 17; y++) for (let x = 0; x < 17; x++) {
      const point = { x: face.bounds.x + (x + 0.5) / 17 * face.bounds.width, y: face.bounds.y + (y + 0.5) / 17 * face.bounds.height };
      if (!inPolygon(point, outline)) continue;
      samples++;
      if (covered(point)) protectedSamples++;
    }
    return samples > 0 && protectedSamples / samples >= 0.20;
  });
}

/** Similarity fit in photo coordinates, so a wide photo does not distort angles. */
export function compareFaceGeometry(source: PortraitFace, result: PortraitFace, aspect: number): FaceGeometryDifference {
  if (!Number.isFinite(aspect) || aspect <= 0 || !validFace(source) || !validFace(result)) throw new Error('人脸关键点无效，无法检查保护区位置。');
  const points = (face: PortraitFace) => ANCHORS.map(index => ({ x: face.landmarks[index].x * aspect, y: face.landmarks[index].y }));
  const original = points(source), edited = points(result);
  const centroid = (list: PortraitPoint[]) => list.reduce((sum, point) => ({ x: sum.x + point.x / list.length, y: sum.y + point.y / list.length }), { x: 0, y: 0 });
  const a = centroid(original), b = centroid(edited);
  let dot = 0, cross = 0, norm = 0;
  for (let i = 0; i < original.length; i++) {
    const x = original[i].x - a.x, y = original[i].y - a.y;
    const u = edited[i].x - b.x, v = edited[i].y - b.y;
    dot += x * u + y * v; cross += x * v - y * u; norm += x * x + y * y;
  }
  const width = source.bounds.width * aspect;
  if (norm < 1e-12 || width < 1e-8) throw new Error('人脸关键点不足以检查保护区位置，请换用更清晰的照片。');
  const real = dot / norm, imaginary = cross / norm;
  let residualSquared = 0;
  for (let i = 0; i < original.length; i++) {
    const x = original[i].x - a.x, y = original[i].y - a.y;
    residualSquared += (edited[i].x - b.x - real * x + imaginary * y) ** 2 + (edited[i].y - b.y - imaginary * x - real * y) ** 2;
  }
  return {
    displacement: Math.hypot(b.x - a.x, b.y - a.y) / width,
    scale: Math.hypot(real, imaginary),
    rotationDegrees: Math.atan2(imaginary, real) * 180 / Math.PI,
    residual: Math.sqrt(residualSquared / original.length) / width,
  };
}

function alignmentError(reason: string): Error {
  return new Error(`模型返回的人物${reason}，直接贴回受保护的原头部可能造成头颈断层，已保留当前照片。请保留原姿势重试；添加身旁物体时可涂绿色编辑区，减少整个人物被重绘。`);
}

/** Geometry only: does not recognize identity, fix anatomy, or guarantee a seamless neck. */
export function assertProtectedFaceGeometry(protectedFaces: PortraitFace[], outputFaces: PortraitFace[], aspect: number): void {
  if (!protectedFaces.length) return;
  const available = outputFaces.filter(validFace);
  const remaining = new Set(protectedFaces.map((_, index) => index));
  const used = new Set<number>();
  const candidates = protectedFaces.flatMap((face, source) => available.map((result, output) => {
    const difference = compareFaceGeometry(face, result, aspect);
    const score = difference.displacement + Math.abs(Math.log(Math.max(1e-8, difference.scale))) + Math.abs(difference.rotationDegrees) / 90 + difference.residual * 2;
    return { source, output, difference, score };
  })).sort((a, b) => a.score - b.score);
  for (const candidate of candidates) {
    if (!remaining.has(candidate.source) || used.has(candidate.output)) continue;
    const alternatives = candidates.filter(other => other.source === candidate.source && other.output !== candidate.output && !used.has(other.output));
    if (alternatives.some(other => other.score - candidate.score < 0.08)) throw alignmentError('位置无法可靠匹配');
    const difference = candidate.difference;
    if (difference.displacement > LIMITS.displacement + 1e-8) throw alignmentError('头部位置发生了明显偏移');
    if (Math.abs(difference.scale - 1) > LIMITS.scale + 1e-8) throw alignmentError('头部大小发生了明显变化');
    if (Math.abs(difference.rotationDegrees) > LIMITS.rotationDegrees + 1e-8) throw alignmentError('头部角度发生了明显变化');
    if (difference.residual > LIMITS.residual + 1e-8) throw alignmentError('五官位置发生了明显变化');
    remaining.delete(candidate.source); used.add(candidate.output);
  }
  if (remaining.size) throw alignmentError('头部未能在结果中可靠定位');
}

async function cancellable<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  aborted(signal);
  if (!signal) return task;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new DOMException('已取消保护区位置检查。', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    task.then(value => { aborted(signal); resolve(value); }, reject).catch(reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

async function sourceSize(source: string, signal?: AbortSignal): Promise<{ width: number; height: number }> {
  const image = new Image();
  image.src = source;
  try {
    await cancellable(image.decode(), signal);
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('照片尺寸无效。');
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally { image.src = ''; }
}

/** Run before protected pixels are composited into the cloud result. All detection stays local. */
export async function assertProtectedFaceAlignment(source: string, result: string, protection: HTMLCanvasElement | null, options: ProtectedFaceAlignmentOptions = {}): Promise<ProtectedFaceAlignmentReport> {
  aborted(options.signal);
  const empty = { sourceFaces: 0, coveredFaces: 0, checkedFaces: 0 };
  if (!protection || !protection.width || !protection.height) return empty;
  const context = protection.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法读取保护区，已保留当前照片。请刷新后重新涂画。');
  const mask = { width: protection.width, height: protection.height, data: context.getImageData(0, 0, protection.width, protection.height).data };
  if (!mask.data.some((value, index) => index % 4 === 3 && value > 0)) return empty;
  options.onProgress?.('正在本地检查保护人像的位置');
  let faces: PortraitFace[];
  try { faces = await cancellable(detectPortraitFaces(source), options.signal); }
  catch (error) {
    aborted(options.signal);
    throw new Error(`无法完成人脸保护位置检查，已保留当前照片。${error instanceof Error ? error.message : '请刷新后重试。'}`);
  }
  aborted(options.signal);
  const covered = protectedPortraitFaces(faces, mask);
  const report = { sourceFaces: faces.length, coveredFaces: covered.length, checkedFaces: 0 };
  // No detected and sufficiently protected face means no claim of face safety.
  // Background-only protection continues without making output detection mandatory.
  if (!covered.length) return report;
  const size = await sourceSize(source, options.signal);
  options.onProgress?.('正在检查生成结果是否移动受保护的头部');
  let outputFaces: PortraitFace[];
  try { outputFaces = await cancellable(detectPortraitFaces(result), options.signal); }
  catch (error) {
    aborted(options.signal);
    throw new Error(`无法检查生成结果中的受保护人脸，已保留当前照片。${error instanceof Error ? error.message : '请换用更清晰的结果重试。'}`);
  }
  aborted(options.signal);
  assertProtectedFaceGeometry(covered, outputFaces, size.width / size.height);
  return { ...report, checkedFaces: covered.length };
}
