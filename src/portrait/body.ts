import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import type { PortraitFace } from './detection';

export type PortraitBody = {
  id: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  /** MediaPipe's 33 normalized pose points; coordinates outside the photo are retained. */
  landmarks: Array<{ x: number; y: number; visibility?: number }>;
  /** One confidence byte per pixel, aligned with the entire source photo. */
  mask: { width: number; height: number; data: Uint8ClampedArray };
  thumbnail: string;
};

export type PortraitPerson = {
  id: string;
  label: string;
  bounds: PortraitBody['bounds'];
  thumbnail: string;
  face?: PortraitFace;
  body?: PortraitBody;
};

let detectorPromise: Promise<PoseLandmarker> | undefined;
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const confident = (point: PortraitBody['landmarks'][number] | undefined) =>
  Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y) && (point.visibility ?? 1) >= 0.5);

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已取消本次身体识别。', 'AbortError');
}

function assetPath(name: string): string {
  return new URL(`${import.meta.env.BASE_URL}models/${name}`, document.baseURI).href;
}

async function getDetector(): Promise<PoseLandmarker> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const { PoseLandmarker } = await import('@mediapipe/tasks-vision');
      return PoseLandmarker.createFromOptions({
        wasmLoaderPath: assetPath('vision_wasm_nosimd_internal.js'),
        wasmBinaryPath: assetPath('vision_wasm_nosimd_internal.wasm'),
      }, {
        baseOptions: { modelAssetPath: assetPath('pose_landmarker_lite.task'), delegate: 'CPU' },
        runningMode: 'IMAGE', numPoses: 10,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5,
        outputSegmentationMasks: true,
      });
    })().catch(() => {
      detectorPromise = undefined;
      throw new Error('本地身体模型加载失败，请刷新重试；安装版请检查 models 资源是否完整。');
    });
  }
  return detectorPromise;
}

function readImage(source: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    const cleanup = () => { image.onload = image.onerror = null; signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); image.src = ''; reject(new DOMException('已取消本次身体识别。', 'AbortError')); };
    image.onload = () => {
      cleanup();
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) {
        reject(new Error('照片尺寸无效或超过 4000 万像素，请缩小后重试。'));
      } else resolve(image);
    };
    image.onerror = () => { cleanup(); reject(new Error('无法读取照片，请重新导入后再识别身体。')); };
    signal?.addEventListener('abort', abort, { once: true });
    image.src = source;
  });
}

function makeThumbnail(image: HTMLImageElement, bounds: PortraitBody['bounds']): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建人物缩略图，请刷新重试。');
  const width = image.naturalWidth, height = image.naturalHeight;
  const side = Math.min(Math.max(bounds.width * width, bounds.height * height) * 1.1, width, height);
  const x = clamp((bounds.x + bounds.width / 2) * width - side / 2, 0, width - side);
  const y = clamp((bounds.y + bounds.height / 2) * height - side / 2, 0, height - side);
  context.drawImage(image, x, y, side, side, 0, 0, 96, 96);
  return canvas.toDataURL('image/jpeg', 0.82);
}

