import type { NaturalRetouchSettings } from './retouch';
import { normalizePortraitSettings, PORTRAIT_FIELDS } from './settings';
import type { PortraitSettings } from './settings';

export interface PortraitPreset {
  id: string;
  name: string;
  settings: PortraitSettings;
}

export const PRESET_STORAGE_KEY = 'luma-natural-presets-v1';
type PresetStorage = Pick<Storage, 'getItem' | 'setItem'>;

function parseSettings(value: unknown): PortraitSettings | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!PORTRAIT_FIELDS.every(field => {
    const number = record[field.key];
    if (number === undefined) return field.key === 'dodgeBurn' || field.section !== 'natural';
    return typeof number === 'number' && Number.isFinite(number) && number >= field.min && number <= field.max;
  })) return null;
  return normalizePortraitSettings(record as Partial<PortraitSettings>);
}

export function loadPortraitPresets(storage?: PresetStorage): PortraitPreset[] {
  try {
    const saved: unknown = JSON.parse((storage ?? window.localStorage).getItem(PRESET_STORAGE_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    const ids = new Set<string>();
    return saved.slice(0, 20).flatMap(value => {
      if (!value || typeof value !== 'object') return [];
      const settings = parseSettings(value.settings);
      if (typeof value.id !== 'string' || !value.id || ids.has(value.id) || typeof value.name !== 'string' || !value.name.trim() || !settings) return [];
      ids.add(value.id);
      return [{ id: value.id, name: value.name.trim().slice(0, 32), settings }];
    });
  } catch { return []; }
}

function persist(presets: PortraitPreset[], storage?: PresetStorage) {
  try { (storage ?? window.localStorage).setItem(PRESET_STORAGE_KEY, JSON.stringify(presets)); }
  catch { throw new Error('浏览器未能保存个人预设，请检查本地存储是否可用。'); }
}

export function savePortraitPreset(name: string, settings: NaturalRetouchSettings | PortraitSettings, storage?: PresetStorage): PortraitPreset[] {
  const cleanName = name.trim().slice(0, 32);
  const cleanSettings = parseSettings(settings);
  if (!cleanName) throw new Error('先给个人预设起一个名字。');
  if (!cleanSettings) throw new Error('精修参数无效，请重新调整后保存。');
  const presets = loadPortraitPresets(storage);
  const existing = presets.find(preset => preset.name === cleanName);
  if (!existing && presets.length >= 20) throw new Error('最多保存 20 个个人预设，请先删除不需要的预设。');
  const next = existing
    ? presets.map(preset => preset.id === existing.id ? { ...preset, settings: cleanSettings } : preset)
    : [...presets, { id: crypto.randomUUID(), name: cleanName, settings: cleanSettings }];
  persist(next, storage);
  return next;
}

export function deletePortraitPreset(id: string, storage?: PresetStorage): PortraitPreset[] {
  const next = loadPortraitPresets(storage).filter(preset => preset.id !== id);
  persist(next, storage);
  return next;
}
