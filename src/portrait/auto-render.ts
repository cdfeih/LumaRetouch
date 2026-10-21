import { applyAdjustments, composeEdit } from '../imaging';
import { DEFAULT_ADJUSTMENTS } from '../imaging/pixels';
import { renderNaturalRetouch } from './render';
import { renderPortraitWarp } from './warp-render';
import { SHAPE_FIELDS } from './settings';
import type { ShapeSettings } from './warp';
import { planAutomaticRetouch } from './auto-retouch';
import type { AutomaticRetouchPlan, AutomaticRetouchProfile } from './auto-retouch';
import { hasMaskSelection } from '../imaging/pixels';

export interface AutomaticRetouchOptions {
  profile: AutomaticRetouchProfile;
  protection?: HTMLCanvasElement | null;
  selection?: HTMLCanvasElement | null;
  signal?: AbortSignal;
  onProgress?(label: string): void;
}
export interface AutomaticRetouchResult {
  image: string;
  /** Exposure-adjusted fixed baseline for subsequent manual skin changes. */
  skinBaseline: string;
  plan: AutomaticRetouchPlan;
  changed: boolean;
}
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('已取消智能修图。', 'AbortError'); };
const ZERO_SHAPE = Object.fromEntries(SHAPE_FIELDS.map(key => [key, 0])) as ShapeSettings;
function freeze(canvas?: HTMLCanvasElement | null): HTMLCanvasElement | null {
  if (!canvas) return null;
  const result = document.createElement('canvas'); result.width = canvas.width; result.height = canvas.height;
  const context = result.getContext('2d');
  if (!context) throw new Error('无法读取画笔范围，本次未修改。');
  context.drawImage(canvas, 0, 0);
  if (!hasMaskSelection(context.getImageData(0, 0, result.width, result.height).data)) { result.width = result.height = 1; return null; }
  return result;
}

/** Single and batch share the same deterministic, local, non-generative pipeline. */
export async function renderAutomaticRetouch(source: string, options: AutomaticRetouchOptions): Promise<AutomaticRetouchResult> {
  check(options.signal);
  const protection = freeze(options.protection), selection = freeze(options.selection);
  try {
    options.onProgress?.('正在分析光线与人像');
    const plan = await planAutomaticRetouch(source, { ...options, protection, selection });
    check(options.signal);
    let skinBaseline = source;
    if (plan.exposure !== 0) {
      options.onProgress?.('正在保守调整整体亮度');
      const adjusted = await applyAdjustments(source, { ...DEFAULT_ADJUSTMENTS, exposure: plan.exposure });
      check(options.signal);
      skinBaseline = selection || protection ? await composeEdit(source, adjusted, selection, 1, protection) : adjusted;
    }
    check(options.signal);
    options.onProgress?.('正在按人物修饰皮肤与光影');
    // Match the manual panel exactly: skin first, then one selection blend.
    // A shared PNG boundary also avoids alpha-edge rounding when users reapply
    // the synchronized parameters in the manual panel.
    const skin = plan.subjects.length ? await renderNaturalRetouch(skinBaseline, skinBaseline, plan.subjects, { protection, signal: options.signal }) : skinBaseline;
    const image = plan.subjects.length ? await renderPortraitWarp(skin, skinBaseline, plan.subjects.map(subject => ({ face: subject.face, settings: ZERO_SHAPE, previousSettings: ZERO_SHAPE })), { protection, selection, blendBaseline: skinBaseline, signal: options.signal }) : skinBaseline;
    check(options.signal);
    return { image, skinBaseline, plan, changed: image !== source };
  } finally {
    if (protection) protection.width = protection.height = 1;
    if (selection) selection.width = selection.height = 1;
  }
}
