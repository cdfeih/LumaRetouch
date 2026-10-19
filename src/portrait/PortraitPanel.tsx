import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Check, ScanFace, Trash2, UsersRound } from 'lucide-react';
import { detectPortraitFaces } from './detection';
import type { PortraitFace } from './detection';
import { DEFAULT_NATURAL_SETTINGS } from './retouch';
import type { NaturalRetouchSettings } from './retouch';
import { renderNaturalRetouch } from './render';
import { deletePortraitPreset, loadPortraitPresets, PRESET_STORAGE_KEY, savePortraitPreset } from './presets';

export interface PortraitPanelHandle { apply(): Promise<void>; cancel(): void }
interface Props {
  source: string;
  disabled: boolean;
  active: boolean;
  getMasks(): { protection: HTMLCanvasElement | null; selection: HTMLCanvasElement | null };
  onBusy(busy: boolean, label?: string): void;
  onApply(image: string): void;
  onFacesChange(faces: PortraitFace[], selected: string): void;
  notify(text: string, error?: boolean): void;
}

const FIELDS = [
  { key: 'smoothing', label: '轻磨皮' },
  { key: 'blemish', label: '祛痘修饰' },
  { key: 'evenness', label: '肤色均匀' },
  { key: 'brightening', label: '肤色提亮' },
  { key: 'shine', label: '去油光' },
] as const;
const ZERO: NaturalRetouchSettings = { smoothing: 0, blemish: 0, evenness: 0, brightening: 0, shine: 0 };
const equalSettings = (a: NaturalRetouchSettings, b: NaturalRetouchSettings) => FIELDS.every(({ key }) => a[key] === b[key]);

function freezeCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) return null;
  const copy = document.createElement('canvas');
  copy.width = canvas.width; copy.height = canvas.height;
  copy.getContext('2d')?.drawImage(canvas, 0, 0);
  return copy;
}

