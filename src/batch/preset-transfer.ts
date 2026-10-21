import { loadPortraitPresets, PRESET_STORAGE_KEY } from '../portrait/presets';
import type { PortraitPreset } from '../portrait/presets';
import { normalizePortraitSettings, PORTRAIT_FIELDS } from '../portrait/settings';
import type { PortraitSettings } from '../portrait/settings';

export const PRESET_FILE_LIMIT = 128 * 1024;
const FORMAT = 'luma-portrait-presets';
type PresetStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function exportPortraitPresetFile(presets: readonly PortraitPreset[]): string {
  return JSON.stringify({ format: FORMAT, version: 1, presets: presets.map(({ name, settings }) => ({ name, settings: normalizePortraitSettings(settings) })) }, null, 2);
}

export function parsePortraitPresetFile(text: string): Array<{ name: string; settings: PortraitSettings }> {
  if (new TextEncoder().encode(text).length > PRESET_FILE_LIMIT) throw new Error('预设文件超过 128 KiB，请选择光修导出的 JSON 预设文件。');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('预设文件不是有效的 JSON。'); }
  if (!value || typeof value !== 'object') throw new Error('预设文件格式不正确。');
  const document = value as Record<string, unknown>;
  if (document.format !== FORMAT || document.version !== 1 || !Array.isArray(document.presets)
    || !document.presets.length || document.presets.length > 20 || Object.keys(document).some(key => !['format', 'version', 'presets'].includes(key))) throw new Error('请选择光修导出的 1～20 项人像预设文件。');
  const allowed = new Set(PORTRAIT_FIELDS.map(field => field.key));
  const seen = new Set<string>();
  return document.presets.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('文件包含无效预设。');
    const preset = item as Record<string, unknown>;
    if (typeof preset.name !== 'string' || !preset.name.trim() || preset.name.trim().length > 32 || !preset.settings || typeof preset.settings !== 'object' || Array.isArray(preset.settings)
      || Object.keys(preset).some(key => !['name', 'settings'].includes(key))) throw new Error('预设名称或参数无效。');
    const settings = preset.settings as Record<string, unknown>;
    if (Object.keys(settings).some(key => !allowed.has(key as keyof PortraitSettings)) || !PORTRAIT_FIELDS.every(field => {
      const number = settings[field.key];
      // Keep the same backwards compatibility as the installed personal preset library.
      if (number === undefined) return field.key === 'dodgeBurn' || field.section !== 'natural';
      return typeof number === 'number' && Number.isFinite(number) && number >= field.min && number <= field.max;
    })) throw new Error(`“${preset.name}”包含未知或越界的人像参数。`);
    const name = preset.name.trim();
    if (seen.has(name)) throw new Error('文件包含重复名称，请检查后重新导入。');
    seen.add(name);
    return { name, settings: normalizePortraitSettings(settings as Partial<PortraitSettings>) };
  });
}

/** Import is atomic and never overwrites an existing preset with the same name. */
export function importPortraitPresetFile(text: string, storage?: PresetStorage): { presets: PortraitPreset[]; imported: number } {
  const incoming = parsePortraitPresetFile(text), target = storage ?? window.localStorage;
  const existing = loadPortraitPresets(target);
  if (existing.length + incoming.length > 20) throw new Error(`个人预设最多 20 项，目前已有 ${existing.length} 项；本次没有导入，请先整理预设。`);
  const names = new Set(existing.map(preset => preset.name));
  const additions = incoming.map(preset => {
    let name = preset.name, index = 2;
    while (names.has(name)) {
      const suffix = ` (${index++})`;
      name = `${preset.name.slice(0, 32 - suffix.length)}${suffix}`;
    }
    names.add(name);
    return { ...preset, id: crypto.randomUUID(), name };
  });
  const presets = [...existing, ...additions];
  try { target.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets)); }
  catch { throw new Error('浏览器未能保存导入预设，原预设没有改变。请检查本地存储空间。'); }
  return { presets, imported: additions.length };
}

export async function savePresetFile(text: string): Promise<{ saved: boolean; message: string }> {
  // Parse again before saving: only the public parameter schema can leave this flow.
  parsePortraitPresetFile(text);
  const name = '光修人像预设.json';
  const { Capacitor } = await import('@capacitor/core');
  if (Capacitor.isNativePlatform()) {
    const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    const file = await Filesystem.writeFile({ path: `exports/${Date.now()}-${name}`, data: text, encoding: Encoding.UTF8, directory: Directory.Cache, recursive: true });
    try { await Share.share({ title: '导出光修人像预设', files: [file.uri], dialogTitle: '保存或分享预设文件' }); }
    catch (error) {
      if (error instanceof Error && /cancel|取消/i.test(error.message)) return { saved: false, message: '已取消预设分享。' };
      throw new Error('预设文件分享失败，可复制下方预设内容保存。');
    }
    return { saved: true, message: '预设文件已交给系统分享，请选择保存位置。' };
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { saved: true, message: '已开始下载人像预设 JSON；文件不包含照片、密钥或人物信息。' };
}
