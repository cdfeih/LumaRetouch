import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Check, ScanFace, Trash2, UsersRound } from 'lucide-react';
import { detectPortraitFaces } from './detection';
import type { PortraitFace } from './detection';
import { associatePortraitPeople, detectPortraitBodies } from './body';
import type { PortraitBody, PortraitPerson } from './body';
import { renderNaturalRetouch } from './render';
import { renderPortraitWarp } from './warp-render';
import type { ShapeSettings } from './warp';
import { deletePortraitPreset, loadPortraitPresets, PRESET_STORAGE_KEY, savePortraitPreset } from './presets';
import { BODY_FIELDS, DEFAULT_PORTRAIT_SETTINGS, equalPortraitSettings, normalizePortraitSettings, PORTRAIT_FIELDS, PORTRAIT_SECTIONS, SHAPE_FIELDS, ZERO_PORTRAIT_SETTINGS } from './settings';
import type { PortraitSection, PortraitSettings } from './settings';

export interface PortraitPanelHandle { apply(): Promise<void>; cancel(): void }
interface Props {
  source: string;
  disabled: boolean;
  active: boolean;
  getMasks(): { protection: HTMLCanvasElement | null; selection: HTMLCanvasElement | null };
  onBusy(busy: boolean, label?: string): void;
  onApply(image: string): void;
  onFacesChange(people: PortraitPerson[], selected: string): void;
  onSectionChange(section: PortraitSection): void;
  notify(text: string, error?: boolean): void;
}

const ZERO_SHAPE = Object.fromEntries(SHAPE_FIELDS.map(key => [key, 0])) as ShapeSettings;
const shapeOf = (settings: PortraitSettings): ShapeSettings => Object.fromEntries(SHAPE_FIELDS.map(key => [key, settings[key]])) as ShapeSettings;
const hasBodySettings = (settings: PortraitSettings | ShapeSettings) => BODY_FIELDS.some(key => Boolean(settings[key]));
const hasShape = (settings: ShapeSettings) => SHAPE_FIELDS.some(key => Boolean(settings[key]));
const SECTION_HELP: Record<PortraitSection, string> = {
  natural: '轻柔修饰面部皮肤与局部小红点。提亮可控制自然美白程度，默认保持脸型与身材。',
  skin: '调整面部皮肤的冷暖、黄调、泛红和红润程度。眼眉、嘴唇与背景不随肤色滑块变化。',
  face: '按面部关键点轻调轮廓，固定眼眉、鼻子和嘴部形状。建议从小幅度开始；红色保护区仍保留原像素。',
  body: '按身体关键点调整腰、手臂、腿和肩宽。轮廓旁背景可能随变形移动，可用红色画笔保护门框、栏杆或其他人物。',
  details: '只修饰对应局部。牙齿和眼白仅对较亮区域提亮，不改变牙齿排列、眼睛大小、瞳孔或虹膜形状。',
};
const BODY_POINTS: Record<string, number[]> = { waistSlim: [11, 12, 23, 24], armSlim: [11, 12, 13, 14, 15, 16], legSlim: [23, 24, 25, 26, 27, 28], shoulderWidth: [11, 12] };
const fieldsForSection = (section: PortraitSection) => section === 'skin'
  ? [{ ...PORTRAIT_FIELDS.find(field => field.key === 'brightening')!, label: '美白提亮' }, ...PORTRAIT_FIELDS.filter(field => field.section === section)]
  : PORTRAIT_FIELDS.filter(field => field.section === section);

function supportsBodyField(body: PortraitBody | undefined, field: string) {
  const visible = (index: number) => {
    if (!body) return false;
    const point = body.landmarks[index];
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 && (point.visibility ?? 1) >= 0.5;
  };
  if (field === 'armSlim') return [[11, 13], [13, 15], [12, 14], [14, 16]].some(points => points.every(visible));
  if (field === 'legSlim') return [[23, 25], [25, 27], [24, 26], [26, 28]].some(points => points.every(visible));
  return Boolean(body && BODY_POINTS[field]?.every(visible));
}
function freezeCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) return null;
  const copy = document.createElement('canvas');
  copy.width = canvas.width; copy.height = canvas.height;
  copy.getContext('2d')?.drawImage(canvas, 0, 0);
  return copy;
}

