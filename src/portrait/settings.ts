import { DEFAULT_NATURAL_SETTINGS } from './retouch';
import type { NaturalRetouchSettings } from './retouch';

export type PortraitSection = 'natural' | 'skin' | 'face' | 'body' | 'details';
export type PortraitSettings = NaturalRetouchSettings & {
  warmth: number; deYellow: number; deRedness: number; rosiness: number;
  darkCircles: number; teethWhitening: number; eyeWhitening: number; lipColor: number;
  faceSlim: number; jawSlim: number; chinLength: number;
  waistSlim: number; armSlim: number; legSlim: number; shoulderWidth: number;
};
export interface PortraitField { key: keyof PortraitSettings; label: string; section: PortraitSection; min: number; max: number; }
export const PORTRAIT_SECTIONS: Array<{ id: PortraitSection; label: string }> = [
  { id: 'natural', label: '一键自然精修' }, { id: 'skin', label: '肤色调整' },
  { id: 'face', label: '面部塑形' }, { id: 'body', label: '身体塑形' }, { id: 'details', label: '细节修饰' },
];
export const PORTRAIT_FIELDS: PortraitField[] = [
  { key: 'smoothing', label: '轻磨皮', section: 'natural', min: 0, max: 100 },
  { key: 'blemish', label: '祛痘修饰', section: 'natural', min: 0, max: 100 },
  { key: 'evenness', label: '肤色均匀', section: 'natural', min: 0, max: 100 },
  { key: 'brightening', label: '肤色提亮', section: 'natural', min: 0, max: 100 },
  { key: 'shine', label: '去油光', section: 'natural', min: 0, max: 100 },
  { key: 'warmth', label: '肤色冷暖', section: 'skin', min: -100, max: 100 },
  { key: 'deYellow', label: '肤色去黄', section: 'skin', min: 0, max: 100 },
  { key: 'deRedness', label: '减淡泛红', section: 'skin', min: 0, max: 100 },
  { key: 'rosiness', label: '肤色红润', section: 'skin', min: 0, max: 100 },
  { key: 'faceSlim', label: '瘦脸', section: 'face', min: 0, max: 100 },
  { key: 'jawSlim', label: '下颌收窄', section: 'face', min: 0, max: 100 },
  { key: 'chinLength', label: '下巴长短', section: 'face', min: -100, max: 100 },
  { key: 'waistSlim', label: '瘦腰', section: 'body', min: 0, max: 100 },
  { key: 'armSlim', label: '瘦手臂', section: 'body', min: 0, max: 100 },
  { key: 'legSlim', label: '瘦腿', section: 'body', min: 0, max: 100 },
  { key: 'shoulderWidth', label: '肩宽微调', section: 'body', min: -100, max: 100 },
  { key: 'darkCircles', label: '减淡黑眼圈', section: 'details', min: 0, max: 100 },
  { key: 'teethWhitening', label: '牙齿提亮', section: 'details', min: 0, max: 100 },
  { key: 'eyeWhitening', label: '眼白提亮', section: 'details', min: 0, max: 100 },
  { key: 'lipColor', label: '唇色增强', section: 'details', min: 0, max: 100 },
];
export const SHAPE_FIELDS = ['faceSlim', 'jawSlim', 'chinLength', 'waistSlim', 'armSlim', 'legSlim', 'shoulderWidth'] as const;
export const BODY_FIELDS = ['waistSlim', 'armSlim', 'legSlim', 'shoulderWidth'] as const;
export const ZERO_PORTRAIT_SETTINGS = Object.fromEntries(PORTRAIT_FIELDS.map(field => [field.key, 0])) as PortraitSettings;
export const DEFAULT_PORTRAIT_SETTINGS: PortraitSettings = { ...ZERO_PORTRAIT_SETTINGS, ...DEFAULT_NATURAL_SETTINGS };

/** Upgrade earlier five-slider presets without storing faces, landmarks or credentials. */
export function normalizePortraitSettings(value: NaturalRetouchSettings | Partial<PortraitSettings>): PortraitSettings {
  return Object.fromEntries(PORTRAIT_FIELDS.map(field => {
    const number = (value as Partial<PortraitSettings>)[field.key];
    return [field.key, typeof number === 'number' && Number.isFinite(number) ? Math.round(Math.max(field.min, Math.min(field.max, number))) : DEFAULT_PORTRAIT_SETTINGS[field.key]];
  })) as PortraitSettings;
}

export const equalPortraitSettings = (a: PortraitSettings, b: PortraitSettings) => PORTRAIT_FIELDS.every(field => a[field.key] === b[field.key]);
