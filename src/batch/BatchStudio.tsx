import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, FolderPlus, Image as ImageIcon, LoaderCircle, Play, RotateCcw, Square, Trash2, X } from 'lucide-react';
import { encodeExport, loadPhoto } from '../imaging';
import { exportArchive, exportImage, MAX_ARCHIVE_BYTES } from '../platform';
import { loadPortraitPresets, PRESET_STORAGE_KEY } from '../portrait/presets';
import { DEFAULT_PORTRAIT_SETTINGS, normalizePortraitSettings, PORTRAIT_FIELDS, ZERO_PORTRAIT_SETTINGS } from '../portrait/settings';
import type { PortraitSettings } from '../portrait/settings';
import { processBatchPortrait } from './engine';
import { runSequentialBatch } from './queue';
import type { BatchQueueSnapshot, BatchQueueStatus } from './queue';
import { createImageArchive } from './export';
import type { ArchiveImage } from './export';
import { blobBase64, deleteBatchResult, getBatchResult, listBatchResults, saveBatchResult } from './storage';
import type { StoredBatchResult } from './storage';
import './BatchStudio.css';

export interface BatchStudioProps {
  open: boolean;
  onClose(): void;
  onBusy(busy: boolean, label?: string): void;
  initialSettings: PortraitSettings;
  notify(text: string, error?: boolean): void;
}
type BatchRow = {
  id: string; name: string; status: BatchQueueStatus; reason?: string; resultId?: string;
  width?: number; height?: number; faceCount?: number; bodyCount?: number; warnings: string[];
};
type JobItem = { id: string; name: string; file?: File; previousResultId?: string };
type JobResult = {
  changed: boolean; reason?: string; resultId?: string; width: number; height: number;
  faceCount: number; bodyCount: number; warnings: string[];
};
type RunSummary = { total: number; done: number; succeeded: number; skipped: number; failed: number; cancelled: number };
type PresetOption = { id: string; name: string; description: string; settings: PortraitSettings };
const MAX_FILES = 100;
const STATUS_TEXT: Record<BatchQueueStatus, string> = {
  pending: '待处理', running: '处理中', succeeded: '已完成', skipped: '已跳过', failed: '失败', cancelled: '已取消',
};
const RECOMMENDED: PresetOption[] = [
  { id: 'natural', name: '自然保留', description: '轻减瑕疵，保留皮肤质感；适合先试一张。', settings: {
    ...ZERO_PORTRAIT_SETTINGS, smoothing: 18, blemish: 18, evenness: 12, brightening: 8, shine: 10,
  } },
  { id: 'clear', name: '通透肤色', description: '适度提亮、减黄和泛红，保持原有五官。', settings: {
    ...ZERO_PORTRAIT_SETTINGS, smoothing: 24, blemish: 22, evenness: 24, brightening: 22, shine: 14, deYellow: 10, deRedness: 8,
  } },
  { id: 'gentle', name: '轻柔人像', description: '柔和修饰肤色，并轻减黑眼圈；默认不塑形。', settings: {
    ...DEFAULT_PORTRAIT_SETTINGS, darkCircles: 8,
  } },
];
const abortError = () => new DOMException('已取消本次批量操作。', 'AbortError');
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw abortError(); };
const isCancelled = (error: unknown, signal?: AbortSignal) => signal?.aborted || error instanceof Error && error.name === 'AbortError';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '批量操作失败，请重试。';
const storedMetadata = (record: StoredBatchResult): BatchRow => ({
  id: record.id, name: record.name, status: 'succeeded', resultId: record.id,
  width: record.width, height: record.height, faceCount: record.faceCount, bodyCount: record.bodyCount,
  warnings: record.warnings || [],
});
const rawBytes = (base64: string) => Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);

