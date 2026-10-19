import type { PortraitDetailMasks } from './retouch';
import type { FaceLandmarker } from '@mediapipe/tasks-vision';

export type PortraitPoint = { x: number; y: number };
export type PortraitFace = {
  id: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  landmarks: PortraitPoint[];
  thumbnail: string;
};

// Ordered contours use MediaPipe's 478-point face mesh indices.
const OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
const LEFT_EYE = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246];
const RIGHT_EYE = [263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466];
const LEFT_BROW = [70,63,105,66,107,55,65,52,53,46];
const RIGHT_BROW = [300,293,334,296,336,285,295,282,283,276];
const LIPS = [61,146,91,181,84,17,314,405,321,375,291,409,270,269,267,0,37,39,40,185];
let detectorPromise: Promise<FaceLandmarker> | undefined;

function assetPath(name: string): string {
  return new URL(`${import.meta.env.BASE_URL}models/${name}`, document.baseURI).href;
}

async function getDetector(): Promise<FaceLandmarker> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const { FaceLandmarker } = await import('@mediapipe/tasks-vision');
      // One non-SIMD runtime supports older mobile CPUs and remains fully local.
      return FaceLandmarker.createFromOptions({
        wasmLoaderPath: assetPath('vision_wasm_nosimd_internal.js'),
        wasmBinaryPath: assetPath('vision_wasm_nosimd_internal.wasm'),
      }, {
        baseOptions: { modelAssetPath: assetPath('face_landmarker.task'), delegate: 'CPU' },
        runningMode: 'IMAGE', numFaces: 10,
        minFaceDetectionConfidence: 0.45, minFacePresenceConfidence: 0.5,
        outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false,
      });
    })().catch(() => {
      detectorPromise = undefined;
      throw new Error('本地人像模型加载失败，请刷新重试；桌面版请检查 models 资源是否完整。');
    });
  }
  return detectorPromise;
}

function readImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => image.naturalWidth && image.naturalHeight ? resolve(image) : reject(new Error('照片尺寸无效，请重新导入。'));
    image.onerror = () => reject(new Error('无法读取照片，请重新导入后再识别人像。'));
    image.src = source;
  });
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

function faceBounds(landmarks: PortraitPoint[]): PortraitFace['bounds'] {
  const outline = OVAL.map(index => landmarks[index]);
  const x = Math.min(...outline.map(point => point.x));
  const y = Math.min(...outline.map(point => point.y));
  return { x, y, width: Math.max(...outline.map(point => point.x)) - x, height: Math.max(...outline.map(point => point.y)) - y };
}

function makeThumbnail(image: HTMLImageElement, bounds: PortraitFace['bounds']): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建人像缩略图，请刷新重试。');
  const width = image.naturalWidth, height = image.naturalHeight;
  const side = Math.min(Math.max(bounds.width * width, bounds.height * height) * 1.4, width, height);
  const x = clamp((bounds.x + bounds.width / 2) * width - side / 2, 0, width - side);
  const y = clamp((bounds.y + bounds.height / 2) * height - side / 2, 0, height - side);
  context.drawImage(image, x, y, side, side, 0, 0, 96, 96);
  return canvas.toDataURL('image/jpeg', 0.82);
}

