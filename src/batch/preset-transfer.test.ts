import { describe, expect, it } from 'vitest';
import { exportPortraitPresetFile, importPortraitPresetFile, parsePortraitPresetFile } from './preset-transfer';
import { ZERO_PORTRAIT_SETTINGS } from '../portrait/settings';
const preset = (name = '自然') => ({ id: 'local-id', name, settings: { ...ZERO_PORTRAIT_SETTINGS, smoothing: 18 } });
function store(initial = '') { let data = initial; return { getItem: () => data, setItem: (_key: string, value: string) => { data = value; } }; }
describe('portable personal portrait presets', () => {
  it('exports only named normalized parameters and can import its own format', () => {
    const text = exportPortraitPresetFile([preset()]);
    expect(text).not.toContain('local-id');
    expect(parsePortraitPresetFile(text)[0]).toEqual({ name: '自然', settings: preset().settings });
    expect(importPortraitPresetFile(text, store()).imported).toBe(1);
  });
  it('renames collisions rather than overwriting existing settings', () => {
    const storage = store(JSON.stringify([preset(), { ...preset('自然 (2)'), id: 'second' }]));
    const result = importPortraitPresetFile(exportPortraitPresetFile([preset()]), storage);
    expect(result.presets.map(value => value.name)).toEqual(['自然', '自然 (2)', '自然 (3)']);
    expect(result.presets[0]).toEqual(preset());
  });
  it('rejects invalid schemas, out-of-range fields, injected keys, duplicate names and oversized files atomically', () => {
    const valid = JSON.parse(exportPortraitPresetFile([preset()]));
    for (const invalid of [null, [], { ...valid, version: 2 }, { ...valid, apiKey: 'secret' }, { ...valid, presets: [] }, { ...valid, presets: [valid.presets[0], valid.presets[0]] },
      { ...valid, presets: [{ name: 'x', settings: { ...preset().settings, smoothing: 101 } }] },
      { ...valid, presets: [{ name: 'x', settings: { ...preset().settings, apiKey: 'secret' } }] }]) {
      const storage = store(JSON.stringify([preset()]));
      expect(() => importPortraitPresetFile(JSON.stringify(invalid), storage)).toThrow();
      expect(JSON.parse(storage.getItem())).toEqual([preset()]);
    }
    expect(() => parsePortraitPresetFile(' '.repeat(128 * 1024 + 1))).toThrow('128 KiB');
  });
  it('rejects an entire import above capacity and surfaces a failed write', () => {
    const storage = store(JSON.stringify(Array.from({ length: 20 }, (_, index) => ({ ...preset(`预设${index}`), id: `${index}` }))));
    expect(() => importPortraitPresetFile(exportPortraitPresetFile([preset()]), storage)).toThrow('没有导入');
    expect(JSON.parse(storage.getItem())).toHaveLength(20);
    expect(() => importPortraitPresetFile(exportPortraitPresetFile([preset()]), { getItem: () => null, setItem: () => { throw new Error('quota'); } })).toThrow('原预设没有改变');
  });
});