export const PortraitPanel = forwardRef<PortraitPanelHandle, Props>(function PortraitPanel(props, ref) {
  const { source, disabled, active, onBusy, onApply, onFacesChange, onSectionChange, notify, getMasks } = props;
  const [section, setSection] = useState<PortraitSection>('natural');
  const [people, setPeople] = useState<PortraitPerson[]>([]);
  const [scanned, setScanned] = useState(false);
  const [bodyScanned, setBodyScanned] = useState(false);
  const [selected, setSelected] = useState('all');
  const [parameters, setParameters] = useState<Record<string, PortraitSettings>>({});
  const [common, setCommon] = useState<PortraitSettings>({ ...DEFAULT_PORTRAIT_SETTINGS });
  const [presets, setPresets] = useState(loadPortraitPresets);
  const [presetName, setPresetName] = useState('');
  const parametersRef = useRef(parameters);
  const detectedFaces = useRef<PortraitFace[] | null>(null);
  const detectedBodies = useRef<PortraitBody[] | null>(null);
  const deformationHistory = useRef<Record<string, ShapeSettings>>({});
  const baseline = useRef(source);
  const knownSources = useRef(new Set([source]));
  const job = useRef<AbortController | null>(null);
  const firstSettings = people.length ? parameters[people[0].id] : undefined;
  const referenceSettings = selected === 'all' ? firstSettings || common : parameters[selected] || common;
  const targets = selected === 'all' ? people : people.filter(person => person.id === selected);
  const mixed = selected === 'all' && people.some(person => parameters[person.id] && !equalPortraitSettings(parameters[person.id], referenceSettings));

  function storeParameters(next: Record<string, PortraitSettings>) { parametersRef.current = next; setParameters(next); }
  useEffect(() => {
    if (knownSources.current.has(source)) return;
    baseline.current = source; knownSources.current = new Set([source]);
    detectedFaces.current = null; detectedBodies.current = null; deformationHistory.current = {}; parametersRef.current = {};
    setPeople([]); setParameters({}); setScanned(false); setBodyScanned(false); setSelected('all');
    onFacesChange([], 'all');
  }, [source, onFacesChange]);
  useEffect(() => () => { job.current?.abort(); }, []);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === PRESET_STORAGE_KEY || event.key === null) setPresets(loadPortraitPresets()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  useEffect(() => { onSectionChange(section); }, [section, onSectionChange]);

  async function ensurePeople(needBody: boolean, force = false): Promise<PortraitPerson[]> {
    if (!detectedFaces.current || force) detectedFaces.current = await detectPortraitFaces(baseline.current);
    if (job.current?.signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (needBody && (!detectedBodies.current || force)) {
      onBusy(true, '正在本机识别身体关键点');
      detectedBodies.current = await detectPortraitBodies(baseline.current, job.current?.signal);
      setBodyScanned(true);
    }
    if (job.current?.signal.aborted) throw new DOMException('已取消', 'AbortError');
    const result = associatePortraitPeople(detectedFaces.current, detectedBodies.current || []);
    setPeople(result); setScanned(true);
    storeParameters(Object.fromEntries(result.map(person => [person.id, parametersRef.current[person.id] || { ...common }])));
    const nextSelected = result.some(person => person.id === selected) ? selected : 'all';
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
      const currentProfiles = selected === 'all' && people.length ? people.map(person => parametersRef.current[person.id] || common) : [parametersRef.current[selected] || common];
      const needsBody = section === 'body' || currentProfiles.some(hasBodySettings) || Object.values(deformationHistory.current).some(hasBodySettings);
      const detectedPeople = await ensurePeople(needsBody, !apply);
      if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
      if (!detectedPeople.length) { notify('没有检测到清晰的人脸或身体。请换一张主体更完整、无遮挡的照片后重试。', true); return; }
      if (!apply) { notify(`已识别 ${detectedPeople.length} 位人物${needsBody ? '，身体定位已完成' : ''}。可点缩略图单独调整。`); return; }
      const chosen = selected === 'all' ? detectedPeople : detectedPeople.filter(person => person.id === selected);
      for (const person of chosen) {
        const settings = parametersRef.current[person.id] || common;
        for (const field of BODY_FIELDS) if (settings[field] && !supportsBodyField(person.body, field)) {
          const name = PORTRAIT_FIELDS.find(item => item.key === field)!.label;
          throw new Error(`${person.label}的身体关键点不足，无法应用“${name}”。可将该项归零，或换一张主体更完整的照片。`);
        }
        if (!person.face && SHAPE_FIELDS.slice(0, 3).some(field => settings[field])) throw new Error(`${person.label}没有可见面部，无法应用面部塑形。请将面部塑形归零后继续。`);
      }
      onBusy(true, '正在修饰肤色与皮肤细节');
      const skin = await renderNaturalRetouch(baseline.current, baseline.current, chosen.flatMap(person => person.face ? [{ face: person.face, settings: parametersRef.current[person.id] || common }] : []), { signal: controller.signal });
      onBusy(true, '正在应用人像参数与保护范围');
      const chosenIds = new Set(chosen.map(person => person.id));
      const image = await renderPortraitWarp(skin, source, chosen.map(person => ({ face: person.face, body: person.body, settings: shapeOf(parametersRef.current[person.id] || common), previousSettings: deformationHistory.current[person.id] || ZERO_SHAPE })), {
        protection, selection, signal: controller.signal, blendBaseline: baseline.current,
        excludedBodies: detectedPeople.filter(person => !chosenIds.has(person.id) && person.body).map(person => person.body!),
        excludedFaces: detectedPeople.filter(person => !chosenIds.has(person.id) && person.face).map(person => person.face!),
      });
      if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
      if (image === source) { notify('没有可应用的变化。可检查参数、绿色选区或红色保护区。'); return; }
      for (const person of chosen) {
        const current = shapeOf(parametersRef.current[person.id] || common), previous = deformationHistory.current[person.id] || ZERO_SHAPE;
        deformationHistory.current[person.id] = Object.fromEntries(SHAPE_FIELDS.map(key => [key, Math.abs(current[key] || 0) > Math.abs(previous[key] || 0) ? current[key] : previous[key]])) as ShapeSettings;
      }
      knownSources.current.add(image);
      knownSources.current = new Set([baseline.current, ...Array.from(knownSources.current).filter(value => value !== baseline.current).slice(-6)]);
      onApply(image);
      const shaped = chosen.some(person => hasShape(shapeOf(parametersRef.current[person.id] || common)));
      notify(`人像精修已完成：${selected === 'all' ? `${chosen.length} 位人物` : chosen[0]?.label}。${shaped ? '已应用轮廓微调，请对比检查背景衔接。' : '已保留原有轮廓，可继续微调或撤销。'}`);
    } catch (error) {
      if (controller.signal.aborted || error instanceof DOMException && error.name === 'AbortError') notify('已取消本地人像精修，照片未改动。');
      else notify(error instanceof Error ? error.message : '本地人像处理失败，请重试。', true);
    } finally { job.current = null; onBusy(false); }
  }
  useImperativeHandle(ref, () => ({ apply: () => perform(true), cancel: () => job.current?.abort() }));

  function changeSettings(settings: Partial<PortraitSettings>) {
    if (selected === 'all') {
      setCommon(previous => ({ ...previous, ...settings }));
      storeParameters(Object.fromEntries(people.map(person => [person.id, { ...(parametersRef.current[person.id] || common), ...settings }])));
    } else storeParameters({ ...parametersRef.current, [selected]: { ...(parametersRef.current[selected] || common), ...settings } });
  }
  function savePreset() {
    try { setPresets(savePortraitPreset(presetName, referenceSettings)); setPresetName(''); notify('个人预设已保存在当前浏览器，包含肤色、塑形和细节参数。'); }
    catch (error) { notify(error instanceof Error ? error.message : '保存预设失败', true); }
  }
  function canAdjust(field: typeof PORTRAIT_FIELDS[number]) {
    if (!people.length) return field.section !== 'body';
    if (field.section === 'body') return targets.length > 0 && targets.every(person => supportsBodyField(person.body, field.key));
    return targets.some(person => person.face);
  }
  function pickSection(next: PortraitSection) { setSection(next); }
  const faceCount = targets.filter(person => person.face).length;
  const bodyCount = targets.filter(person => person.body).length;

  return <div className="portrait-panel" hidden={!active}>
    <div className="portrait-local-note"><Check size={15} /><span>本地 AI 定位 · 不需要 API Key<br /><small>自然精修默认保持轮廓；塑形与五官细节由你主动开启。</small></span></div>
    <div className="portrait-section-tabs" role="tablist" aria-label="人像精修分类">
      {PORTRAIT_SECTIONS.map(item => <button role="tab" key={item.id} data-testid={`portrait-section-${item.id}`} aria-selected={section === item.id} aria-controls={`portrait-controls-${item.id}`} disabled={disabled} className={section === item.id ? 'selected' : ''} onClick={() => pickSection(item.id)}>{item.label}</button>)}
    </div>
    <section className="property-section portrait-people">
      <div className="property-title">选择人物<span>{scanned ? `${people.length} 位人物` : '点击开始自动识别'}</span></div>
      <button className="button button-secondary full-width portrait-scan" disabled={!source || disabled} onClick={() => void perform(false)}><ScanFace size={15} />{section === 'body' ? bodyScanned ? '重新识别身体' : '识别人像与身体' : scanned ? '重新识别人像' : '识别人像'}</button>
      {people.length > 0 && <div className="portrait-person-list" role="group" aria-label="选择精修人物">
        <button className={`portrait-person portrait-all ${selected === 'all' ? 'selected' : ''}`} aria-pressed={selected === 'all'} disabled={disabled} onClick={() => { setSelected('all'); onFacesChange(people, 'all'); }}><UsersRound size={21} /><span>所有人</span></button>
        {people.map(person => <button key={person.id} data-testid={`portrait-${person.id}`} className={`portrait-person ${selected === person.id ? 'selected' : ''}`} aria-pressed={selected === person.id} disabled={disabled} onClick={() => { setSelected(person.id); onFacesChange(people, person.id); }}><img src={person.thumbnail} alt="" /><span>{person.label}</span></button>)}
      </div>}
      <p className="preset-description">{scanned && !people.length ? '暂未检测到清晰人像，可换一张主体更完整的照片。' : people.length ? `${selected === 'all' ? '当前调整所有人' : `当前只调整${people.find(person => person.id === selected)?.label}`} · 可见面部 ${faceCount}${bodyScanned ? ` · 身体 ${bodyCount}` : ''}。每个人的参数独立保存。` : '直接开始即可自然精修；合照可先识别，再点缩略图选择人物。最多识别 10 人。'}</p>
    </section>
    {PORTRAIT_SECTIONS.map(group => <section key={group.id} id={`portrait-controls-${group.id}`} className="property-section portrait-settings" role="tabpanel" aria-label={group.label} hidden={section !== group.id}>
      <div className="property-title">{group.label}<span>{group.id === 'face' || group.id === 'body' ? '默认关闭 · 轻度塑形' : '本地处理'}</span></div>
      <p className="preset-description">{SECTION_HELP[group.id]}</p>
      {mixed && <p className="portrait-mixed">各人物参数不同。这里显示第一位人物的值；调节某项会统一该项。保存预设前请选一位人物。</p>}
      {group.id === 'body' && !bodyScanned && <p className="portrait-mixed">先点“识别人像与身体”，定位腰、肩和四肢后即可调节。</p>}
      {fieldsForSection(group.id).map(field => <label className="slider-field" key={field.key}><span><span>{field.label}</span><output>{referenceSettings[field.key]}{field.min < 0 ? '' : '%'}</output></span><input type="range" aria-label={field.label} min={field.min} max={field.max} value={referenceSettings[field.key]} disabled={disabled || !canAdjust(field) && referenceSettings[field.key] === 0} onChange={event => changeSettings({ [field.key]: Number(event.target.value) })} style={{ '--range-progress': `${(referenceSettings[field.key] - field.min) / (field.max - field.min) * 100}%` } as CSSProperties} /></label>)}
      <div className="portrait-reset"><button disabled={disabled} onClick={() => changeSettings(Object.fromEntries(fieldsForSection(group.id).map(field => [field.key, DEFAULT_PORTRAIT_SETTINGS[field.key]])))}>重置本组</button><button disabled={disabled} onClick={() => changeSettings(Object.fromEntries(fieldsForSection(group.id).map(field => [field.key, 0])))}>本组归零</button></div>
    </section>)}
    <div className="portrait-reset portrait-global-reset"><button disabled={disabled} onClick={() => changeSettings({ ...DEFAULT_PORTRAIT_SETTINGS })}>恢复自然参数</button><button disabled={disabled} onClick={() => changeSettings({ ...ZERO_PORTRAIT_SETTINGS })}>全部归零</button></div>
    <p className="preset-description">“恢复自然参数”和“全部归零”会重置所选人物的全部人像参数。调整后点击开始应用，从同一底图重算，不叠加磨皮或塑形。</p>
    <section className="property-section portrait-presets">
      <div className="property-title">个人预设<span>{presets.length}/20 · 浏览器本地</span></div>
      <label className="text-field"><span>预设名称</span><input value={presetName} maxLength={32} onChange={event => setPresetName(event.target.value)} disabled={disabled || mixed} placeholder="例如：自然肤色与轻塑形" /></label>
      <button className="button button-secondary full-width" disabled={disabled || !presetName.trim() || mixed} onClick={savePreset}>保存为个人预设</button>
      <div className="portrait-preset-list">{presets.map(preset => <div className="portrait-preset" key={preset.id}><button aria-label={`应用预设 ${preset.name}`} disabled={disabled} onClick={() => { changeSettings(normalizePortraitSettings(preset.settings)); notify(`已套用“${preset.name}”参数，点击开始后生效。`); }}><span>{preset.name}</span><small>磨皮 {preset.settings.smoothing} · 提亮 {preset.settings.brightening} · 瘦脸 {preset.settings.faceSlim}</small></button><button aria-label={`删除预设 ${preset.name}`} disabled={disabled} onClick={() => { try { setPresets(deletePortraitPreset(preset.id)); notify('个人预设已删除。'); } catch (error) { notify(error instanceof Error ? error.message : '删除失败', true); } }}><Trash2 size={13} /></button></div>)}</div>
      <p className="preset-description">只保存人像参数，不保存照片、人物关键点或 API Key。旧版自然精修预设仍可使用，新增塑形默认关闭。</p>
    </section>
  </div>;
});
