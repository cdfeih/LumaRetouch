import { describe, expect, it } from 'vitest';
import { SPECIALTY_CATEGORIES, SPECIALTY_TASKS, getSpecialtyTask, suggestSpecialtyRadius } from './tasks';

describe('specialty editing task contract', () => {
  it('provides distinct selectable tasks with complete usage and review guidance', () => {
    const categories = new Set(SPECIALTY_CATEGORIES.map(item => item.id));
    expect(new Set(SPECIALTY_TASKS.map(item => item.id)).size).toBe(SPECIALTY_TASKS.length);
    for (const item of SPECIALTY_TASKS) {
      expect(categories.has(item.category)).toBe(true);
      for (const value of [item.title, item.summary, item.scopeHint, item.reviewHint, item.limitation]) expect(value.trim().length).toBeGreaterThan(3);
      expect(item.suggestedRadiusRatio).toBeGreaterThan(0);
      expect(item.suggestedRadiusRatio).toBeLessThanOrEqual(.12);
    }
  });

  it('always prepares cloud instructions with natural texture and identity-preservation requirements', () => {
    for (const item of SPECIALTY_TASKS) {
      expect(item.defaultMode).toBe('instruction');
      expect(item.prompt).toContain('只修改本次局部选区');
      expect(item.prompt).toContain('自然纹理');
      expect(item.prompt).toContain('不改变人物五官、脸型、身体轮廓');
      expect(item.prompt).toContain('手指数量和肢体姿势');
      expect(item.prompt.length).toBeLessThanOrEqual(1200);
    }
  });

  it('does not share mutable task definitions or return an unrelated task for stale selection', () => {
    const found = getSpecialtyTask('flyaway-hair');
    expect(found?.title).toBe('整理碎发');
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(SPECIALTY_TASKS)).toBe(true);
    expect(getSpecialtyTask('deleted-or-unknown-task')).toBeUndefined();
    expect(getSpecialtyTask(undefined)).toBeUndefined();
  });

  it('scales the initial radius with source resolution and ignores photo orientation', () => {
    const hand = getSpecialtyTask('hand-skin')!;
    expect(suggestSpecialtyRadius(hand, 4272, 2400)).toBe(60);
    expect(suggestSpecialtyRadius(hand, 2400, 4272)).toBe(60);
    expect(suggestSpecialtyRadius(hand, 640, 480)).toBe(12);
    expect(suggestSpecialtyRadius(getSpecialtyTask('flyaway-hair')!, 4272, 2400)).toBeLessThan(suggestSpecialtyRadius(hand, 4272, 2400));
  });

  it('keeps suggestions within the existing point-tool UI bounds for very large and tiny images', () => {
    for (const item of SPECIALTY_TASKS) {
      expect(suggestSpecialtyRadius(item, 12000, 10000)).toBeLessThanOrEqual(128);
      expect(suggestSpecialtyRadius(item, 12000, 10000)).toBeGreaterThanOrEqual(2);
      expect(suggestSpecialtyRadius(item, 8, 8)).toBe(2);
      const value = suggestSpecialtyRadius(item, 30, 24);
      expect(value).toBeGreaterThanOrEqual(2);
      expect(value).toBeLessThanOrEqual(Math.floor(.12 * 24));
    }
    expect(suggestSpecialtyRadius(getSpecialtyTask('hand-skin')!, 12000, 10000)).toBe(128);
  });

  it('returns a usable preview radius when a photo is absent or dimensions are invalid', () => {
    const item = SPECIALTY_TASKS[0];
    for (const [width, height] of [[undefined, undefined], [0, 480], [-20, 480], [640, NaN], [Infinity, 480]]) {
      expect(suggestSpecialtyRadius(item, width, height)).toBe(24);
    }
  });
});
