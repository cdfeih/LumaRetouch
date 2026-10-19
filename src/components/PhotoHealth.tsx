import { useEffect, useId, useRef, useState } from 'react';
import { Activity, ChevronDown, LoaderCircle, RotateCw, Sparkles } from 'lucide-react';
import { analyzePhoto } from '../imaging/analysis';
import type { PhotoAnalysis } from '../imaging/analysis';
import './PhotoHealth.css';

export interface PhotoHealthProps {
  source: string;
  disabled: boolean;
  onApplyExposure(exposure: number): void | Promise<void>;
}

type AnalysisState = {
  source: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  report?: PhotoAnalysis;
  error?: string;
};

export function PhotoHealth({ source, disabled, onApplyExposure }: PhotoHealthProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AnalysisState>({ source, status: 'idle' });
  const [applying, setApplying] = useState(false);
  const job = useRef<AbortController | null>(null);
  const application = useRef<symbol | null>(null);
  const panelId = useId();
  const histogramId = useId();
  const current = state.source === source ? state : { source, status: 'idle' as const };
  const report = current.report;
  const loading = current.status === 'loading';

  useEffect(() => {
    job.current?.abort(); job.current = null;
    application.current = null;
    setApplying(false);
    setState({ source, status: 'idle' });
    return () => { job.current?.abort(); job.current = null; application.current = null; };
  }, [source]);

  useEffect(() => {
    if (disabled && job.current) {
      job.current.abort(); job.current = null;
      setState(previous => previous.status === 'loading' ? { source, status: 'idle' } : previous);
    }
  }, [disabled, source]);

  function toggle() {
    if (open && job.current) {
      job.current.abort(); job.current = null;
      setState({ source, status: 'idle' });
    }
    setOpen(previous => !previous);
  }

  async function inspect() {
    if (!source || disabled || job.current || applying) return;
    const controller = new AbortController(); job.current = controller;
    setState({ source, status: 'loading' });
    try {
      const result = await analyzePhoto(source, controller.signal);
      if (controller.signal.aborted || job.current !== controller) return;
      setState({ source, status: 'ready', report: result });
    } catch (error) {
      if (controller.signal.aborted || job.current !== controller) return;
      setState({ source, status: 'error', error: error instanceof Error ? error.message : '照片体检失败，请重试。' });
    } finally {
      if (job.current === controller) job.current = null;
    }
  }

  async function applySuggestion() {
    if (disabled || loading || applying || !report?.suggestedExposure) return;
    const id = Symbol('photo-health-exposure'); application.current = id;
    setApplying(true);
    try { await onApplyExposure(report.suggestedExposure); }
    catch (error) {
      if (application.current === id) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : '未能应用亮度建议，请重试。' }));
    } finally {
      if (application.current === id) { application.current = null; setApplying(false); }
    }
  }

  const exposureLabel = report ? `${report.suggestedExposure > 0 ? '+' : ''}${report.suggestedExposure.toFixed(1)} EV` : '';
  const maximum = report ? Math.max(1, ...report.histogram) : 1;

  return <section className="photo-health" data-testid="photo-health">
    <button className="photo-health-toggle" type="button" aria-expanded={open} aria-controls={panelId} disabled={disabled} onClick={toggle}>
      <Activity size={16} /><span><strong>照片体检</strong><small>检查亮度与分辨率 · 本地免费</small></span><ChevronDown size={16} className={open ? 'photo-health-expanded' : ''} />
    </button>
    {open && <div className="photo-health-content" id={panelId}>
      {!source && <p className="photo-health-copy">先导入一张照片，再检查亮度和分辨率。</p>}
      {source && current.status === 'idle' && <p className="photo-health-copy">不确定照片该怎么调？先查看亮度分布，再决定是否调整曝光。</p>}
      {loading && <p className="photo-health-loading" role="status"><LoaderCircle className="spin" size={16} />正在本机分析照片…</p>}
      {current.error && <p className="photo-health-error" role="alert">{current.error}</p>}
      {report && <div className="photo-health-report" data-testid="photo-health-report">
        <div className="photo-health-chart">
          <svg viewBox="0 0 256 80" role="img" aria-labelledby={histogramId}>
            <title id={histogramId}>照片亮度直方图，左侧是暗部，右侧是亮部，柱高表示像素数量</title>
            <line x1="0" y1="72" x2="256" y2="72" className="photo-health-axis" />
            {report.histogram.map((value, index) => <rect key={index} x={index * 4} y={72 - value / maximum * 64} width="3.5" height={value / maximum * 64} rx="0.7" />)}
          </svg>
          <div className="photo-health-chart-labels"><span>暗部</span><span>亮部</span></div>
        </div>
        <dl className="photo-health-facts">
          <div><dt>原图分辨率</dt><dd>{report.width.toLocaleString()} × {report.height.toLocaleString()} px</dd></div>
          <div><dt>暗部接近纯黑</dt><dd>{(report.shadowClipped * 100).toFixed(1)}%</dd></div>
          <div><dt>高光接近纯白</dt><dd>{(report.highlightClipped * 100).toFixed(1)}%</dd></div>
        </dl>
        {report.warnings.length > 0 && <ul className="photo-health-warnings">{report.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
        {report.suggestedExposure !== 0
          ? <button className="photo-health-suggestion" type="button" disabled={disabled || loading || applying} onClick={() => void applySuggestion()}><Sparkles size={15} />{applying ? '正在应用建议…' : `应用亮度建议（${exposureLabel}）`}</button>
          : <p className="photo-health-neutral">暂不建议统一调整曝光，可先检查人物和局部细节。</p>}
      </div>}
      {!loading && <button className="photo-health-inspect" data-testid="photo-health-inspect" type="button" disabled={!source || disabled || applying} onClick={() => void inspect()}>{report ? <RotateCw size={13} /> : <Activity size={13} />}{report ? '重新体检' : current.status === 'error' ? '重试照片体检' : '开始照片体检'}</button>}
      <p className="photo-health-disclaimer">仅在本机做亮度统计，不上传照片。建议需结合场景判断，不能找回原片已经丢失的细节。</p>
    </div>}
  </section>;
}
