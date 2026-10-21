import { analyzePhoto } from '../imaging/analysis';
import type { PhotoAnalysis } from '../imaging/analysis';
import { createFaceContourMask, createFaceSkinMask, detectPortraitFaces } from './detection';
import type { PortraitFace } from './detection';
import { faceInRegion, planFaceWorkRegion, protectionInRegion } from './regions';
import { segmentFaceSkin, semanticCoverage } from './semantic-skin';
import { ZERO_PORTRAIT_SETTINGS } from './settings';
import type { PortraitSettings } from './settings';
import { analyzeFaceSkinPixels } from './auto-statistics';
import type { FaceSkinStatistics } from './auto-statistics';
export type { FaceSkinStatistics } from './auto-statistics';

export type AutomaticRetouchProfile = 'natural' | 'bright' | 'texture';
export interface AutomaticRetouchPlan {
  profile: AutomaticRetouchProfile; faces: PortraitFace[]; analysis: PhotoAnalysis; exposure: number;
  subjects: Array<{ face: PortraitFace; settings: PortraitSettings; statistics: FaceSkinStatistics }>;
  summary: string; warnings: string[];
}
export interface AutomaticRetouchOptions {
  profile: AutomaticRetouchProfile; protection?: HTMLCanvasElement | null; selection?: HTMLCanvasElement | null;
  signal?: AbortSignal; onProgress?: (label: string) => void;
}
export const AUTOMATIC_RETOUCH_PROFILES = [
  { id: 'natural' as const, label: '智能自然', description: '按照片亮度与每张脸的皮肤统计选择轻度参数，保留原有轮廓与肤色倾向。' },
  { id: 'bright' as const, label: '智能通透', description: '在高光允许时适度提亮，压低油光并轻柔修匀；不自动瘦脸或美白换肤色。' },
  { id: 'texture' as const, label: '智能保纹理', description: '关闭普通磨皮，保守减轻局部光影不匀与小红点。' },
];
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('已取消智能修图分析。', 'AbortError'); };
const budgets = {
  natural: { smoothing: 18, dodgeBurn: 28, blemish: 20, evenness: 18, brightening: 10, shine: 22, deRedness: 6 },
  bright: { smoothing: 20, dodgeBurn: 24, blemish: 22, evenness: 22, brightening: 20, shine: 26, deRedness: 8 },
  texture: { smoothing: 0, dodgeBurn: 35, blemish: 10, evenness: 10, brightening: 6, shine: 16, deRedness: 4 },
} as const;

/** Transparent heuristics with bounded controls, not a learned beauty score.
 * No assumed ideal skin color; uniform warmth is not treated as a defect. */
export function planFaceSettings(statistics: FaceSkinStatistics, profile: AutomaticRetouchProfile, context: { exposureEV?: number } = {}): PortraitSettings {
  if (!budgets[profile]) throw new Error('智能修图方案无效。');
  const settings = { ...ZERO_PORTRAIT_SETTINGS }, b = budgets[profile];
  if (!statistics.reliable) return settings;
  const measurements = [statistics.fineTexture, statistics.midToneUnevenness, statistics.redSpotFraction, statistics.redChromaSpread, statistics.shadowFraction, statistics.shineFraction, statistics.medianLuminance];
  if (!measurements.every(Number.isFinite)) return settings;
  settings.smoothing = Math.round(clamp((statistics.fineTexture - (profile === 'texture' ? 1.5 : .6)) * 3.2, 0, b.smoothing));
  settings.dodgeBurn = Math.round(clamp((statistics.midToneUnevenness - .8) * (profile === 'texture' ? 10 : 8), 0, b.dodgeBurn));
  settings.blemish = statistics.redSpotFraction > .0005 ? Math.round(clamp(Math.sqrt(statistics.redSpotFraction / .02) * b.blemish, 0, b.blemish)) : 0;
  settings.evenness = Math.round(clamp((statistics.redChromaSpread - 8) * .75, 0, b.evenness));
  settings.shine = statistics.shineFraction > .002 ? Math.round(clamp(Math.sqrt(statistics.shineFraction / .03) * b.shine, 0, b.shine)) : 0;
  if (statistics.redSpotFraction > .02 && statistics.redChromaSpread > 12) settings.deRedness = Math.round(clamp((statistics.redSpotFraction - .02) / .08 * b.deRedness, 0, b.deRedness));
  // A darker intrinsic skin tone is not an instruction to whiten. Natural
  // brightening requires actual deep-shadow samples, not just a low median.
  const shadowDemand = clamp((100 - statistics.medianLuminance) / 60, 0, 1) * clamp(statistics.shadowFraction / .25, 0, 1);
  const optionalLift = profile === 'bright' ? clamp((155 - statistics.medianLuminance) / 55, 0, 1) * 8 : 0;
  const alreadyLifted = Math.max(0, context.exposureEV ?? 0);
  settings.brightening = Math.round(clamp((shadowDemand * b.brightening + optionalLift) * Math.max(0, 1 - alreadyLifted / .35), 0, b.brightening));
  return settings;
}

