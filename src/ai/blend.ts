import type { RetouchTool } from './types';

/** Retouch/color tools can blend; generated objects must remain opaque and complete. */
export function cloudResultBlend(tool: RetouchTool, strength: number, styleCategory: 'photo' | 'art' = 'photo'): number {
  const mixes = tool === 'smooth' || tool === 'blemish' || tool === 'match' || tool === 'style' && styleCategory === 'photo';
  return mixes ? Math.max(0, Math.min(1, Number.isFinite(strength) ? strength / 100 : 0.45)) : 1;
}
