import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { ArrowDownToLine, ArrowUpRight, Brush, Check, ChevronDown, CircleHelp, CloudSun, Eraser, Eye, EyeOff, Hand, ImagePlus, Images, Layers2, LoaderCircle, Maximize, Minus, Palette, Plus, Redo2, RotateCcw, ScanFace, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, SplitSquareHorizontal, Undo2, Upload, UsersRound, WandSparkles, X } from 'lucide-react';
import { DEFAULT_PROVIDERS, SKY_PRESETS, STYLE_PRESETS, buildCreativePrompt, editImage } from './ai';
import type { ProviderConfig, RetouchTool } from './ai';
import { applyAdjustments, composeEdit, createMaskPayload, createProtectionPayload, encodeExport, loadPhoto, resizeForModel } from './imaging';
import { hasMaskSelection } from './imaging/pixels';
import { exportImage, platformName, request } from './platform';

type Tool = RetouchTool;
type ProviderKind = ProviderConfig['kind'];
type AiResultReview = { source: string; raw: string; selected: string; full?: string; mode: 'selection' | 'full'; protection: HTMLCanvasElement | null };
type Document = { id: string; name: string; original: string; current: string; width: number; height: number; history: string[]; future: string[]; edits: number; aiReview?: AiResultReview };
type Adjustments = { exposure: number; contrast: number; saturation: number; temperature: number; tint: number };
const ZERO_ADJUSTMENTS: Adjustments = { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0 };
const TOOLS = [
  { id: 'smooth' as const, name: '质感磨皮', en: 'SKIN RETOUCH', icon: ScanFace, description: '柔化皮肤瑕疵，尽量保留毛孔与自然纹理。', tip: '保留五官、脸型、肤色与原有光影。' },
  { id: 'blemish' as const, name: '智能祛痘', en: 'BLEMISH REMOVAL', icon: Sparkles, description: '清理痘痘与临时瑕疵，保留皮肤真实细节。', tip: '默认保留痣、雀斑及人物辨识特征。' },
  { id: 'remove' as const, name: '涂抹去物', en: 'OBJECT REMOVAL', icon: Eraser, description: '涂过不需要的物体，让 AI 补全背景。', tip: '覆盖完整物体并留少量边缘，通常更容易衔接自然。' },
  { id: 'sky' as const, name: '智能换天', en: 'SKY REPLACEMENT', icon: CloudSun, description: '选择天气，让模型识别天空并协调边缘、光线与倒影。', tip: '可以整图识别天空；需要严格保护其他区域时，请先涂选天空。' },
  { id: 'people' as const, name: '去路人', en: 'REMOVE DISTRACTIONS', icon: UsersRound, description: '让模型清理背景路人，保留前景主体与原有场景。', tip: '多人合照建议手动涂选要移除的人，避免误改需要保留的人物。' },
  { id: 'add' as const, name: '添加内容', en: 'GENERATIVE FILL', icon: ImagePlus, description: '涂选一个位置，描述要添加的内容，让 AI 融合光影与透视。', tip: '涂选范围要覆盖完整物体和阴影。添加大动物时，请留出头、耳朵、身体、四肢及尾巴的空间。' },
  { id: 'style' as const, name: '一键风格', en: 'LOOKS & ART', icon: Palette, description: '选择摄影调色或艺术重绘，让同一张照片呈现不同气质。', tip: '摄影预设尽量保留真实细节；艺术预设会重绘材质与笔触。' },
  { id: 'match' as const, name: '参考图追色', en: 'REFERENCE COLOR', icon: Images, description: '上传喜欢的样片，让模型参考它的色调、对比与光影氛围。', tip: '参考图只提供色彩与影调方向，不复制其中的人物和构图。' },
];

function loadConfigs(): Record<ProviderKind, ProviderConfig> {
  const result = Object.fromEntries(Object.entries(DEFAULT_PROVIDERS).map(([kind, value]) => [kind, { kind, baseUrl: value.baseUrl, model: value.model, apiKey: '' }])) as Record<ProviderKind, ProviderConfig>;
  try {
    const saved = JSON.parse(localStorage.getItem('luma-provider-settings') || '{}') as Record<string, { baseUrl?: unknown; model?: unknown }>;
    for (const kind of Object.keys(result) as ProviderKind[]) {
      if (typeof saved[kind]?.baseUrl === 'string') result[kind].baseUrl = saved[kind].baseUrl as string;
      if (typeof saved[kind]?.model === 'string') result[kind].model = saved[kind].model as string;
    }
  } catch { /* Corrupt non-secret preferences can safely fall back to defaults. */ }
  return result;
}

function Slider({ label, value, min, max, step = 1, onChange, suffix = '', disabled = false }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void; suffix?: string; disabled?: boolean }) {
  return <label className="slider-field"><span><span>{label}</span><output>{value > 0 && min < 0 ? '+' : ''}{value}{suffix}</output></span><input aria-label={label} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))} style={{ '--range-progress': `${((value - min) / (max - min)) * 100}%` } as CSSProperties} /></label>;
}

