import { describe, expect, it } from 'vitest';
import { deletePortraitPreset, loadPortraitPresets, PRESET_STORAGE_KEY, savePortraitPreset } from './presets';
import type { NaturalRetouchSettings } from './retouch';

const settings: NaturalRetouchSettings = { smoothing: 30, blemish: 35, evenness: 20, brightening: 10, shine: 0 };
function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('个人精修预设', () => {
  it('重新加载恢复参数，保存白名单中不包含照片、人物或密钥', () => {
    const storage = memoryStorage();
    const preset = savePortraitPreset(' 我的自然肤色 ', { ...settings, apiKey: 'do-not-store', photo: 'private-photo' } as NaturalRetouchSettings, storage)[0];
    expect(loadPortraitPresets(storage)).toEqual([{ ...preset, name: '我的自然肤色', settings }]);
    expect(storage.getItem(PRESET_STORAGE_KEY)).not.toContain('do-not-store');
    expect(storage.getItem(PRESET_STORAGE_KEY)).not.toContain('private-photo');
  });
  it('同名保存更新原预设，删除后刷新不再恢复', () => {
    const storage = memoryStorage();
    const first = savePortraitPreset('自然', settings, storage)[0];
    expect(savePortraitPreset('自然', { ...settings, brightening: 40 }, storage)).toEqual([{ ...first, settings: { ...settings, brightening: 40 } }]);
    expect(deletePortraitPreset(first.id, storage)).toEqual([]);
    expect(loadPortraitPresets(storage)).toEqual([]);
  });
  it('丢弃损坏、越界和重复记录，允许以后重新保存', () => {
    const storage = memoryStorage();
    storage.setItem(PRESET_STORAGE_KEY, JSON.stringify([{ id: 'valid', name: '可用', settings }, { id: 'valid', name: '重复', settings }, { id: 'bad', name: '越界', settings: { ...settings, smoothing: 999 } }, null]));
    expect(loadPortraitPresets(storage).map(preset => preset.name)).toEqual(['可用']);
    storage.setItem(PRESET_STORAGE_KEY, '{bad');
    expect(loadPortraitPresets(storage)).toEqual([]);
    expect(savePortraitPreset('新的', settings, storage)).toHaveLength(1);
  });
  it('输入无效或写入失败时报告错误，不虚报保存成功', () => {
    const storage = memoryStorage();
    expect(() => savePortraitPreset(' ', settings, storage)).toThrow('名字');
    expect(() => savePortraitPreset('坏参数', { ...settings, shine: NaN }, storage)).toThrow('参数无效');
    storage.setItem = () => { throw new Error('QuotaExceededError'); };
    expect(() => savePortraitPreset('失败', settings, storage)).toThrow('未能保存');
    expect(() => deletePortraitPreset('id', storage)).toThrow('未能保存');
  });
});