export function planAutomaticExposure(analysis: PhotoAnalysis, profile: AutomaticRetouchProfile, constrained = false): number {
  if (!budgets[profile]) throw new Error('智能修图方案无效。');
  if (constrained || !Number.isFinite(analysis.suggestedExposure)) return 0;
  let exposure = clamp(analysis.suggestedExposure, -.3, profile === 'bright' ? .5 : profile === 'texture' ? .2 : .3);
  if (exposure > 0 && analysis.highlightClipped >= .005) exposure = 0;
  if (analysis.shadowClipped >= .98 || analysis.highlightClipped >= .98) exposure = 0;
  return Math.round(exposure * 10) / 10;
}

/** A dark/white background is not proof that correctly exposed faces need a
 * global change. No target skin color is inferred from this safety veto. */
export function refineAutomaticExposure(exposure: number, statistics: readonly FaceSkinStatistics[], profile: AutomaticRetouchProfile): { exposure: number; warning?: string } {
  const reliable = statistics.filter(item => item.reliable);
  if (!reliable.length || exposure === 0) return { exposure };
  if (exposure > 0 && reliable.some(item => item.medianLuminance >= 180 || item.highlightFraction >= .005)) return { exposure: 0, warning: '部分人脸已经较亮或接近高光裁剪，已取消自动增加整图曝光。' };
  if (exposure > 0 && profile !== 'bright' && reliable.every(item => item.medianLuminance >= 125 && item.shadowFraction < .02)) return { exposure: 0, warning: '主要人脸亮度已较充足，保留较暗背景氛围，不自动增加整图曝光。' };
  if (exposure < 0 && (reliable.every(item => item.medianLuminance < 165 && item.highlightFraction < .005) || reliable.some(item => item.medianLuminance < 75))) return { exposure: 0, warning: '较亮背景不代表人脸过曝，已取消可能压暗主体的整图曝光调整。' };
  return { exposure };
}

type FrozenMask = { width: number; height: number; data: Uint8ClampedArray };
function freezeMask(canvas?: HTMLCanvasElement | null): FrozenMask | null {
  if (!canvas || !canvas.width || !canvas.height) return null;
  if (canvas.width * canvas.height > 40_000_000) throw new Error('智能修图选区过大。');
  const context = canvas.getContext('2d'); if (!context) throw new Error('无法读取智能修图保护或编辑范围。');
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data, data = new Uint8ClampedArray(canvas.width * canvas.height);
  let nonempty = false; for (let p = 0; p < data.length; p++) { data[p] = pixels[p*4+3]; if (data[p]) nonempty = true; }
  return nonempty ? { width: canvas.width, height: canvas.height, data } : null;
}
function readImage(source: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  check(signal);
  return new Promise((resolve, reject) => {
    const image = new Image(); image.decoding = 'async';
    const cleanup = () => { image.onload = image.onerror = null; signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); image.src = ''; reject(new DOMException('已取消智能修图分析。', 'AbortError')); };
    image.onload = () => { cleanup(); if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) { image.src = ''; reject(new Error('智能修图原片尺寸无效。')); } else resolve(image); };
    image.onerror = () => { cleanup(); reject(new Error('智能修图照片解码失败。')); };
    signal?.addEventListener('abort', abort, { once: true }); image.src = source;
  });
}

/** Analyze immutable source pixels only. The caller owns rendering, edit
 * history and hard mask composition; no image-service request is performed. */