export default function App() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [activeId, setActiveId] = useState('');
  const [tool, setTool] = useState<Tool>('smooth');
  const [strength, setStrength] = useState(45);
  const [brushSize, setBrushSize] = useState(38);
  const [brushMode, setBrushMode] = useState<'paint' | 'protect' | 'erase' | 'pan'>('paint');
  const [maskTarget, setMaskTarget] = useState<'edit' | 'protect'>('edit');
  const [hasSelection, setHasSelection] = useState(false);
  const [hasProtection, setHasProtection] = useState(false);
  const [maskUndoCount, setMaskUndoCount] = useState(0);
  const [showMask, setShowMask] = useState(true);
  const [customPrompt, setCustomPrompt] = useState('');
  const [styleId, setStyleId] = useState(STYLE_PRESETS[0].id);
  const [skyId, setSkyId] = useState(SKY_PRESETS[0].id);
  const [styleCategory, setStyleCategory] = useState<'photo' | 'art'>('photo');
  const [reference, setReference] = useState<{ dataUrl: string; width: number; height: number; name: string; mimeType: string } | null>(null);
  const [configs, setConfigs] = useState(loadConfigs);
  const [providerKind, setProviderKind] = useState<ProviderKind>('openai');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<'jpeg' | 'png'>('jpeg');
  const [adjustments, setAdjustments] = useState<Adjustments>(ZERO_ADJUSTMENTS);
  const [showAdjustments, setShowAdjustments] = useState(false);
  const [compare, setCompare] = useState(false);
  const [split, setSplit] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [stageSize, setStageSize] = useState({ width: 700, height: 540 });
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const protectionRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const maskHistory = useRef<Array<{ image: ImageData; target: 'edit' | 'protect' }>>([]);
  const abortRef = useRef<AbortController | null>(null);
  const doc = documents.find(item => item.id === activeId);
  const activeTool = TOOLS.find(item => item.id === tool)!;
  const activeStyle = STYLE_PRESETS.find(item => item.id === styleId) || STYLE_PRESETS[0];
  const activeSky = SKY_PRESETS.find(item => item.id === skyId) || SKY_PRESETS[0];
  const needsSelection = tool === 'remove' || tool === 'add';
  const usesReference = (tool === 'match' || tool === 'style') && Boolean(reference);
  const provider = configs[providerKind];
  const fittedScale = doc ? Math.min((stageSize.width - 72) / doc.width, (stageSize.height - 64) / doc.height, 1) : 1;
  const displayWidth = doc ? Math.max(1, Math.round(doc.width * fittedScale * zoom)) : 0;
  const displayHeight = doc ? Math.max(1, Math.round(doc.height * fittedScale * zoom)) : 0;

  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), toast.error ? 10000 : 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    try {
      localStorage.setItem('luma-provider-settings', JSON.stringify(Object.fromEntries(Object.entries(configs).map(([kind, config]) => [kind, { baseUrl: config.baseUrl, model: config.model }]))));
    } catch { /* Preferences are optional in restricted browser contexts. */ }
  }, [configs]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(entries => setStageSize({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    const canvas = maskRef.current;
    if (!canvas || !doc) { setHasSelection(false); setHasProtection(false); return; }
    const ratio = Math.min(2048 / Math.max(doc.width, doc.height), 1);
    canvas.width = Math.round(doc.width * ratio);
    canvas.height = Math.round(doc.height * ratio);
    if (protectionRef.current) { protectionRef.current.width = canvas.width; protectionRef.current.height = canvas.height; }
    maskHistory.current = [];
    setMaskUndoCount(0);
    setHasSelection(false);
    setHasProtection(false);
    setMaskTarget('edit'); setBrushMode('paint');
    setPointer(null);
    setZoom(1);
    setCompare(false);
    setAdjustments(ZERO_ADJUSTMENTS);
  }, [activeId, doc?.width, doc?.height]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSettingsOpen(false); setExportOpen(false); }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || settingsOpen || exportOpen || busy) return;
      if (event.key.toLowerCase() === 'b') { setBrushMode('paint'); setMaskTarget('edit'); setCompare(false); }
      if (event.key.toLowerCase() === 'p') { setBrushMode('protect'); setMaskTarget('protect'); setCompare(false); }
      if (event.key.toLowerCase() === 'e') setBrushMode('erase');
      if (event.key.toLowerCase() === 'h') setBrushMode('pan');
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [settingsOpen, exportOpen, busy]);

  function clearMask() {
    const canvas = maskRef.current;
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    setHasSelection(false);
    maskHistory.current = [];
    setMaskUndoCount(0);
  }
  function clearProtection() {
    const canvas = protectionRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    setHasProtection(false); maskHistory.current = []; setMaskUndoCount(0);
  }
  function changeTool(next: Tool) {
    if (busy) return;
    if (next !== tool) { clearMask(); setCustomPrompt(''); }
    setTool(next); setCompare(false); setBrushMode('paint'); setMaskTarget('edit');
  }
  async function importReference(file: File | undefined) {
    if (!file || busy) return;
    setBusy(true); setBusyLabel('正在读取风格参考图');
    try { setReference(await loadPhoto(file)); notify('参考图已载入，只有开始风格处理时才会发送。'); }
    catch (error) { notify(error instanceof Error ? error.message : '参考图读取失败', true); }
    finally { setBusy(false); if (referenceInputRef.current) referenceInputRef.current.value = ''; }
  }
  function pushEdit(id: string, image: string, aiReview?: AiResultReview) {
    setDocuments(previous => previous.map(item => item.id === id ? { ...item, current: image, history: [...item.history, item.current].slice(-5), future: [], edits: item.edits + 1, aiReview } : item));
    setCompare(false);
    clearMask();
  }
  function undo() {
    if (!doc || busy || !doc.history.length) return;
    setDocuments(previous => previous.map(item => item.id === activeId ? { ...item, current: item.history.at(-1)!, history: item.history.slice(0, -1), future: [item.current, ...item.future].slice(0, 5), edits: Math.max(0, item.edits - 1), aiReview: undefined } : item));
    clearMask();
  }
  function redo() {
    if (!doc || busy || !doc.future.length) return;
    setDocuments(previous => previous.map(item => item.id === activeId ? { ...item, current: item.future[0], history: [...item.history, item.current].slice(-5), future: item.future.slice(1), edits: item.edits + 1, aiReview: undefined } : item));
    clearMask();
  }
  async function reviewAiResult(mode: 'selection' | 'full') {
    if (!doc?.aiReview || busy || doc.aiReview.mode === mode) return;
    const review = doc.aiReview;
    setBusy(true); setBusyLabel('正在切换本次生成结果');
    try {
      const image = mode === 'selection' ? review.selected : review.full || await composeEdit(review.source, review.raw, null, 1, review.protection);
      setDocuments(previous => previous.map(item => item.id === doc.id ? { ...item, current: image, aiReview: { ...review, mode, full: mode === 'full' ? image : review.full } } : item));
      setCompare(false); clearMask();
      notify(mode === 'full' ? review.protection ? '已显示完整画面并保留本次保护区。其他区域可能变化，不会再次调用模型。' : '已显示模型完整画面，人物与背景可能变化。切换结果不会再次调用模型。' : '已恢复选区合成，选区外保留原照片。');
    } catch (error) { notify(error instanceof Error ? error.message : '无法切换生成结果', true); }
    finally { setBusy(false); }
  }
  async function importFiles(files: FileList | File[] | null) {
    if (!files || busy) return;
    const available = Math.max(0, 10 - documents.length);
    if (!available) { notify('当前最多打开 10 张照片，请先移除不需要的照片。', true); return; }
    const list = Array.from(files).slice(0, available);
    if (files.length > available) notify(`本次先导入 ${available} 张照片，最多同时打开 10 张。`);
    setBusy(true); setBusyLabel('正在读取照片');
    const added: Document[] = [];
    const errors: string[] = [];
    for (const file of list) {
      try {
        if (file.size > 30 * 1024 * 1024) throw new Error('单张照片请控制在 30 MB 内');
        if (!/\.(jpe?g|png|webp)$/i.test(file.name)) throw new Error('第一版支持 JPEG、PNG、WebP，请先将 RAW／RW2 导出为 JPEG');
        const loaded = await loadPhoto(file);
        added.push({ id: crypto.randomUUID(), name: loaded.name, original: loaded.dataUrl, current: loaded.dataUrl, width: loaded.width, height: loaded.height, history: [], future: [], edits: 0 });
      } catch (error) { errors.push(`${file.name}：${error instanceof Error ? error.message : '读取失败'}`); }
    }
    setDocuments(previous => [...previous, ...added]);
    if (added.length) setActiveId(added[0].id);
    setBusy(false);
    if (errors.length) notify(errors.join('；'), true);
    else if (added.length) notify(`已导入 ${added.length} 张照片，原图会保留在本次会话中。`);
    if (inputRef.current) inputRef.current.value = '';
  }
  function pointOnMask(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget, rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * canvas.width, y: (event.clientY - rect.top) / rect.height * canvas.height };
  }
  function drawTo(event: ReactPointerEvent<HTMLCanvasElement>, first = false) {
    const canvas = maskTarget === 'protect' ? protectionRef.current : maskRef.current, context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const point = pointOnMask(event), previous = first ? point : lastPointRef.current || point;
    context.globalCompositeOperation = brushMode === 'erase' ? 'destination-out' : 'source-over';
    context.strokeStyle = 'white'; context.fillStyle = 'white';
    context.lineWidth = brushSize * canvas.width / event.currentTarget.getBoundingClientRect().width;
    context.lineCap = 'round'; context.lineJoin = 'round';
    context.beginPath(); context.moveTo(previous.x, previous.y); context.lineTo(point.x, point.y); context.stroke();
    if (first) { context.beginPath(); context.arc(point.x, point.y, context.lineWidth / 2, 0, Math.PI * 2); context.fill(); }
    lastPointRef.current = point;
  }
  function startDrawing(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (busy || compare || brushMode === 'pan' || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const target = maskTarget === 'protect' ? protectionRef.current : maskRef.current;
    const context = target?.getContext('2d');
    if (target && context) {
      maskHistory.current = [...maskHistory.current, { image: context.getImageData(0, 0, target.width, target.height), target: maskTarget }].slice(-4);
      setMaskUndoCount(maskHistory.current.length);
    }
    drawingRef.current = true; setShowMask(true); drawTo(event, true);
    if (maskTarget === 'protect') setHasProtection(true); else setHasSelection(true);
  }
  function moveDrawing(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (busy) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setPointer({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    if (drawingRef.current) drawTo(event);
  }
  function syncMaskSelection() {
    const canvas = maskRef.current, context = canvas?.getContext('2d');
    setHasSelection(Boolean(canvas && context && hasMaskSelection(context.getImageData(0, 0, canvas.width, canvas.height).data)));
    const protection = protectionRef.current, protectionContext = protection?.getContext('2d');
    setHasProtection(Boolean(protection && protectionContext && hasMaskSelection(protectionContext.getImageData(0, 0, protection.width, protection.height).data)));
  }
  function finishDrawing() {
    const wasDrawing = drawingRef.current;
    drawingRef.current = false; lastPointRef.current = null;
    if (wasDrawing) syncMaskSelection();
  }
  function undoMask() {
    const entry = maskHistory.current.pop();
    const canvas = entry?.target === 'protect' ? protectionRef.current : maskRef.current;
    if (entry && canvas) { canvas.getContext('2d')?.putImageData(entry.image, 0, 0); syncMaskSelection(); }
    setMaskUndoCount(maskHistory.current.length);
  }
  async function runAi() {
    if (!doc || busy) return;
    if (tool === 'remove' && !hasSelection) { notify('先用画笔涂过需要移除的物体，再开始去物。', true); return; }
    if (tool === 'add' && (!hasSelection || !customPrompt.trim())) { notify('添加内容需要先涂选位置，并描述要添加的物体。', true); return; }
    if (tool === 'match' && !reference) { notify('先上传一张喜欢的参考图，再开始追色。', true); return; }
    if (!provider.apiKey.trim() || !provider.model.trim() || !provider.baseUrl.trim()) { setSettingsOpen(true); notify('请先填写模型服务、模型名称和 API Key。'); return; }
    // Capture a stable selection for the complete job, including on multi-touch devices.
    // Upload and final composition must use the same pixels even if pointers remain captured.
    finishDrawing();
    const selectionSnapshot = maskRef.current ? document.createElement('canvas') : null;
    if (selectionSnapshot && maskRef.current) {
      selectionSnapshot.width = maskRef.current.width;
      selectionSnapshot.height = maskRef.current.height;
      selectionSnapshot.getContext('2d')?.drawImage(maskRef.current, 0, 0);
    }
    const protectionSnapshot = protectionRef.current ? document.createElement('canvas') : null;
    if (protectionSnapshot && protectionRef.current) {
      protectionSnapshot.width = protectionRef.current.width; protectionSnapshot.height = protectionRef.current.height;
      protectionSnapshot.getContext('2d')?.drawImage(protectionRef.current, 0, 0);
    }
    const snapshotHasPixels = (canvas: HTMLCanvasElement | null) => {
      const context = canvas?.getContext('2d');
      return Boolean(canvas && context && hasMaskSelection(context.getImageData(0, 0, canvas.width, canvas.height).data));
    };
    const paintedSelection = snapshotHasPixels(selectionSnapshot);
    const frozenProtection = snapshotHasPixels(protectionSnapshot) ? protectionSnapshot : null;
    const controller = new AbortController(); abortRef.current = controller;
    setBusy(true); setBusyLabel('正在准备照片');
    try {
      const image = await resizeForModel(doc.current, 2048);
      const masks = selectionSnapshot ? await createMaskPayload(selectionSnapshot, image.width, image.height, frozenProtection) : null;
      if ((needsSelection || paintedSelection) && !masks?.hasSelection) throw new Error(frozenProtection && paintedSelection ? '编辑选区已全部被保护，请在保护区外重新涂选。' : tool === 'add' ? '选区为空，请涂选添加内容的位置。' : '选区为空，请涂抹要移除的物体。');
      const selected = Boolean(masks?.hasSelection);
      const uploadMasks = selected ? masks : frozenProtection ? await createProtectionPayload(frozenProtection, image.width, image.height) : null;
      if (uploadMasks && !uploadMasks.hasSelection) throw new Error('整张照片已被保护，没有可编辑区域。');
      const referenceInput = usesReference && reference ? await resizeForModel(reference.dataUrl, 1024) : undefined;
      setBusyLabel(`正在使用 ${DEFAULT_PROVIDERS[providerKind].label} 处理`);
      const result = await editImage({ provider, imageBase64: image.base64, mimeType: image.mimeType, prompt: buildCreativePrompt({ tool, strength, customPrompt, styleId, skyId, hasSelection: Boolean(uploadMasks?.hasSelection), hasReference: Boolean(referenceInput) }), maskBase64: uploadMasks?.maskBase64, maskGuideBase64: uploadMasks?.maskGuideBase64, referenceImage: referenceInput ? { base64: referenceInput.base64, mimeType: referenceInput.mimeType } : undefined, signal: controller.signal }, request);
      if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
      setBusyLabel('正在合成修图结果');
      const rawResult = `data:${result.mimeType};base64,${result.imageBase64}`;
      const merged = await composeEdit(doc.current, rawResult, selected ? selectionSnapshot : null, 1, frozenProtection);
      if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
      pushEdit(doc.id, merged, selected && tool === 'add' ? { source: doc.current, raw: rawResult, selected: merged, mode: 'selection', protection: frozenProtection } : undefined);
      notify(frozenProtection ? 'AI 处理完成，保护区已保留本次处理前的原像素。' : selected ? 'AI 处理完成，已仅合成到涂抹区域。' : 'AI 处理完成，可开启前后对比检查细节。');
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) notify('已取消本次处理。已提交的模型请求可能仍会计费。');
      else notify(error instanceof Error ? error.message : 'AI 处理失败，请检查模型设置与网络。', true);
    } finally { setBusy(false); abortRef.current = null; }
  }
  async function applyColor() {
    if (!doc || busy) return;
    setBusy(true); setBusyLabel('正在应用本地调色');
    try { pushEdit(doc.id, await applyAdjustments(doc.current, adjustments)); setAdjustments(ZERO_ADJUSTMENTS); notify('已应用本地调色。'); }
    catch (error) { notify(error instanceof Error ? error.message : '调色失败', true); }
    finally { setBusy(false); }
  }
  async function savePhoto() {
    if (!doc || busy) return;
    setBusy(true); setBusyLabel('正在导出照片');
    try {
      const image = await encodeExport(doc.current, exportFormat, 0.95);
      const name = `${doc.name.replace(/\.[^.]+$/, '')}_光修.${exportFormat === 'jpeg' ? 'jpg' : 'png'}`;
      const saved = await exportImage(image.base64, image.mimeType, name);
      if (saved.saved) { setExportOpen(false); notify(saved.message || '照片已导出。'); }
    } catch (error) { notify(error instanceof Error ? error.message : '导出失败', true); }
    finally { setBusy(false); }
  }
  function removeDocument(id: string) {
    if (busy) return;
    const rest = documents.filter(item => item.id !== id);
    setDocuments(rest);
    if (id === activeId) setActiveId(rest[0]?.id || '');
  }
  function changeProviderField(field: 'apiKey' | 'baseUrl' | 'model', value: string) {
    setConfigs(previous => ({ ...previous, [providerKind]: { ...previous[providerKind], [field]: value } }));
  }

  return <div className="app-shell" onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); void importFiles(event.dataTransfer.files); }}>
    <input data-testid="photo-input" ref={inputRef} className="hidden-input" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => void importFiles(event.target.files)} />
    <input data-testid="reference-input" ref={referenceInputRef} className="hidden-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={event => void importReference(event.target.files?.[0])} />
    <header className="topbar">
      <a href="#" className="brand" aria-label="光修 AI 首页" onClick={event => event.preventDefault()}><img src="./mark.svg" alt="" /><span>光修<span className="brand-ai">AI</span></span><span className="brand-tag">PHOTO STUDIO</span></a>
      <div className="topbar-center"><span className="status-dot" />{platformName}<span className="topbar-version">预览版 0.2</span></div>
      <div className="topbar-actions"><button className="icon-button settings-top" aria-label="模型设置" title="模型设置" onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></button><button className="button button-quiet import-top" onClick={() => inputRef.current?.click()} disabled={busy}><ImagePlus size={16} />导入照片</button><button className="button button-primary" onClick={() => setExportOpen(true)} disabled={!doc || busy}><ArrowDownToLine size={16} />导出照片</button></div>
    </header>

    <div className="workspace">
      <aside className="tool-sidebar">
        <div className="section-caption">创作工具 <span>08 TOOLS</span></div>
        <nav className="tool-list" aria-label="精修工具">{TOOLS.map(item => <button key={item.id} data-testid={`tool-${item.id}`} className={`tool-card ${tool === item.id ? 'selected' : ''}`} disabled={busy} onClick={() => changeTool(item.id)}><span className="tool-icon"><item.icon size={21} strokeWidth={1.6} /></span><span className="tool-text"><strong>{item.name}</strong><small>{item.en}</small></span><span className="tool-chevron"><ArrowUpRight size={14} /></span></button>)}</nav>
        <div className="sidebar-divider" />
        <button className={`local-tool ${showAdjustments ? 'selected' : ''}`} onClick={() => setShowAdjustments(!showAdjustments)}><SlidersHorizontal size={18} /><span>基础调色</span><span className="local-badge">本地</span><ChevronDown className={showAdjustments ? 'rotated' : ''} size={14} /></button>
        <div className="sidebar-note"><Layers2 size={17} /><p>从原图开始，随时可回退。<br />照片仅在开始 AI 时发送。</p></div>
        <div className="sidebar-bottom"><div className="model-card"><div className="model-card-heading"><span className={`status-dot ${provider.apiKey ? '' : 'muted'}`} /><span>当前模型服务</span></div><strong>{DEFAULT_PROVIDERS[providerKind].label}</strong><p>{provider.apiKey ? 'Key 已填写 · 尚未验证' : '填写自己的 API Key 后开始'}</p><button onClick={() => setSettingsOpen(true)}>模型设置 <ArrowUpRight size={13} /></button></div><button className="help-button" onClick={() => notify('导入照片后选择工具。换天、去路人和风格可整图生成；涂抹去物、添加内容需要选区。参考图追色需要上传样片。AI 使用你自己的 API Key。')}><CircleHelp size={15} />使用提示<span>?</span></button></div>
      </aside>

      <main className="editor-main">
        <div className="document-bar"><div className="document-title"><span className="document-dot" />{doc ? doc.name : '未打开照片'}{doc && <span className="document-tag">{doc.edits ? `${doc.edits} 次编辑` : '原始照片'}</span>}</div><div className="history-actions"><button className="icon-button" title="撤销编辑" aria-label="撤销编辑" disabled={!doc?.history.length || busy} onClick={undo}><Undo2 size={17} /></button><button className="icon-button" title="重做编辑" aria-label="重做编辑" disabled={!doc?.future.length || busy} onClick={redo}><Redo2 size={17} /></button><span className="vertical-line" /><button className={`compare-button ${compare ? 'active' : ''}`} onClick={() => setCompare(!compare)} disabled={!doc || busy}><SplitSquareHorizontal size={16} /><span>前后对比</span></button></div></div>
        <div ref={stageRef} className={`stage ${!doc ? 'stage-empty' : ''}`}>
          {!doc ? <div className="empty-editor"><div className="empty-art" aria-hidden="true"><div className="art-photo art-photo-back" /><div className="art-photo art-photo-front"><div className="art-sun" /><div className="art-hill art-hill-one" /><div className="art-hill art-hill-two" /><Sparkles size={27} /></div><span className="art-corner corner-one" /><span className="art-corner corner-two" /></div><span className="eyebrow">YOUR PHOTO, YOUR FINISH.</span><h1>导入照片，开始精修</h1><p>保留自然纹理，让每一处细节恰到好处。</p><button className="button button-primary button-large" disabled={busy} onClick={() => inputRef.current?.click()}><Plus size={19} />选择照片</button><span className="drop-hint">也可以把照片拖到这里</span><div className="file-support"><span>JPEG</span><span>PNG</span><span>WebP</span><i />每张最多 30 MB</div></div> : <div className="photo-scroll"><div className="photo-frame" style={{ width: displayWidth, height: displayHeight }}>
            <img className="working-image" src={doc.current} alt="当前编辑照片" draggable={false} />
            {compare && <><div className="original-overlay" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}><img src={doc.original} alt="原始照片对比" draggable={false} /></div><span className="comparison-label before">原图</span><span className="comparison-label after">当前</span><div className="split-line" style={{ left: `${split}%` }}><span><SplitSquareHorizontal size={16} /></span></div><input className="split-input" type="range" min="0" max="100" value={split} onChange={event => setSplit(Number(event.target.value))} aria-label="前后对比分界" /></>}
            <canvas ref={maskRef} data-testid="mask-canvas" className={`mask-canvas ${brushMode === 'pan' || compare || busy ? 'noninteractive' : ''}`} style={{ opacity: showMask && !compare ? 0.48 : 0 }} onPointerDown={startDrawing} onPointerMove={moveDrawing} onPointerUp={finishDrawing} onPointerCancel={finishDrawing} onLostPointerCapture={finishDrawing} onPointerLeave={() => { setPointer(null); if (!drawingRef.current) finishDrawing(); }} aria-label="在照片上涂抹需要处理的区域" />
            <canvas ref={protectionRef} data-testid="protection-canvas" className="protection-canvas" style={{ opacity: showMask && !compare ? 0.5 : 0 }} aria-label="红色区域保留本次处理前的原像素" />
            {pointer && brushMode !== 'pan' && !compare && !busy && <span className={`brush-cursor ${brushMode === 'erase' ? 'erase' : brushMode === 'protect' ? 'protect' : ''}`} style={{ left: pointer.x, top: pointer.y, width: brushSize, height: brushSize }} />}
          </div></div>}
          {doc && <div className="canvas-toolbar"><button aria-label="画笔" title="画笔 B" className={brushMode === 'paint' ? 'active' : ''} disabled={busy || compare} onClick={() => { setBrushMode('paint'); setMaskTarget('edit'); }}><Brush size={17} /></button><button aria-label="保护画笔" title="保护画笔 P" className={brushMode === 'protect' ? 'active protect-active' : ''} disabled={busy || compare} onClick={() => { setBrushMode('protect'); setMaskTarget('protect'); }}><ShieldCheck size={17} /></button><button aria-label={maskTarget === 'protect' ? '擦除保护区' : '擦除选区'} title="擦除当前涂层 E" className={brushMode === 'erase' ? 'active' : ''} disabled={busy || compare} onClick={() => setBrushMode('erase')}><Eraser size={17} /></button><button aria-label="浏览照片" title="浏览照片 H" className={brushMode === 'pan' ? 'active' : ''} disabled={busy || compare} onClick={() => setBrushMode('pan')}><Hand size={17} /></button><span /><button aria-label="缩小" disabled={zoom <= 0.5} onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}><Minus size={15} /></button><output>{Math.round(fittedScale * zoom * 100)}%</output><button aria-label="放大" disabled={zoom >= 4} onClick={() => setZoom(Math.min(4, zoom + 0.25))}><Plus size={15} /></button><button aria-label="适合窗口" title="适合窗口" onClick={() => setZoom(1)}><Maximize size={15} /></button></div>}
          {busy && <div className="busy-overlay" role="status"><LoaderCircle className="spin" size={30} /><strong>{busyLabel}</strong><span>{elapsed ? `已用时 ${elapsed} 秒` : '请稍候'}</span>{abortRef.current && <button className="button button-quiet" onClick={() => abortRef.current?.abort()}>取消本次处理</button>}</div>}
        </div>
        <div className="image-status"><span>{doc ? `${doc.width.toLocaleString()} × ${doc.height.toLocaleString()} px` : '照片将在本机打开'}</span><span>{doc ? 'AI 输入最长边 2048 px · 原尺寸合成导出' : '支持鼠标与触屏涂抹'}<span className="status-dot muted" />{doc ? '当前会话保存' : '准备就绪'}</span></div>
        <section className="filmstrip" aria-label="已导入照片"><div className="filmstrip-heading"><span>照片</span><small>{String(documents.length).padStart(2, '0')}</small></div><div className="thumbnail-list">{documents.map((item, index) => <div className={`thumbnail ${item.id === activeId ? 'active' : ''}`} key={item.id}><button className="thumbnail-select" aria-label={`选择照片 ${item.name}`} disabled={busy} onClick={() => setActiveId(item.id)}><img src={item.current} alt={item.name} /><span>{String(index + 1).padStart(2, '0')}</span>{item.edits > 0 && <i><Check size={10} /></i>}</button><button className="remove-thumbnail" title="从工作台移除" aria-label={`移除照片 ${item.name}`} disabled={busy} onClick={() => removeDocument(item.id)}><X size={11} /></button></div>)}<button className="add-thumbnail" aria-label="添加照片" disabled={busy} onClick={() => inputRef.current?.click()}><Plus size={21} /><span>添加照片</span></button>{!documents.length && <span className="filmstrip-empty">你的照片会显示在这里</span>}</div><span className="filmstrip-count">{documents.length}/10</span></section>
      </main>

      <aside className="properties-sidebar"><div className="properties-scroll"><div className="properties-heading"><span className="properties-icon"><activeTool.icon size={21} /></span><div><span className="eyebrow">AI RETOUCH</span><h2>{activeTool.name}</h2></div><span className="ai-chip">AI</span></div><p className="tool-description">{activeTool.description}</p>
        {doc?.aiReview && <div className="property-section result-review"><div className="property-title">检查本次添加结果<span>本地切换</span></div><div className="style-categories" aria-label="添加结果合成方式"><button data-testid="result-selection" className={doc.aiReview.mode === 'selection' ? 'selected' : ''} aria-pressed={doc.aiReview.mode === 'selection'} disabled={busy} onClick={() => void reviewAiResult('selection')}>选区合成</button><button data-testid="result-full" className={doc.aiReview.mode === 'full' ? 'selected' : ''} aria-pressed={doc.aiReview.mode === 'full'} disabled={busy} onClick={() => void reviewAiResult('full')}>{doc.aiReview.protection ? '完整画面＋保护区' : '模型完整画面'}</button></div><p className="preset-description">{doc.aiReview.protection ? '切换完整画面也会保留生成时的保护区原像素。未保护区域仍可能被模型重绘，切换不会再次调用模型。' : '完整画面会采用模型整张输出，人物五官与背景都可能变化。想保住人物，请从原图重做并先涂保护区。切换不再调用模型。'}</p></div>}
        {tool === 'sky' && <div className="property-section creative-section"><div className="property-title">选择天空<span>05 PRESETS</span></div><div className="sky-grid">{SKY_PRESETS.map(preset => <button key={preset.id} data-testid={`sky-preset-${preset.id}`} aria-pressed={skyId === preset.id} className={`sky-preset ${skyId === preset.id ? 'selected' : ''}`} disabled={busy} onClick={() => setSkyId(preset.id)}><span className="sky-swatch" style={{ background: `linear-gradient(155deg, ${preset.colors.join(', ')})` }} /><strong>{preset.name}</strong>{skyId === preset.id && <Check size={12} />}</button>)}</div><p className="preset-description">{activeSky.description}。色卡为氛围示意，生成效果取决于照片和模型。</p></div>}
        {tool === 'style' && <div className="property-section creative-section"><div className="property-title">风格灵感<span>08 LOOKS</span></div><div className="style-categories" aria-label="风格分类">{(['photo', 'art'] as const).map(category => <button key={category} data-testid={`style-category-${category}`} aria-pressed={styleCategory === category} className={styleCategory === category ? 'selected' : ''} disabled={busy} onClick={() => { setStyleCategory(category); setStyleId(STYLE_PRESETS.find(preset => preset.category === category)!.id); }}>{category === 'photo' ? '摄影调色' : '艺术重绘'}</button>)}</div><div className="style-grid">{STYLE_PRESETS.filter(preset => preset.category === styleCategory).map(preset => <button key={preset.id} data-testid={`style-preset-${preset.id}`} aria-pressed={styleId === preset.id} className={`style-preset ${styleId === preset.id ? 'selected' : ''}`} disabled={busy} onClick={() => setStyleId(preset.id)}><span className="style-swatch" style={{ background: `linear-gradient(135deg, ${preset.colors.join(', ')})` }}><Palette size={18} />{styleId === preset.id && <i><Check size={11} /></i>}</span><strong>{preset.name}</strong></button>)}</div><p className="preset-description">{activeStyle.description}。{activeStyle.category === 'art' ? '会改变照片材质与笔触，保留人物辨识和构图。' : '以颜色、影调和氛围为主，尽量保留原有细节。'}色卡仅为氛围示意。</p></div>}
        {(tool === 'match' || tool === 'style') && <div className="property-section reference-section"><div className="property-title">风格参考图<span>{tool === 'match' ? '必需' : '可选'}</span></div>{reference ? <div className="reference-card"><img src={reference.dataUrl} alt="已上传的风格参考图" /><div><strong title={reference.name}>{reference.name}</strong><span>仅迁移色调与视觉氛围</span><button data-testid="reference-upload" disabled={busy} onClick={() => referenceInputRef.current?.click()}>更换参考图 <ArrowUpRight size={11} /></button></div><button data-testid="reference-remove" className="icon-button" aria-label="移除参考图" disabled={busy} onClick={() => setReference(null)}><X size={15} /></button></div> : <button data-testid="reference-upload" className="reference-upload" disabled={busy} onClick={() => referenceInputRef.current?.click()}><Images size={23} /><strong>上传参考图</strong><span>{tool === 'match' ? '选择喜欢的样片，学习它的色彩' : '也可以用自己的样片辅助风格'}</span><small>JPEG · PNG · WebP</small></button>}<p className="preset-description">参考图与原图会一起发送至所选模型。只借鉴色调，不复制人物与构图。</p></div>}
        <div className="property-section protection-section"><div className="property-title"><span className="protection-title"><ShieldCheck size={14} />人物与细节保护</span><span>{hasProtection ? '已涂保护区' : '未设置'}</span></div><p className="property-help">添加背景物体时可保护整个人；拥抱等互动只保护脸、眼睛和头发，让身体交叠处保持可编辑。红色区保留处理前原像素，切换照片后需重涂。</p><div className="protection-actions"><button className={brushMode === 'protect' ? 'selected' : ''} disabled={!doc || busy || compare} onClick={() => { setBrushMode('protect'); setMaskTarget('protect'); }}><ShieldCheck size={13} />涂画保护区</button><button disabled={!hasProtection || busy} onClick={() => { setBrushMode('erase'); setMaskTarget('protect'); }}>擦除保护</button><button aria-label="清除保护区" disabled={!hasProtection || busy} onClick={clearProtection}><RotateCcw size={12} />清除</button></div><p className="protection-status">{brushMode === 'protect' ? '当前：红色保护画笔 · 快捷键 P' : brushMode === 'erase' && maskTarget === 'protect' ? '当前：擦除保护区 · 切回编辑画笔用 B' : '绿色为编辑区域，红色为保护区域'}</p></div>
        <div className="property-section"><div className="property-title">处理强度<span>{strength <= 30 ? '轻柔' : strength <= 65 ? '自然' : '明显'}</span></div><Slider label="精修程度" value={strength} min={10} max={100} suffix="%" onChange={setStrength} disabled={busy} /><div className="strength-labels"><span>轻柔保留</span><span>明显修饰</span></div><div className="tip-card"><Sparkles size={14} /><span>{activeTool.tip}</span></div></div>
        <div className="property-section"><div className="property-title">局部选区<span className={hasSelection ? 'selection-ready' : ''}>{hasSelection ? '已涂选' : '未涂选'}</span></div><p className="property-help">{needsSelection ? tool === 'add' ? '填满新物体和遮挡交叠处；例如拥抱时要覆盖前爪压住衣服的区域，并用红色保护脸部。生成后绿色选区会清除。' : '在照片上涂过需要移除的内容。' : tool === 'sky' ? '不涂选时由模型识别天空；涂选时仅合成选区。' : tool === 'people' ? '不涂选时识别背景路人；多人合照可手动指定。' : '可直接处理整张照片，也可涂选局部。'}</p><Slider label="画笔大小" value={brushSize} min={5} max={160} suffix=" px" onChange={setBrushSize} disabled={busy} /><div className="mask-actions"><button onClick={undoMask} disabled={!maskUndoCount || busy}><Undo2 size={13} />撤回涂抹</button><button onClick={clearMask} disabled={!hasSelection || busy}><RotateCcw size={13} />清除</button><button className={showMask ? 'active' : ''} title="显示或隐藏选区" aria-label="显示或隐藏选区" onClick={() => setShowMask(!showMask)}>{showMask ? <Eye size={15} /> : <EyeOff size={15} />}</button></div></div>
        <div className="property-section prompt-section"><label htmlFor="prompt" className="property-title">{tool === 'add' ? '添加什么内容' : '补充要求'}<span>{tool === 'add' ? '必填' : '可选'}</span></label><textarea id="prompt" placeholder={tool === 'add' ? '例如：猫坐在男孩身后，前爪从两侧伸到衣服前方环抱腰部，保留男孩脸和头部位置'  : tool === 'people' ? '例如：保留中间穿蓝衣的主体，只去掉右后方路人' : tool === 'sky' ? '例如：保留建筑轮廓，让湖面倒影与新天空一致' : tool === 'style' ? '例如：更柔和一点，保留人物辨识与原有构图' : tool === 'match' ? '例如：学习参考图的暖色高光，但保留我的肤色' : tool === 'remove' ? '例如：去掉路人，保留地面阴影与背景结构' : '例如：保留雀斑，减淡额头和下巴的痘印'} value={customPrompt} onChange={event => setCustomPrompt(event.target.value)} maxLength={1200} disabled={busy} /><div className="prompt-footnote"><span>{tool === 'style' && activeStyle.category === 'art' ? '艺术重绘会改变材质与笔触' : '保留身份与构图的要求会自动加入'}</span><span>{customPrompt.length}/1200</span></div></div>
        {showAdjustments && <div className="property-section adjustments"><div className="property-title">基础调色<span>本地处理</span></div>{([{ key: 'exposure', label: '曝光', min: -2, max: 2, step: 0.1, suffix: ' EV' }, { key: 'contrast', label: '对比度', min: -50, max: 50 }, { key: 'saturation', label: '饱和度', min: -50, max: 50 }, { key: 'temperature', label: '蓝—琥珀偏移', min: -100, max: 100 }, { key: 'tint', label: '绿—洋红偏移', min: -100, max: 100 }] as const).map(item => <Slider key={item.key} label={item.label} value={adjustments[item.key]} min={item.min} max={item.max} step={'step' in item ? item.step : 1} suffix={'suffix' in item ? item.suffix : ''} disabled={busy} onChange={value => setAdjustments(previous => ({ ...previous, [item.key]: value }))} />)}<button className="button button-secondary full-width" onClick={() => void applyColor()} disabled={!doc || busy || Object.values(adjustments).every(value => value === 0)}>应用调色</button></div>}
        <div className="preservation-note"><Check size={13} /><span>{doc?.aiReview?.mode === 'full' ? doc.aiReview.protection ? '完整画面已保留保护区 · 其他区域可能变化' : '当前为模型完整画面 · 人物与背景可能变化' : hasSelection ? '原图保留 · 选区外保持原样' : '原图保留 · 可撤销 · 整图生成请检查细节'}</span></div>
      </div><div className="run-section"><button className="run-button" onClick={() => void runAi()} disabled={!doc || busy}><WandSparkles size={19} />{busy ? '正在处理…' : `开始${activeTool.name}`}<span><ArrowUpRight size={16} /></span></button><p>{provider.apiKey ? `使用 ${DEFAULT_PROVIDERS[providerKind].label} · 按服务商规则计费` : <button onClick={() => setSettingsOpen(true)}>先配置模型 API Key <ArrowUpRight size={11} /></button>}</p></div></aside>
    </div>
    {dragging && <div className="drag-overlay"><Upload size={42} /><strong>松开，导入照片</strong><span>JPEG · PNG · WebP</span></div>}
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleHelp size={17} /> : <Check size={17} />}<span>{toast.text}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={15} /></button></div>}

    {settingsOpen && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-heading"><div><span className="eyebrow">BRING YOUR OWN MODEL</span><h2 id="settings-title">连接你的 AI 模型</h2></div><button className="icon-button" aria-label="关闭模型设置" onClick={() => setSettingsOpen(false)}><X size={20} /></button></div><p className="modal-intro">选择支持图像编辑的服务。照片会在开始 AI 处理时发送到你选择的接口。</p><div className="provider-grid">{(Object.keys(DEFAULT_PROVIDERS) as ProviderKind[]).map(kind => <button key={kind} className={providerKind === kind ? 'selected' : ''} onClick={() => setProviderKind(kind)}><span>{DEFAULT_PROVIDERS[kind].label}</span>{providerKind === kind && <Check size={15} />}</button>)}</div><label className="text-field"><span>API 地址</span><input type="url" aria-describedby={providerKind === 'ark' ? 'ark-address-help' : undefined} autoCapitalize="off" spellCheck={false} value={provider.baseUrl} onChange={event => changeProviderField('baseUrl', event.target.value)} placeholder={DEFAULT_PROVIDERS[providerKind].baseUrl} />{providerKind === 'ark' && <small id="ark-address-help" className="api-address-help">建议填到 /api/v3；粘贴完整 /images/generations 地址也会自动识别。</small>}</label><label className="text-field"><span>模型名称／接入点 ID</span><input autoCapitalize="off" spellCheck={false} value={provider.model} onChange={event => changeProviderField('model', event.target.value)} placeholder={DEFAULT_PROVIDERS[providerKind].model} /></label><label className="text-field"><span>API Key<span className="field-meta">仅当前会话保存</span></span><div className="secret-input"><input autoComplete="off" autoCapitalize="off" spellCheck={false} type={keyVisible ? 'text' : 'password'} value={provider.apiKey} onChange={event => changeProviderField('apiKey', event.target.value)} placeholder="在此填写，密钥不会写入配置文件" /><button type="button" aria-label={keyVisible ? '隐藏 API Key' : '显示 API Key'} onClick={() => setKeyVisible(!keyVisible)}>{keyVisible ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label><div className="settings-note"><CircleHelp size={17} /><p>{providerKind === 'compatible' ? '兼容服务需支持图像编辑与图片上传；只有文字聊天能力的模型无法修图。' : providerKind === 'ark' ? '可填写服务商提供的模型名或你创建的接入点 ID。账号须已开通对应图像编辑能力。' : '需要对应服务商的 API 权限与额度。软件不会代替你购买额度。'}<br />关闭应用后需要重新填写 API Key。</p></div><div className="modal-actions"><button className="button button-quiet" onClick={() => setConfigs(previous => ({ ...previous, [providerKind]: { ...previous[providerKind], apiKey: '' } }))}>清除密钥</button><button className="button button-primary" onClick={() => { setSettingsOpen(false); notify('模型设置已保存。API Key 仅在本次会话内保留。'); }}><Check size={16} />完成设置</button></div></section></div>}
    {exportOpen && doc && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) setExportOpen(false); }}><section className="modal export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title"><div className="modal-heading"><div><span className="eyebrow">READY TO SAVE</span><h2 id="export-title">导出你的照片</h2></div><button className="icon-button" aria-label="关闭导出" disabled={busy} onClick={() => setExportOpen(false)}><X size={20} /></button></div><div className="export-preview"><img src={doc.current} alt="待导出照片" /><div><strong>{doc.name}</strong><span>{doc.width.toLocaleString()} × {doc.height.toLocaleString()} px</span><span>按当前编辑结果导出，原文件不覆盖</span></div></div><div className="format-options"><button className={exportFormat === 'jpeg' ? 'selected' : ''} onClick={() => setExportFormat('jpeg')}><strong>JPEG</strong><span>高画质 · 便于分享</span></button><button className={exportFormat === 'png' ? 'selected' : ''} onClick={() => setExportFormat('png')}><strong>PNG</strong><span>无损编码 · 文件较大</span></button></div><p className="export-note">第一版以浏览器解码后的照片为基础，不保留原文件的 EXIF／ICC 配置。</p><button className="button button-primary full-width button-large" onClick={() => void savePhoto()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowDownToLine size={18} />}{busy ? '正在导出…' : '保存照片'}</button></section></div>}
  </div>;
}
