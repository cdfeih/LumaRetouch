import { detectPortraitFaces } from '../portrait/detection';
import type { PortraitFace } from '../portrait/detection';
import { associatePortraitPeople, detectPortraitBodies } from '../portrait/body';
import type { PortraitBody, PortraitPerson } from '../portrait/body';
import { renderNaturalRetouch } from '../portrait/render';
import { renderPortraitWarp } from '../portrait/warp-render';
import { BODY_FIELDS, normalizePortraitSettings, PORTRAIT_FIELDS, SHAPE_FIELDS } from '../portrait/settings';
import type { PortraitSettings } from '../portrait/settings';
import type { ShapeSettings } from '../portrait/warp';

export type BatchPortraitProgress = {
  stage: 'detect-face' | 'detect-body' | 'retouch' | 'shape' | 'done';
  label: string;
  /** Milestones for this photo, rather than an estimate of model execution time. */
  percent: number;
};
export type BatchPortraitOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: BatchPortraitProgress) => void;
};
export type BatchPortraitResult = {
  image: string;
  faceCount: number;
  /** Zero also means body detection was unnecessary for the selected settings. */
  bodyCount: number;
  changed: boolean;
  warnings: string[];
};

const FACE_SHAPE_FIELDS = ['faceSlim', 'jawSlim', 'chinLength'] as const;
const SHAPE_KEYS = new Set<keyof PortraitSettings>(SHAPE_FIELDS);
const FIELD_NAMES = Object.fromEntries(PORTRAIT_FIELDS.map(field => [field.key, field.label])) as Record<keyof PortraitSettings, string>;
const cancelled = () => new DOMException('已取消本张照片的批量人像精修。', 'AbortError');
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw cancelled(); };

/** Face detection has no native AbortSignal; race its promise without accepting a late result. */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(cancelled()); else resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(signal.aborted ? cancelled() : error);
    });
    if (signal.aborted) abort();
  });
}

function visiblePoint(body: PortraitBody, index: number) {
  const point = body.landmarks[index];
  return point && Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
    && Number.isFinite(point.visibility ?? 1) && (point.visibility ?? 1) >= 0.5 ? point : null;
}

function usableSegment(body: PortraitBody, a: number, b: number) {
  const start = visiblePoint(body, a), end = visiblePoint(body, b);
  return Boolean(start && end && Math.hypot(end.x - start.x, end.y - start.y) > 0.00001);
}

function supportsBodyField(body: PortraitBody | undefined, field: typeof BODY_FIELDS[number]): boolean {
  if (!body || !body.mask || body.mask.width < 1 || body.mask.height < 1
    || body.mask.data.length !== body.mask.width * body.mask.height) return false;
  if (field === 'armSlim') return [[11, 13], [13, 15], [12, 14], [14, 16]].some(([a, b]) => usableSegment(body, a, b));
  if (field === 'legSlim') return [[23, 25], [25, 27], [24, 26], [26, 28]].some(([a, b]) => usableSegment(body, a, b));
  if (!usableSegment(body, 11, 12)) return false;
  if (field === 'shoulderWidth') return true;
  const ls = visiblePoint(body, 11), rs = visiblePoint(body, 12), lh = visiblePoint(body, 23), rh = visiblePoint(body, 24);
  return Boolean(ls && rs && lh && rh && usableSegment(body, 23, 24)
    && Math.hypot((lh.x + rh.x - ls.x - rs.x) / 2, (lh.y + rh.y - ls.y - rs.y) / 2) > 0.00001);
}

function supportsFaceShape(face: PortraitFace | undefined): boolean {
  if (!face || face.landmarks.length < 468
    || !face.landmarks.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) return false;
  const left = face.landmarks[234], right = face.landmarks[454], top = face.landmarks[10], chin = face.landmarks[152];
  return Math.hypot(right.x - left.x, right.y - left.y) > 0.00001
    && Math.hypot(chin.x - top.x, chin.y - top.y) > 0.00001;
}

function validateShapes(people: PortraitPerson[], settings: PortraitSettings): void {
  for (const person of people) {
    for (const field of FACE_SHAPE_FIELDS) if (settings[field] && !supportsFaceShape(person.face)) {
      throw new Error(`${person.label}缺少完整面部关键点，无法应用“${FIELD_NAMES[field]}”。请将该项归零，或换一张面部清晰完整的照片。`);
    }
    for (const field of BODY_FIELDS) if (settings[field] && !supportsBodyField(person.body, field)) {
      throw new Error(`${person.label}的身体关键点不足，无法应用“${FIELD_NAMES[field]}”。请将该项归零，或换一张对应部位完整可见的照片。`);
    }
  }
}