/** Local face location only: does not identify people or infer age/gender. */
export async function detectPortraitFaces(source: string): Promise<PortraitFace[]> {
  const image = await readImage(source);
  const detector = await getDetector();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持人像识别所需的画布，请更换浏览器重试。');
  const candidates: { landmarks: PortraitPoint[]; bounds: PortraitFace['bounds'] }[] = [];
  function sameFace(a: PortraitFace['bounds'], b: PortraitFace['bounds']): boolean {
    const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const union = a.width * a.height + b.width * b.height - overlap;
    const nearCenter = Math.abs(a.x + a.width / 2 - b.x - b.width / 2) < Math.min(a.width, b.width) * 0.25 &&
      Math.abs(a.y + a.height / 2 - b.y - b.height / 2) < Math.min(a.height, b.height) * 0.25;
    return overlap / union > 0.35 || nearCenter;
  }
  function detectCrop(x: number, y: number, size: number): void {
    const cropWidth = image.naturalWidth * size, cropHeight = image.naturalHeight * size;
    const scale = Math.min(1, 1600 / Math.max(cropWidth, cropHeight));
    canvas.width = Math.max(1, Math.round(cropWidth * scale));
    canvas.height = Math.max(1, Math.round(cropHeight * scale));
    context!.drawImage(image, x * image.naturalWidth, y * image.naturalHeight, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    let results: PortraitPoint[][];
    try { results = detector.detect(canvas).faceLandmarks; }
    catch { throw new Error('本地人像识别失败，请重新识别或换一张清晰的正面照片。'); }
    for (const points of results) {
      if (points.length < 468 || !points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) continue;
      const localBounds = faceBounds(points);
      // Do not treat a face cut by an interior tile boundary as a new person.
      if (size < 1 && ((x > 0 && localBounds.x < 0.005) || (y > 0 && localBounds.y < 0.005) ||
        (x + size < 0.999 && localBounds.x + localBounds.width > 0.995) ||
        (y + size < 0.999 && localBounds.y + localBounds.height > 0.995))) continue;
      const landmarks = points.map(point => ({ x: clamp(x + point.x * size), y: clamp(y + point.y * size) }));
      const bounds = faceBounds(landmarks);
      if (bounds.width <= 0 || bounds.height <= 0 || candidates.some(face => sameFace(face.bounds, bounds))) continue;
      candidates.push({ landmarks, bounds });
      if (candidates.length >= 10) break;
    }
  }
  detectCrop(0, 0, 1);
  // BlazeFace uses a small detector input. Overlapping crops retain the original
  // pixels and make distant faces in full-body/group photos large enough to see.
  if (Math.max(image.naturalWidth, image.naturalHeight) >= 900 || !candidates.length) {
    for (const y of [0, 0.4]) for (const x of [0, 0.4]) {
      if (candidates.length >= 10) break;
      await new Promise(resolve => setTimeout(resolve, 0));
      detectCrop(x, y, 0.6);
    }
  }
  if (!candidates.length) {
    for (const y of [0, 0.3, 0.6]) for (const x of [0, 0.3, 0.6]) {
      if (candidates.length >= 10) break;
      await new Promise(resolve => setTimeout(resolve, 0));
      detectCrop(x, y, 0.4);
    }
  }
  return candidates
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map((face, index) => ({ ...face, id: `face-${index + 1}`, label: `人物 ${index + 1}`, thumbnail: makeThumbnail(image, face.bounds) }));
}

function polygon(points: PortraitPoint[], indices: number[], width: number, height: number, expansion = 1): PortraitPoint[] {
  const result = indices.map(index => ({ x: points[index].x * width, y: points[index].y * height }));
  const center = result.reduce((sum, point) => ({ x: sum.x + point.x / result.length, y: sum.y + point.y / result.length }), { x: 0, y: 0 });
  return result.map(point => ({ x: center.x + (point.x - center.x) * expansion, y: center.y + (point.y - center.y) * expansion }));
}

function fillPolygon(mask: Uint8ClampedArray, width: number, height: number, points: PortraitPoint[], value: number): void {
  const minY = Math.max(0, Math.floor(Math.min(...points.map(point => point.y))));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map(point => point.y))));
  for (let y = minY; y <= maxY; y++) {
    const line = y + 0.5;
    const intersections: number[] = [];
    for (let i = 0, previous = points.length - 1; i < points.length; previous = i++) {
      const a = points[previous], b = points[i];
      if ((a.y > line) !== (b.y > line)) intersections.push(a.x + (line - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const left = Math.max(0, Math.ceil(intersections[i] - 0.5));
      const right = Math.min(width, Math.ceil(intersections[i + 1] - 0.5));
      if (left < right) mask.fill(value, y * width + left, y * width + right);
    }
  }
}

/** Face contour mask, with eye/brow/lip holes and inward-only feathering. */
export function createFaceSkinMask(face: PortraitFace, width: number, height: number): Uint8ClampedArray {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 80_000_000) throw new Error('人像蒙版尺寸无效。');
  if (face.landmarks.length < 468 || !face.landmarks.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) throw new Error('人像关键点不完整，请重新识别。');
  const mask = new Uint8ClampedArray(width * height);
  const outline = polygon(face.landmarks, OVAL, width, height);
  fillPolygon(mask, width, height, outline, 255);
  for (const indices of [LEFT_EYE, RIGHT_EYE]) fillPolygon(mask, width, height, polygon(face.landmarks, indices, width, height, 1.4), 0);
  for (const indices of [LEFT_BROW, RIGHT_BROW]) fillPolygon(mask, width, height, polygon(face.landmarks, indices, width, height, 1.5), 0);
  fillPolygon(mask, width, height, polygon(face.landmarks, LIPS, width, height, 1.2), 0);

  // Feather only inside the contour: never spread edits into hair or eye holes.
  const left = clamp(Math.floor(Math.min(...outline.map(point => point.x))) - 2, 0, width - 1);
  const top = clamp(Math.floor(Math.min(...outline.map(point => point.y))) - 2, 0, height - 1);
  const right = clamp(Math.ceil(Math.max(...outline.map(point => point.x))) + 2, 0, width - 1);
  const bottom = clamp(Math.ceil(Math.max(...outline.map(point => point.y))) + 2, 0, height - 1);
  const regionWidth = right - left + 1, regionHeight = bottom - top + 1;
  const distances = new Float32Array(regionWidth * regionHeight);
  const radius = clamp((right - left) * 0.025, 1.5, 14);
  const diagonal = Math.SQRT2;
  for (let y = 0; y < regionHeight; y++) for (let x = 0; x < regionWidth; x++) {
    const i = y * regionWidth + x;
    if (!mask[(y + top) * width + x + left]) continue;
    distances[i] = Math.min(radius,
      x ? distances[i - 1] + 1 : 1,
      y ? distances[i - regionWidth] + 1 : 1,
      x && y ? distances[i - regionWidth - 1] + diagonal : radius,
      y && x + 1 < regionWidth ? distances[i - regionWidth + 1] + diagonal : radius);
  }
  for (let y = regionHeight - 1; y >= 0; y--) for (let x = regionWidth - 1; x >= 0; x--) {
    const i = y * regionWidth + x;
    if (!distances[i]) continue;
    distances[i] = Math.min(distances[i],
      x + 1 < regionWidth ? distances[i + 1] + 1 : 1,
      y + 1 < regionHeight ? distances[i + regionWidth] + 1 : 1,
      x + 1 < regionWidth && y + 1 < regionHeight ? distances[i + regionWidth + 1] + diagonal : radius,
      x && y + 1 < regionHeight ? distances[i + regionWidth - 1] + diagonal : radius);
    mask[(y + top) * width + x + left] = Math.round(255 * distances[i] / radius);
  }
  return mask;
}


