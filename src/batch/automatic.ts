import { renderAutomaticRetouch } from '../portrait/auto-render';
import { normalizePortraitSettings } from '../portrait/settings';
import type { BatchAutomaticProfile, BatchAutomaticSummary } from './automatic-types';
import type { BatchPortraitResult } from './engine';

export type AutomaticBatchResult = BatchPortraitResult & { automatic: BatchAutomaticSummary };
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('已取消本张照片的智能修图。', 'AbortError'); };

/** Exactly one shared intelligent analysis/render per immutable source photo. Editor masks never enter batch. */
export async function processAutomaticBatchPortrait(
  source: string,
  profile: BatchAutomaticProfile,
  options: { signal?: AbortSignal; onProgress?(label: string): void } = {},
): Promise<AutomaticBatchResult> {
  checkAbort(options.signal);
  const steps: string[] = [];
  const result = await renderAutomaticRetouch(source, { profile, signal: options.signal, onProgress: label => {
    checkAbort(options.signal);
    if (!steps.includes(label)) steps.push(label);
    options.onProgress?.(label);
  } });
  checkAbort(options.signal);
  const plan = result.plan;
  const automatic: BatchAutomaticSummary = {
    profile, exposure: plan.exposure, summary: plan.summary,
    subjects: plan.subjects.map((subject, index) => ({ label: subject.face.label || `人物 ${index + 1}`, settings: normalizePortraitSettings(subject.settings) })),
    steps, warnings: [...plan.warnings],
  };
  return { image: result.image, changed: result.changed, faceCount: plan.faces.length, bodyCount: 0, warnings: [...plan.warnings], automatic };
}