export function BatchStudio({ open, onClose, onBusy, initialSettings, notify }: BatchStudioProps) {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [presetId, setPresetId] = useState('natural');
  const [personal, setPersonal] = useState(loadPortraitPresets);
  const [restoring, setRestoring] = useState(true);
  const [storageError, setStorageError] = useState('');
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState('');
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<'original' | 'result'>('result');
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [format, setFormat] = useState<'jpeg' | 'png'>('jpeg');
  const files = useRef(new Map<string, File>());
  const input = useRef<HTMLInputElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const job = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const notifyRef = useRef(notify); notifyRef.current = notify;

  const presets = useMemo(() => [...RECOMMENDED,
    { id: 'current', name: '当前单张参数', description: '使用单张人像精修当前参数，应用到每张照片内的所有识别人物。', settings: normalizePortraitSettings(initialSettings) },
    ...personal.map(preset => ({ id: `personal:${preset.id}`, name: preset.name, description: '已保存在本机的个人预设，包含肤色、塑形与细节参数。', settings: preset.settings })),
  ], [initialSettings, personal]);
  const preset = presets.find(value => value.id === presetId) || RECOMMENDED[0];
  const selectedRows = rows.filter(row => selected.has(row.id));
  const selectedOriginals = selectedRows.filter(row => files.current.has(row.id));
  const selectedResults = selectedRows.filter(row => row.resultId);
  const preview = rows.find(row => row.id === previewId);
  const locked = busy || restoring;
  const completeCount = rows.filter(row => row.resultId).length;

  useEffect(() => {
    alive.current = true;
    let valid = true;
    listBatchResults().then(records => {
      if (!valid) return;
      const restored = records.map(storedMetadata);
      setRows(restored); setSelected(new Set(restored.map(row => row.id)));
      if (restored[0]) setPreviewId(restored[0].id);
    }).catch(error => { if (valid) setStorageError(errorMessage(error)); })
      .finally(() => { if (valid) setRestoring(false); });
    return () => { valid = false; alive.current = false; job.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!open) return;
    setPersonal(loadPortraitPresets());
    closeButton.current?.focus();
  }, [open]);
  useEffect(() => { if (busy) cancelButton.current?.focus(); }, [busy]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === PRESET_STORAGE_KEY || event.key === null) setPersonal(loadPortraitPresets()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  useEffect(() => {
    if (presets.some(value => value.id === presetId)) return;
    setPresetId('natural');
  }, [presets, presetId]);

  useEffect(() => {
    let valid = true, url = '';
    setPreviewUrl(''); setPreviewError('');
    if (!open || !preview) return;
    const show = async () => {
      let blob: Blob | undefined;
      if (previewMode === 'original') blob = files.current.get(preview.id);
      else if (preview.resultId) blob = (await getBatchResult(preview.resultId))?.blob;
      if (!valid) return;
      if (!blob) { setPreviewError(previewMode === 'original' ? '原图只在本次运行中保留。刷新后的本地记录可预览和导出结果；重新处理请重新导入原图。' : '此照片还没有已保存结果。可先试一张，或切换查看原图。'); return; }
      url = URL.createObjectURL(blob); setPreviewUrl(url);
    };
    void show().catch(error => { if (valid) setPreviewError(errorMessage(error)); });
    return () => { valid = false; if (url) URL.revokeObjectURL(url); };
  }, [open, preview?.id, preview?.resultId, previewMode]);

  function setOperation(controller: AbortController, label: string) {
    job.current = controller; setBusy(true); setActivity(label); onBusy(true, label);
  }
  function finishOperation(controller: AbortController) {
    if (job.current !== controller) return;
    job.current = null;
    if (alive.current) { setBusy(false); setActivity(''); onBusy(false); }
  }
  function updateActivity(label: string) { if (alive.current) { setActivity(label); onBusy(true, label); } }

  function importFiles(incoming: FileList | null) {
    if (!incoming || locked) return;
    const list = Array.from(incoming);
    if (input.current) input.current.value = '';
    const invalid = list.filter(file => !/\.(?:jpe?g|png|webp)$/i.test(file.name) || file.size === 0 || file.size > 30 * 1024 * 1024);
    const supported = list.filter(file => !invalid.includes(file));
    const fingerprints = new Set(Array.from(files.current.values()).map(file => `${file.name}\0${file.size}\0${file.lastModified}`));
    let duplicates = 0;
    const additions = supported.filter(file => {
      const key = `${file.name}\0${file.size}\0${file.lastModified}`;
      if (fingerprints.has(key)) { duplicates++; return false; }
      fingerprints.add(key); return true;
    });
    if (rows.length + additions.length > MAX_FILES) { notify(`列表最多 ${MAX_FILES} 张，当前已有 ${rows.length} 张。本次未添加，请先删除部分记录或减少选择。`, true); return; }
    const added = additions.map(file => {
      const id = crypto.randomUUID(); files.current.set(id, file);
      return { id, name: file.name, status: 'pending' as const, warnings: [] };
    });
    setRows(previous => [...previous, ...added]);
    setSelected(previous => new Set([...previous, ...added.map(row => row.id)]));
    if (added[0]) { setPreviewId(added[0].id); setPreviewMode('original'); }
    notify(`已添加 ${added.length} 张${duplicates ? `，忽略 ${duplicates} 张重复原图` : ''}${invalid.length ? `；${invalid.length} 个文件未添加（仅支持非空且不超过 30 MB 的 JPEG、PNG、WebP）` : ''}。`, invalid.length > 0);
  }

  async function run(mode: 'selected' | 'trial' | 'retry') {
    if (locked || job.current) return;
    const candidates = rowsRef.current.filter(row => selected.has(row.id) && (mode !== 'retry' || row.status === 'failed' || row.status === 'cancelled'));
    const targets = mode === 'trial' ? candidates.filter(row => files.current.has(row.id)).slice(0, 1) : candidates;
    if (!targets.some(row => files.current.has(row.id))) { notify('请先导入并选中原图。本地恢复记录没有原图，只能预览和导出已有结果。', true); return; }
    const settings = normalizePortraitSettings(preset.settings);
    const items: JobItem[] = targets.map(row => ({ id: row.id, name: row.name, file: files.current.get(row.id), previousResultId: row.resultId }));
    const controller = new AbortController();
    const unaccepted = new Set<string>();
    const handled = new Set<string>();
    const removeLate = (id: string) => deleteBatchResult(id).catch(error => {
      if (alive.current) notifyRef.current(`取消后的临时结果清理失败：${errorMessage(error)}`, true);
    });
    const cancelCleanup = () => { for (const id of unaccepted) void removeLate(id); };
    controller.signal.addEventListener('abort', cancelCleanup);
    setOperation(controller, mode === 'trial' ? '正在试修第一张照片' : '正在准备批量精修');
    setSummary({ total: items.length, done: 0, succeeded: 0, skipped: 0, failed: 0, cancelled: 0 });
    const accept = (snapshot: BatchQueueSnapshot<JobItem, JobResult>) => {
      if (!alive.current) return;
      setSummary({ total: snapshot.total, done: snapshot.succeeded + snapshot.skipped + snapshot.failed,
        succeeded: snapshot.succeeded, skipped: snapshot.skipped, failed: snapshot.failed, cancelled: snapshot.cancelled });
      for (const entry of snapshot.entries) {
        if ((entry.status !== 'succeeded' && entry.status !== 'skipped') || handled.has(entry.id)) continue;
        handled.add(entry.id);
        if (entry.result?.resultId) unaccepted.delete(entry.result.resultId);
        // Replace old results only after this attempt has been accepted. Earlier
        // completed results therefore survive cancellation or a failed retry.
        if (entry.result && entry.item.previousResultId && entry.item.previousResultId !== entry.result.resultId) {
          void deleteBatchResult(entry.item.previousResultId).catch(error => notifyRef.current(`旧结果清理失败：${errorMessage(error)}`, true));
        }
      }
      setRows(previous => previous.map(row => {
        const entry = snapshot.entries.find(value => value.id === row.id);
        if (!entry) return row;
        const result = entry.result;
        return { ...row, status: entry.status, reason: entry.error || entry.reason,
          ...(result ? { resultId: result.resultId, width: result.width, height: result.height,
            faceCount: result.faceCount, bodyCount: result.bodyCount, warnings: result.warnings } : {}),
        };
      }));
    };
    try {
      const snapshot = await runSequentialBatch(items, async (item, signal): Promise<JobResult> => {
        checkAbort(signal);
        if (!item.file) throw new Error('没有原图，请重新导入。');
        updateActivity(`正在读取 ${item.name}`);
        const photo = await loadPhoto(item.file); checkAbort(signal);
        const result = await processBatchPortrait(photo.dataUrl, settings, { signal,
          onProgress: value => updateActivity(`${item.name} · ${value.label}`),
        });
        checkAbort(signal);
        if (!result.changed) return { changed: false, reason: result.warnings.join(' ') || '所选参数未产生像素变化，本张未处理。',
          width: photo.width, height: photo.height, faceCount: result.faceCount, bodyCount: result.bodyCount, warnings: result.warnings };
        const blob = await (await fetch(result.image, { signal })).blob(); checkAbort(signal);
        const resultId = crypto.randomUUID();
        unaccepted.add(resultId);
        try {
          updateActivity(`${item.name} · 正在保存本地结果`);
          await saveBatchResult({ id: resultId, name: item.name, blob, width: photo.width, height: photo.height,
            createdAt: Date.now(), settings: { ...settings }, faceCount: result.faceCount, bodyCount: result.bodyCount, warnings: result.warnings });
          if (signal.aborted) { await removeLate(resultId); throw abortError(); }
          return { changed: true, resultId, width: photo.width, height: photo.height, faceCount: result.faceCount, bodyCount: result.bodyCount, warnings: result.warnings };
        } catch (error) { if (signal.aborted) await removeLate(resultId); unaccepted.delete(resultId); throw error; }
      }, { signal: controller.signal,
        shouldSkip: item => !item.file ? '此本地记录没有原图，已跳过重新处理；已有结果仍可预览与导出。' : undefined,
        resultSkipReason: result => !result.changed ? result.reason : undefined,
        onUpdate: accept,
      });
      if (snapshot.wasCancelled) notify(`已取消。保留已成功的 ${snapshot.succeeded} 张，本轮未处理完的 ${snapshot.cancelled} 张可重新处理。`);
      else notify(`本轮结束：成功 ${snapshot.succeeded} 张，跳过 ${snapshot.skipped} 张，失败 ${snapshot.failed} 张。${snapshot.failed ? '可查看原因后重试选中失败项。' : ''}`);
      const first = snapshot.entries.find(entry => entry.status === 'succeeded');
      if (first) { setPreviewId(first.id); setPreviewMode('result'); }
    } catch (error) { if (!isCancelled(error, controller.signal)) notify(errorMessage(error), true); }
    finally {
      controller.signal.removeEventListener('abort', cancelCleanup);
      if (controller.signal.aborted) cancelCleanup();
      finishOperation(controller);
    }
  }

  async function readResult(row: BatchRow, signal: AbortSignal) {
    checkAbort(signal);
    if (!row.resultId) throw new Error(`${row.name}没有已保存结果，请只选择已完成照片导出。`);
    const record = await getBatchResult(row.resultId); checkAbort(signal);
    if (!record) throw new Error(`${row.name}的本地结果已被清除，请重新处理，或从列表移除这条记录。`);
    const base64 = await blobBase64(record.blob); checkAbort(signal);
    const encoded = await encodeExport(`data:${record.blob.type || 'image/png'};base64,${base64}`, format, 0.94);
    checkAbort(signal);
    return { name: row.name, ...encoded };
  }

  async function download(single?: BatchRow) {
    if (locked || job.current) return;
    const targets = single ? [single] : selectedRows;
    if (!targets.length || targets.some(row => !row.resultId)) { notify('请只选中已有结果的照片后导出；未完成或跳过的照片不会被悄悄漏掉。', true); return; }
    const controller = new AbortController(); setOperation(controller, '正在准备导出');
    try {
      if (single) {
        const encoded = await readResult(single, controller.signal);
        const result = await exportImage(encoded.base64, encoded.mimeType, single.name);
        if (!controller.signal.aborted) notify(result.message);
      } else {
        const archive: ArchiveImage[] = []; let totalBytes = 22;
        for (let index = 0; index < targets.length; index += 1) {
          updateActivity(`正在编码导出 ${index + 1} / ${targets.length}`);
          const encoded = await readResult(targets[index], controller.signal);
          totalBytes += rawBytes(encoded.base64) + new TextEncoder().encode(encoded.name).length * 2 + 256;
          if (totalBytes > MAX_ARCHIVE_BYTES) throw new Error('选中照片的导出包超过 64 MiB，本次没有下载或漏掉任何照片。请减少选中数量，或改用 JPEG 后分批导出。');
          archive.push(encoded);
        }
        updateActivity('正在生成 ZIP 文件');
        const bytes = await createImageArchive(archive, controller.signal); checkAbort(controller.signal);
        if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('导出包超过 64 MiB，请减少选中数量后分批导出。');
        const result = await exportArchive(bytes, `光修批量人像_${new Date().toISOString().slice(0, 10)}.zip`);
        if (!controller.signal.aborted) notify(result.message);
      }
    } catch (error) { notify(isCancelled(error, controller.signal) ? '已取消导出，已保存的照片仍在本地结果库。' : errorMessage(error), !isCancelled(error, controller.signal)); }
    finally { finishOperation(controller); }
  }

  async function remove(all = false) {
    if (locked || job.current) return;
    const targets = all ? rows : selectedRows;
    if (!targets.length) return;
    const controller = new AbortController(); setOperation(controller, '正在删除选中的本地记录');
    const removed = new Set<string>(); let failed = 0;
    try {
      for (const row of targets) {
        checkAbort(controller.signal);
        try { if (row.resultId) await deleteBatchResult(row.resultId); removed.add(row.id); files.current.delete(row.id); }
        catch { failed++; }
      }
    } catch (error) { if (!isCancelled(error, controller.signal)) notify(errorMessage(error), true); }
    finally {
      setRows(previous => previous.filter(row => !removed.has(row.id)));
      setSelected(previous => new Set([...previous].filter(id => !removed.has(id))));
      if (previewId && removed.has(previewId)) setPreviewId(null);
      notify(`已删除 ${removed.size} 条记录及其本地结果。${failed ? `${failed} 条删除失败，请检查站点存储权限后重试。` : ''}`, failed > 0);
      finishOperation(controller);
    }
  }

  return <div ref={container} className="batch-studio" hidden={!open} role="dialog" aria-modal="true" aria-labelledby="batch-title" data-testid="batch-studio"
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape' && !busy) onClose();
      if (event.key === 'Tab') {
        const buttons = Array.from(container.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || []).filter(element => element.offsetParent !== null);
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <div className="batch-window">
      <header className="batch-header"><div><span className="batch-eyebrow">LOCAL PORTRAIT WORKFLOW</span><h2 id="batch-title">批量人像精修</h2><p>先试一张，再把同一套参数应用到整组照片。</p></div><div className="batch-header-actions">{busy && <button ref={cancelButton} className="batch-header-cancel" data-testid="batch-cancel" onClick={() => { job.current?.abort(); setActivity('正在取消，保留此前已完成结果…'); }}><Square size={12} />取消当前操作</button>}<button ref={closeButton} className="batch-icon" aria-label="关闭批量精修" disabled={busy} onClick={onClose}><X size={22} /></button></div></header>
      <ol className="batch-steps" aria-label="批量精修四步"><li><b>1</b>添加原图</li><li><b>2</b>选择参数</li><li><b>3</b>先试一张</li><li><b>4</b>处理并导出</li></ol>
      <div className="batch-content">
        <section className="batch-setup" aria-label="批量参数">
          <div className="batch-step-title"><span>01</span><h3>添加照片</h3><small>{rows.length} / {MAX_FILES} 张</small></div>
          <input ref={input} className="hidden-input" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" multiple data-testid="batch-file-input" onChange={event => importFiles(event.target.files)} />
          <button className="batch-import" disabled={locked || rows.length >= MAX_FILES} onClick={() => input.current?.click()}><FolderPlus size={24} /><strong>添加 JPEG / PNG / WebP</strong><span>最多 100 张，每张不超过 30 MB</span></button>
          <div className="batch-step-title"><span>02</span><h3>选择一套参数</h3></div>
          <label className="batch-select"><span>批量预设</span><select data-testid="batch-preset" value={presetId} disabled={locked} onChange={event => setPresetId(event.target.value)}><optgroup label="推荐 · 默认不塑形">{RECOMMENDED.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</optgroup><optgroup label="我的参数"><option value="current">当前单张参数</option>{personal.map(value => <option key={value.id} value={`personal:${value.id}`}>{value.name}</option>)}</optgroup></select></label>
          <p className="batch-help">{preset.description}</p>
          <details className="batch-parameters"><summary>查看本次 20 项参数</summary><div>{PORTRAIT_FIELDS.map(field => <span key={field.key}>{field.label}<b>{preset.settings[field.key]}</b></span>)}</div></details>
          <div className="batch-note"><Check size={16} /><p>本机处理，不需要 API Key，不上传照片。每张中的所有识别人物共用这套参数，不进行跨照片身份匹配，也不会搬用单张编辑器的红绿画笔。</p></div>
          <div className="batch-step-title"><span>03</span><h3>试修与处理</h3></div>
          <div className="batch-run-buttons"><button className="batch-secondary" data-testid="batch-trial" disabled={locked || !selectedOriginals.length || Boolean(storageError)} onClick={() => void run('trial')}><Play size={15} />先试 1 张</button><button className="batch-primary" data-testid="batch-run" disabled={locked || !selectedOriginals.length || Boolean(storageError)} onClick={() => void run('selected')}><Check size={15} />处理选中（{selectedRows.length}）</button><button className="batch-secondary" data-testid="batch-retry" disabled={locked || !selectedOriginals.some(row => row.status === 'failed' || row.status === 'cancelled') || Boolean(storageError)} onClick={() => void run('retry')}><RotateCcw size={14} />重试选中失败 / 取消项</button></div>
          <p className="batch-help">每次都从导入的原图重新计算，不叠加上次精修。失败后继续下一张，不会自动重试；塑形部位不完整时会明确失败。</p>
          <div className="batch-step-title"><span>04</span><h3>导出已完成结果</h3></div>
          <label className="batch-select"><span>导出格式</span><select aria-label="批量导出格式" value={format} disabled={locked} onChange={event => setFormat(event.target.value as 'jpeg' | 'png')}><option value="jpeg">JPEG · 适合分享，文件较小</option><option value="png">PNG · 保留合成像素，文件较大</option></select></label>
          <button className="batch-primary batch-wide" data-testid="batch-download-zip" disabled={locked || !selectedRows.length || selectedResults.length !== selectedRows.length} onClick={() => void download()}><Download size={16} />导出选中 ZIP（{selectedResults.length}）</button>
          {selectedRows.length > selectedResults.length && <p className="batch-help">选中项包含没有结果的照片，请点击“仅选已有结果”后导出。</p>}
          <p className="batch-help">逐张编码后打包，单包上限 64 MiB；超限会提示分批，不会漏掉照片。</p>
          <p className="batch-storage-note">完成结果保存在此设备的浏览器站点存储中，刷新后可恢复预览和导出。原图文件仅在本次运行中保留；关闭网页后重新处理需再导入。清理站点数据或卸载应用会删除本地结果，请及时导出备份。</p>
        </section>
        <section className="batch-results" aria-label="批量照片与结果">
          <div className="batch-results-title"><h3>照片与结果</h3><span>{completeCount} 张已有结果</span></div>
          {storageError && <div role="alert" className="batch-error">{storageError}</div>}
          {restoring && <p className="batch-help">正在恢复本地结果记录…</p>}
          <div className="batch-selection-actions"><button disabled={locked || !rows.length} onClick={() => setSelected(new Set(rows.map(row => row.id)))}>全选</button><button disabled={locked || !selected.size} onClick={() => setSelected(new Set())}>取消选择</button><button disabled={locked || !completeCount} onClick={() => setSelected(new Set(rows.filter(row => row.resultId).map(row => row.id)))}>仅选已有结果</button><button disabled={locked || !selected.size} onClick={() => void remove()}><Trash2 size={13} />删除选中及本地结果</button></div>
          {summary && <div className="batch-progress" aria-live="polite"><div><strong>已处理 {summary.done} / {summary.total} 张</strong><span>成功 {summary.succeeded} · 跳过 {summary.skipped} · 失败 {summary.failed}{summary.cancelled ? ` · 取消 ${summary.cancelled}` : ''}</span></div><progress value={summary.done} max={Math.max(1, summary.total)} /></div>}
          {busy && <div className="batch-activity" role="status"><LoaderCircle size={16} className="batch-spin" /><span>{activity}</span></div>}
          <div className="batch-preview">
            <div className="batch-preview-tabs"><strong title={preview?.name}>{preview?.name || '选择照片查看'}</strong><div><button aria-pressed={previewMode === 'original'} disabled={busy || !preview || !files.current.has(preview.id)} onClick={() => setPreviewMode('original')}>原图</button><button aria-pressed={previewMode === 'result'} disabled={busy || !preview?.resultId} onClick={() => setPreviewMode('result')}>结果</button></div></div>
            <div className="batch-preview-image">{previewUrl ? <img src={previewUrl} alt={`${previewMode === 'original' ? '原图' : '精修结果'}：${preview?.name}`} data-testid="batch-preview-image" /> : <div><ImageIcon size={36} /><p>{previewError || '导入并选中照片后，可在这里对比原图和精修结果。'}</p></div>}</div>
            {preview && <div className="batch-preview-footer"><span>{preview.width && preview.height ? `${preview.width.toLocaleString()} × ${preview.height.toLocaleString()} px` : '从原图处理，保持原尺寸'}{preview.faceCount !== undefined ? ` · ${preview.faceCount} 张人脸` : ''}</span><button data-testid="batch-download-one" disabled={locked || !preview.resultId} onClick={() => void download(preview)}><Download size={14} />下载这一张</button></div>}
          </div>
          <div className="batch-photo-list" aria-label="批量照片列表">{rows.length ? rows.map(row => <div key={row.id} className={`batch-row ${previewId === row.id ? 'batch-row-active' : ''}`} data-testid={`batch-row-${row.id}`} data-status={row.status}>
            <input type="checkbox" checked={selected.has(row.id)} aria-label={`选择 ${row.name}`} disabled={locked} onChange={() => setSelected(previous => { const next = new Set(previous); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; })} />
            <button className="batch-row-main" disabled={busy} onClick={() => { setPreviewId(row.id); setPreviewMode(row.resultId ? 'result' : 'original'); }}><span className="batch-row-name">{row.name}</span><small>{files.current.has(row.id) ? '原图可用 · 每次从原图重算' : '本地恢复结果 · 无原图，不可重新处理'}{row.resultId && row.status !== 'succeeded' ? ' · 上次完成结果仍保留' : ''}</small>{row.reason && <p className={row.status === 'failed' ? 'batch-error-text' : ''}>{row.reason}</p>}{row.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</button><span className={`batch-status batch-status-${row.status}`}>{row.status === 'running' && <LoaderCircle size={12} className="batch-spin" />}{STATUS_TEXT[row.status]}</span>
          </div>) : <div className="batch-empty"><ImageIcon size={28} /><p>还没有照片，先添加几张原图试试。</p></div>}</div>
          {rows.length > 0 && <div className="batch-list-footer"><span>已选 {selectedRows.length} 张 · 可处理原图 {selectedOriginals.length} 张</span><button disabled={locked} onClick={() => void remove(true)}>清空列表与本地结果</button></div>}
        </section>
      </div>
    </div>
  </div>;
}