/**
 * Apply one immutable preset to all detected people in one source photo. Each
 * photo has its own fixed baseline and fresh landmarks; editor masks/history
 * deliberately cannot enter this API. All operations use bundled local models.
 */
export async function processBatchPortrait(
  source: string,
  settings: PortraitSettings,
  options: BatchPortraitOptions = {},
): Promise<BatchPortraitResult> {
  const { signal, onProgress } = options;
  checkAbort(signal);
  // Snapshot before the first await so editing/deleting a preset cannot alter a running job.
  const parameters = normalizePortraitSettings(settings);
  const progress = (stage: BatchPortraitProgress['stage'], label: string, percent: number) => {
    checkAbort(signal); onProgress?.({ stage, label, percent }); checkAbort(signal);
  };
  const unchanged = (warnings: string[], faceCount = 0, bodyCount = 0): BatchPortraitResult => ({ image: source, faceCount, bodyCount, changed: false, warnings });
  if (PORTRAIT_FIELDS.every(field => parameters[field.key] === 0)) {
    progress('done', '全部参数为零，已保留原照片。', 100);
    return unchanged([]);
  }
  const needsBody = BODY_FIELDS.some(field => parameters[field] !== 0);
  const needsShape = SHAPE_FIELDS.some(field => parameters[field] !== 0);
  const needsFaceShape = FACE_SHAPE_FIELDS.some(field => parameters[field] !== 0);
  const needsFaceFinishing = PORTRAIT_FIELDS.some(field => !SHAPE_KEYS.has(field.key) && parameters[field.key] !== 0);

  progress('detect-face', '正在本机识别人脸', 0);
  const faces = await abortable(detectPortraitFaces(source), signal);
  checkAbort(signal);
  if (needsFaceShape && faces.length === 0) throw new Error('未识别到完整人脸，无法应用面部塑形。请将面部塑形归零，或换一张面部清晰完整的照片。');
  let bodies: PortraitBody[] = [];
  if (needsBody) {
    progress('detect-body', '正在本机识别身体关键点', 20);
    bodies = await abortable(detectPortraitBodies(source, signal), signal);
    checkAbort(signal);
    if (!bodies.length) throw new Error('未识别到可靠身体关键点，无法应用身体塑形。请将身体塑形归零，或换一张对应部位完整可见的照片。');
  }
  const people = associatePortraitPeople(faces, bodies);
  checkAbort(signal);
  if (!people.length) {
    progress('done', '未识别到可处理人脸，已保留原照片。', 100);
    return unchanged(['未识别到清晰人脸，本张未处理。可换用主体更大、面部无遮挡的照片。']);
  }
  // Validate every nonzero shape before either renderer starts: a group photo
  // must not quietly apply half of its preset or process only some people.
  validateShapes(people, parameters);
  const warnings: string[] = [];
  if (needsFaceFinishing && people.some(person => !person.face)) {
    warnings.push('部分人物没有可见人脸，仅处理其可用身体部位，未应用面部肤色与细节修饰。');
  }
  let image = source;
  if (needsFaceFinishing && faces.length) {
    progress('retouch', '正在本机修饰肤色与皮肤细节', needsBody ? 40 : 25);
    image = await abortable(renderNaturalRetouch(source, source,
      people.flatMap(person => person.face ? [{ face: person.face, settings: { ...parameters } }] : []), { signal }), signal);
    checkAbort(signal);
  }
  if (needsShape) {
    progress('shape', '正在本机应用面部与身体塑形', 65);
    const shape = Object.fromEntries(SHAPE_FIELDS.map(field => [field, parameters[field]])) as ShapeSettings;
    image = await abortable(renderPortraitWarp(image, source,
      people.map(person => ({ face: person.face, body: person.body, settings: { ...shape } })), { signal }), signal);
    checkAbort(signal);
    warnings.push('已应用轮廓微调，建议检查人物边缘与邻近背景。');
  }
  progress('done', image === source ? '参数未产生像素变化，已保留原照片。' : '本张本地人像精修完成', 100);
  return { image, faceCount: faces.length, bodyCount: bodies.length, changed: image !== source, warnings };
}