const INNER_LIPS = [78,95,88,178,87,14,317,402,318,324,308,415,310,311,312,13,82,81,80,191];

/** Inward feathering never adds pixels outside the geometric feature. */
function featherDetail(mask: Uint8ClampedArray, width: number, height: number, radius: number): void {
  let left = width, top = height, right = -1, bottom = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) {
    const x = i % width, y = Math.floor(i / width);
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < 0) return;
  left = Math.max(0, left - 1); top = Math.max(0, top - 1);
  right = Math.min(width - 1, right + 1); bottom = Math.min(height - 1, bottom + 1);
  const rw = right - left + 1, rh = bottom - top + 1;
  const distances = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const i = y * rw + x;
    if (!mask[(y + top) * width + x + left]) continue;
    distances[i] = Math.min(radius, x ? distances[i - 1] + 1 : 1, y ? distances[i - rw] + 1 : 1);
  }
  for (let y = rh - 1; y >= 0; y--) for (let x = rw - 1; x >= 0; x--) {
    const i = y * rw + x;
    if (!distances[i]) continue;
    distances[i] = Math.min(distances[i], x + 1 < rw ? distances[i + 1] + 1 : 1, y + 1 < rh ? distances[i + rw] + 1 : 1);
    mask[(y + top) * width + x + left] = Math.round(255 * distances[i] / radius);
  }
}