export async function planAutomaticRetouch(source: string, options: AutomaticRetouchOptions): Promise<AutomaticRetouchPlan> {
  check(options.signal); if (!budgets[options.profile]) throw new Error('智能修图方案无效。');
  const protection = freezeMask(options.protection), selection = freezeMask(options.selection);
  options.onProgress?.('正在分析整张照片的亮度与高光');
  const analysis = await analyzePhoto(source, options.signal); check(options.signal);
  let exposure = planAutomaticExposure(analysis, options.profile, Boolean(protection || selection));
  options.onProgress?.('正在本机定位人脸');
  const faces = await detectPortraitFaces(source); check(options.signal);
  const subjects: AutomaticRetouchPlan['subjects'] = [], warnings = [...analysis.warnings];
  if (protection || selection) warnings.push('已有保护区或局部选区，已关闭自动整图曝光；只规划可编辑皮肤。');
  if (!faces.length) warnings.push('未检测到可靠人脸，只提供保守整体曝光建议，不猜测人物或改变背景内容。');
  let image: HTMLImageElement | undefined;
  try {
    if (faces.length) image = await readImage(source, options.signal);
    if (image && (image.naturalWidth !== analysis.width || image.naturalHeight !== analysis.height)) throw new Error('照片方向或解码尺寸不一致，请重新导入。');
    for (let index = 0; index < faces.length; index++) {
      check(options.signal); options.onProgress?.(`正在分析${faces[index].label}的原片皮肤与局部光影`);
      const face = faces[index], region = planFaceWorkRegion(face, analysis.width, analysis.height), localFace = faceInRegion(face, analysis.width, analysis.height, region);
      const canvas = document.createElement('canvas'); canvas.width = region.workWidth; canvas.height = region.workHeight;
      try {
        const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) throw new Error('无法创建智能修图分析画布。');
        context.imageSmoothingQuality = 'high'; context.drawImage(image!, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data, geometry = createFaceSkinMask(localFace, canvas.width, canvas.height), eligible = new Uint8ClampedArray(geometry.length);
        const red = protection ? protectionInRegion(protection.data, protection.width, protection.height, analysis.width, analysis.height, region, canvas.width, canvas.height) : null;
        let candidateSamples = 0, editableSamples = 0;
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
          const p = y * canvas.width + x; if (geometry[p] < 192) continue; candidateSamples++;
          if (red?.[p] || pixels[p*4+3] < 250) continue;
          if (selection) {
            const sx = Math.min(selection.width-1, Math.max(0, Math.floor((region.x + (x+.5) * region.width / canvas.width) * selection.width / analysis.width)));
            const sy = Math.min(selection.height-1, Math.max(0, Math.floor((region.y + (y+.5) * region.height / canvas.height) * selection.height / analysis.height)));
            if (!selection.data[sy * selection.width + sx]) continue;
          }
          eligible[p] = 255; editableSamples++;
        }
        for (let otherIndex = 0; otherIndex < faces.length; otherIndex++) {
          if (otherIndex === index) continue;
          const other = faces[otherIndex].bounds, b = face.bounds;
          if (other.x >= b.x+b.width || other.x+other.width <= b.x || other.y >= b.y+b.height || other.y+other.height <= b.y) continue;
          const overlap = createFaceContourMask(faceInRegion(faces[otherIndex], analysis.width, analysis.height, region), canvas.width, canvas.height);
          for (let p = 0; p < eligible.length; p++) if (overlap[p] && eligible[p]) { eligible[p] = 0; editableSamples--; }
        }
        if (editableSamples >= 192) {
          const semantic = await segmentFaceSkin(canvas, options.signal);
          for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) if (eligible[y * canvas.width + x] && semanticCoverage(semantic, x, y, canvas.width, canvas.height) < 192) eligible[y * canvas.width + x] = 0;
        }
        check(options.signal);
        const statistics = analyzeFaceSkinPixels(pixels, canvas.width, canvas.height, eligible, { originalFaceWidth: face.bounds.width * analysis.width, originalFaceHeight: face.bounds.height * analysis.height, candidateSamples, faceWidthInSamples: localFace.bounds.width * canvas.width });
        const settings = planFaceSettings(statistics, options.profile, { exposureEV: exposure }); subjects.push({ face, settings, statistics });
        warnings.push(...statistics.warnings.map(warning => `${face.label}：${warning}`));
        if (settings.blemish > 0) warnings.push(`${face.label}的红点修饰基于局部颜色启发式，请复核妆容、痣与雀斑；不能保证全部区分。`);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      } finally { canvas.width = canvas.height = 1; }
    }
  } finally { if (image) image.src = ''; }
  check(options.signal);
  const refined = refineAutomaticExposure(exposure, subjects.map(subject => subject.statistics), options.profile);
  if (refined.warning) warnings.push(refined.warning);
  if (refined.exposure !== exposure) {
    exposure = refined.exposure;
    for (const subject of subjects) subject.settings = planFaceSettings(subject.statistics, options.profile, { exposureEV: exposure });
  }
  const label = AUTOMATIC_RETOUCH_PROFILES.find(item => item.id === options.profile)!.label;
  const people = subjects.slice(0, 3).map(subject => { const s = subject.settings; return `${subject.face.label}：磨皮${s.smoothing}、光影${s.dodgeBurn}、红点${s.blemish}、提亮${s.brightening}`; }).join('；');
  const summary = `${label} · 本地统计建议：曝光${exposure > 0 ? '+' : ''}${exposure.toFixed(1)} EV${people ? `；${people}${subjects.length > 3 ? `，共${subjects.length}位人物` : ''}` : '；未规划人像修饰'}。塑形与五官重建关闭。`;
  return { profile: options.profile, faces, analysis, exposure, subjects, summary, warnings: [...new Set(warnings)] };
}