/** Local body location and segmentation only; never identifies a person. */
export async function detectPortraitBodies(source: string, signal?: AbortSignal): Promise<PortraitBody[]> {
  const image = await readImage(source, signal);
  checkAbort(signal);
  const detector = await getDetector();
  checkAbort(signal);
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建身体识别画布，请更换浏览器重试。');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let result: ReturnType<PoseLandmarker['detect']>;
  try { result = detector.detect(canvas); }
  catch { throw new Error('本地身体识别失败，请重试或换一张身体轮廓清晰的照片。'); }
  try {
    checkAbort(signal);
    const bodies: Omit<PortraitBody, 'id' | 'label' | 'thumbnail'>[] = [];
    for (let index = 0; index < Math.min(result.landmarks.length, 10); index++) {
      const points = result.landmarks[index], segmentation = result.segmentationMasks?.[index];
      if (points.length !== 33 || !points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) continue;
      const landmarks = points.map(point => ({ x: point.x, y: point.y,
        visibility: Number.isFinite(point.visibility) ? clamp(point.visibility) : 0 }));
      // An inferred hidden body is not a basis for a shape control. Each limb is
      // subsequently gated by its own joint confidences by the warp module.
      if ([11, 12, 23, 24].filter(i => confident(landmarks[i])).length < 2 ||
        landmarks.slice(11).filter(confident).length < 4 || !segmentation) continue;
      const { width, height } = segmentation;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 4_000_000) continue;
      const values = segmentation.getAsFloat32Array();
      if (values.length !== width * height) continue;
      const data = new Uint8ClampedArray(values.length);
      let left = width, top = height, right = -1, bottom = -1, foreground = 0;
      for (let pixel = 0; pixel < values.length; pixel++) {
        const value = Number.isFinite(values[pixel]) ? Math.round(clamp(values[pixel]) * 255) : 0;
        data[pixel] = value;
        if (value < 128) continue;
        const x = pixel % width, y = Math.floor(pixel / width);
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y); foreground++;
      }
      if (foreground < 20 || right <= left || bottom <= top) continue;
      const bounds = { x: left / width, y: top / height, width: (right - left + 1) / width, height: (bottom - top + 1) / height };
      bodies.push({ bounds, landmarks, mask: { width, height, data } });
    }
    checkAbort(signal);
    return bodies.sort((a, b) => a.bounds.x + a.bounds.width / 2 - b.bounds.x - b.bounds.width / 2)
      .map((body, index) => ({ ...body, id: `body-${index + 1}`, label: `人物 ${index + 1}`, thumbnail: makeThumbnail(image, body.bounds) }));
  } finally {
    // The synchronous API returns owned MPMask copies. Release all, including
    // discarded/invalid detections and cancellation/error paths.
    result.close();
  }
}

function unionBounds(a: PortraitBody['bounds'], b: PortraitBody['bounds']): PortraitBody['bounds'] {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Match geometric nose/eye locations, not appearance or face identity. */
export function associatePortraitPeople(faces: PortraitFace[], bodies: PortraitBody[]): PortraitPerson[] {
  const pairs: Array<{ face: number; body: number; score: number }> = [];
  faces.forEach((face, faceIndex) => bodies.forEach((body, bodyIndex) => {
    if (face.bounds.width <= 0 || face.bounds.height <= 0) return;
    const nose = body.landmarks[0];
    const eyes = [body.landmarks[2], body.landmarks[5]].filter(confident);
    const point = confident(nose) ? nose : eyes.length === 2 ? { x: (eyes[0].x + eyes[1].x) / 2, y: (eyes[0].y + eyes[1].y) / 2 } : undefined;
    if (!point) return;
    const target = confident(nose) && face.landmarks[1] ? face.landmarks[1] : {
      x: face.bounds.x + face.bounds.width / 2, y: face.bounds.y + face.bounds.height * 0.45,
    };
    const score = Math.hypot((point.x - target.x) / face.bounds.width, (point.y - target.y) / face.bounds.height);
    if (Number.isFinite(score) && score < 0.8 && point.x >= face.bounds.x - face.bounds.width * 0.3 &&
      point.x <= face.bounds.x + face.bounds.width * 1.3 && point.y >= face.bounds.y - face.bounds.height * 0.3 &&
      point.y <= face.bounds.y + face.bounds.height * 1.3) pairs.push({ face: faceIndex, body: bodyIndex, score });
  }));
  const matchedFaces = new Map<number, number>(), usedBodies = new Set<number>();
  for (const pair of pairs.sort((a, b) => a.score - b.score || a.face - b.face || a.body - b.body)) {
    if (matchedFaces.has(pair.face) || usedBodies.has(pair.body)) continue;
    matchedFaces.set(pair.face, pair.body); usedBodies.add(pair.body);
  }
  const people: PortraitPerson[] = faces.map((face, index) => {
    const match = matchedFaces.get(index), body = match === undefined ? undefined : bodies[match];
    return { id: face.id, label: face.label, thumbnail: face.thumbnail, face, body,
      bounds: body ? unionBounds(face.bounds, body.bounds) : face.bounds };
  });
  bodies.forEach((body, index) => {
    if (!usedBodies.has(index)) people.push({ id: body.id, label: body.label, bounds: body.bounds, thumbnail: body.thumbnail, body });
  });
  const orderX = (person: PortraitPerson) => {
    const bounds = person.face?.bounds ?? person.body!.bounds;
    return bounds.x + bounds.width / 2;
  };
  return people.sort((a, b) => orderX(a) - orderX(b) || a.bounds.y - b.bounds.y).slice(0, 10)
    .map((person, index) => ({ ...person, label: `人物 ${index + 1}` }));
}