export const PortraitPanel = forwardRef<PortraitPanelHandle, Props>(function PortraitPanel(props, ref) {
  const { source, disabled, active, onBusy, onApply, onFacesChange, notify, getMasks } = props;
  const [faces, setFaces] = useState<PortraitFace[]>([]);
  const [scanned, setScanned] = useState(false);
  const [selected, setSelected] = useState('all');
  const [parameters, setParameters] = useState<Record<string, NaturalRetouchSettings>>({});
  const [common, setCommon] = useState<NaturalRetouchSettings>({ ...DEFAULT_NATURAL_SETTINGS });
  const [presets, setPresets] = useState(loadPortraitPresets);
  const [presetName, setPresetName] = useState('');
  const [applied, setApplied] = useState(false);
  const parametersRef = useRef(parameters);
  const detected = useRef<PortraitFace[] | null>(null);
  const baseline = useRef(source);
  const knownSources = useRef(new Set([source]));
  const job = useRef<AbortController | null>(null);
  const firstSettings = faces.length ? parameters[faces[0].id] : undefined;
  const referenceSettings = selected === 'all' ? firstSettings || common : parameters[selected] || common;
  const mixed = selected === 'all' && faces.some(face => parameters[face.id] && !equalSettings(parameters[face.id], referenceSettings));

  function storeParameters(next: Record<string, NaturalRetouchSettings>) { parametersRef.current = next; setParameters(next); }

  useEffect(() => {
    if (knownSources.current.has(source)) return;
    baseline.current = source;
    knownSources.current = new Set([source]);
    detected.current = null; parametersRef.current = {};
    setFaces([]); setParameters({}); setScanned(false); setSelected('all'); setApplied(false);
    onFacesChange([], 'all');
  }, [source, onFacesChange]);
  useEffect(() => () => { job.current?.abort(); }, []);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === PRESET_STORAGE_KEY || event.key === null) setPresets(loadPortraitPresets()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  async function ensureFaces(force = false) {
    if (detected.current && !force) return detected.current;
    const result = await detectPortraitFaces(baseline.current);
    if (job.current?.signal.aborted) throw new DOMException('已取消', 'AbortError');
    detected.current = result;
    setFaces(result); setScanned(true);
    storeParameters(Object.fromEntries(result.map(face => [face.id, parametersRef.current[face.id] || { ...common }])));
    const nextSelected = result.some(face => face.id === selected) ? selected : 'all';
    setSelected(nextSelected); onFacesChange(result, nextSelected);
    return result;
  }

  async function perform(apply: boolean) {
    if (!source || disabled || job.current) return;
    const controller = new AbortController(); job.current = controller;
    const masks = getMasks();
    const protection = freezeCanvas(masks.protection), selection = freezeCanvas(masks.selection);
    onBusy(true, '正在本机识别人像');
    try {
      const detectedFaces = await ensureFaces(!apply);
      if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
      if (!detectedFaces.length) { notify('没有检测到清晰的人脸。请换一张脸部更清楚的照片，或重新识别。', true); return; }
      if (!apply) { notify(`已识别 ${detectedFaces.length} 位人物。可选一位单独调节，也可处理所有人。`); return; }
      const targets = selected === 'all' ? detectedFaces : detectedFaces.filter(face => face.id === selected);
      onBusy(true, '正在自然精修，保留五官与背景');
      const image = await renderNaturalRetouch(baseline.current, source, targets.map(face => ({ face, settings: parametersRef.current[face.id] || common })), { protection, selection, signal: controller.signal });
      if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
      if (image === source) { notify('没有可应用的变化。可检查参数、绿色选区或红色保护区。'); return; }
      knownSources.current.add(image);
      knownSources.current = new Set([baseline.current, ...Array.from(knownSources.current).filter(value => value !== baseline.current).slice(-6)]);
      onApply(image); setApplied(true);
      notify(`自然精修已完成：${selected === 'all' ? `${targets.length} 位人物` : targets[0]?.label}。仅处理面部皮肤，可继续微调或撤销。`);
    } catch (error) {
      if (controller.signal.aborted || error instanceof DOMException && error.name === 'AbortError') notify('已取消本地精修，照片未改动。');
      else notify(error instanceof Error ? error.message : '本地人像处理失败，请重试。', true);
    } finally { job.current = null; onBusy(false); }
  }

  useImperativeHandle(ref, () => ({ apply: () => perform(true), cancel: () => job.current?.abort() }));

  function changeSettings(settings: NaturalRetouchSettings | Partial<NaturalRetouchSettings>) {
    setApplied(false);
    if (selected === 'all') {
      setCommon(previous => ({ ...previous, ...settings }));
      storeParameters(Object.fromEntries(faces.map(face => [face.id, { ...parametersRef.current[face.id] || common, ...settings }])));
    } else storeParameters({ ...parametersRef.current, [selected]: { ...parametersRef.current[selected] || common, ...settings } });
  }
  function savePreset() {
    try { setPresets(savePortraitPreset(presetName, referenceSettings)); setPresetName(''); notify('个人预设已保存在当前浏览器。只保存精修参数。'); }
    catch (error) { notify(error instanceof Error ? error.message : '保存预设失败', true); }
  }

  return <div className="portrait-panel" hidden={!active}>
    <div className="portrait-local-note"><Check size={15} /><span>本地 AI 定位 · 不需要 API Key<br /><small>只处理面部皮肤，保留眼眉、嘴唇与原有轮廓。</small></span></div>
    <section className="property-section portrait-people">
      <div className="property-title">选择人物<span>{scanned ? `${faces.length} 位人物` : '点击开始自动识别'}</span></div>
      <button className="button button-secondary full-width portrait-scan" disabled={!source || disabled} onClick={() => void perform(false)}><ScanFace size={15} />{scanned ? '重新识别人像' : '识别人像'}</button>
      {faces.length > 0 && <div className="portrait-person-list" role="group" aria-label="选择精修人物">
        <button className={`portrait-person portrait-all ${selected === 'all' ? 'selected' : ''}`} aria-pressed={selected === 'all'} disabled={disabled} onClick={() => { setSelected('all'); onFacesChange(faces, 'all'); }}><UsersRound size={21} /><span>所有人</span></button>
        {faces.map(face => <button key={face.id} data-testid={`portrait-${face.id}`} className={`portrait-person ${selected === face.id ? 'selected' : ''}`} aria-pressed={selected === face.id} disabled={disabled} onClick={() => { setSelected(face.id); onFacesChange(faces, face.id); }}><img src={face.thumbnail} alt="" /><span>{face.label}</span></button>)}
      </div>}
      <p className="preset-description">{scanned && !faces.length ? '暂未检测到清晰人脸。正面、无遮挡的人像通常更容易识别。' : faces.length ? selected === 'all' ? '当前调整所有人的面部皮肤。每个人的参数也可分别设置。' : `只调整${faces.find(face => face.id === selected)?.label}，其他人物保持本次处理前的像素。` : '可以直接点击下方开始精修；合照可先识别，再点缩略图选择人物。最多识别 10 人。'}</p>
    </section>
    <section className="property-section portrait-settings">
      <div className="property-title">自然精修参数<span>{applied ? '已应用' : '点击开始后应用'}</span></div>
      {mixed && <p className="portrait-mixed">各人物参数不同。下方显示第一位人物的值；调节某项会统一该项。保存预设前请选一位人物。</p>}
      {FIELDS.map(({ key, label }) => <label className="slider-field" key={key}><span><span>{label}</span><output>{referenceSettings[key]}%</output></span><input type="range" aria-label={label} min={0} max={100} value={referenceSettings[key]} disabled={disabled} onChange={event => changeSettings({ [key]: Number(event.target.value) })} style={{ '--range-progress': `${referenceSettings[key]}%` } as CSSProperties} /></label>)}
      <div className="portrait-reset"><button disabled={disabled} onClick={() => changeSettings({ ...DEFAULT_NATURAL_SETTINGS })}>恢复自然参数</button><button disabled={disabled} onClick={() => changeSettings({ ...ZERO })}>全部归零</button></div>
      <p className="preset-description">轻柔修饰皮肤纹理与局部小红点。提亮可调整美白程度。调整后点击开始应用，重复应用从同一底图计算，不叠加磨皮。</p>
    </section>
    <section className="property-section portrait-presets">
      <div className="property-title">个人预设<span>{presets.length}/20 · 浏览器本地</span></div>
      <label className="text-field"><span>预设名称</span><input value={presetName} maxLength={32} onChange={event => setPresetName(event.target.value)} disabled={disabled || mixed} placeholder="例如：我的自然肤色" /></label>
      <button className="button button-secondary full-width" disabled={disabled || !presetName.trim() || mixed} onClick={savePreset}>保存为个人预设</button>
      <div className="portrait-preset-list">{presets.map(preset => <div className="portrait-preset" key={preset.id}><button aria-label={`应用预设 ${preset.name}`} disabled={disabled} onClick={() => { changeSettings(preset.settings); notify(`已套用「${preset.name}」参数，点击开始精修后生效。`); }}><span>{preset.name}</span><small>磨皮 {preset.settings.smoothing} · 提亮 {preset.settings.brightening}</small></button><button aria-label={`删除预设 ${preset.name}`} disabled={disabled} onClick={() => { try { setPresets(deletePortraitPreset(preset.id)); notify('个人预设已删除。'); } catch (error) { notify(error instanceof Error ? error.message : '删除失败', true); } }}><Trash2 size={13} /></button></div>)}</div>
      <p className="preset-description">预设只保存皮肤参数，不保存照片、人物识别信息或 API Key。同名保存会更新参数。</p>
    </section>
  </div>;
});