/**
 * Color-only feature zones from the existing face mesh. Inner-mouth geometry
 * merely limits the candidate region: retouching additionally selects bright,
 * near-neutral teeth/eye whites, so lips, tongue, pupils and irises stay intact.
 */
export function createFaceDetailMasks(face: PortraitFace, width: number, height: number): PortraitDetailMasks {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 80_000_000) throw new Error('人像蒙版尺寸无效。');
  if (face.landmarks.length < 468 || !face.landmarks.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) throw new Error('人像关键点不完整，请重新识别。');
  const details: PortraitDetailMasks = {
    underEyes: new Uint8ClampedArray(width * height), teeth: new Uint8ClampedArray(width * height),
    eyes: new Uint8ClampedArray(width * height), lips: new Uint8ClampedArray(width * height),
  };
  const points = face.landmarks;
  for (const indices of [LEFT_EYE, RIGHT_EYE]) {
    fillPolygon(details.eyes, width, height, polygon(points, indices, width, height, 0.88), 255);
    // Lower lid ordered corner-to-corner; the normal follows head tilt.
    const lower = polygon(points, indices.slice(0, 9), width, height);
    const first = lower[0], last = lower[lower.length - 1];
    const length = Math.hypot(last.x - first.x, last.y - first.y);
    if (length > 0) {
      let nx = -(last.y - first.y) / length, ny = (last.x - first.x) / length;
      if (ny < 0) { nx = -nx; ny = -ny; }
      const band = lower.slice(1, -1);
      const start = length * 0.1, depth = length * 0.4;
      fillPolygon(details.underEyes, width, height, [
        ...band.map(p => ({ x: p.x + nx * start, y: p.y + ny * start })),
        ...band.slice().reverse().map(p => ({ x: p.x + nx * depth, y: p.y + ny * depth })),
      ], 255);
    }
  }
  // The iris rings in the 478-point mesh receive an expanded hard exclusion.
  // Models with only 468 points use a conservative central-eye exclusion.
  for (const [eye, ring] of [[LEFT_EYE, [469,470,471,472]], [RIGHT_EYE, [474,475,476,477]]] as const) {
    if (points.length >= 478) {
      fillPolygon(details.eyes, width, height, polygon(points, [...ring], width, height, 1.3), 0);
    } else {
      const shape = polygon(points, [...eye], width, height);
      const cx = shape.reduce((sum, p) => sum + p.x / shape.length, 0), cy = shape.reduce((sum, p) => sum + p.y / shape.length, 0);
      const radius = (Math.max(...shape.map(p => p.y)) - Math.min(...shape.map(p => p.y))) * 0.65;
      fillPolygon(details.eyes, width, height, Array.from({ length: 16 }, (_, i) => ({ x: cx + Math.cos(i * Math.PI / 8) * radius, y: cy + Math.sin(i * Math.PI / 8) * radius })), 0);
    }
  }
  fillPolygon(details.teeth, width, height, polygon(points, INNER_LIPS, width, height, 0.9), 255);
  fillPolygon(details.lips, width, height, polygon(points, LIPS, width, height, 0.96), 255);
  fillPolygon(details.lips, width, height, polygon(points, INNER_LIPS, width, height, 1.08), 0);
  // Under-eye finishing stays on real face skin, outside the eye/brow holes.
  const skin = createFaceSkinMask(face, width, height);
  for (let i = 0; i < skin.length; i++) if (!skin[i]) details.underEyes[i] = 0;
  const radius = Math.min(5, Math.max(1, face.bounds.width * width * 0.012));
  for (const mask of Object.values(details)) featherDetail(mask, width, height, radius);
  return details;
}
