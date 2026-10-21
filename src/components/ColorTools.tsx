import { useState } from 'react';
import { HSL_BANDS, hasAdvancedColor, normalizeAdvancedColor } from '../imaging/color';
import type { AdvancedColorSettings, HslBand } from '../imaging/color';
import './EditingTools.css';

const COLORS = { red: ['红色', '#e46c66'], orange: ['橙色', '#edaa6c'], yellow: ['黄色', '#ded070'], green: ['绿色', '#86b378'], aqua: ['青色', '#73b6b0'], blue: ['蓝色', '#769fd2'], purple: ['紫色', '#ac8dcc'], magenta: ['洋红', '#d786b2'] } as const;
export function ColorTools({ disabled, basicChanged, onApply }: { disabled: boolean; basicChanged: boolean; onApply(settings: AdvancedColorSettings): Promise<boolean> }) {
  const [settings, setSettings] = useState(() => normalizeAdvancedColor());
  const [band, setBand] = useState<HslBand>('orange');
  const range = (label: string, value: number, onChange: (value: number) => void, min = -100, max = 100) => <label className="slider-field"><span>{label}<output>{value > 0 ? '+' : ''}{value}</output></span><input type="range" aria-label={label} value={value} min={min} max={max} disabled={disabled} onChange={event => onChange(Number(event.target.value))} /></label>;
  const curve = settings.curve.length > 2 ? settings.curve : [0, .25, .5, .75, 1].map(x => ({ x, y: x }));
  return <div className="advanced-color">
    {(['shadows', 'highlights'] as const).map(key => <div key={key}>{range(key === 'shadows' ? '阴影' : '高光', settings[key], value => setSettings(previous => ({ ...previous, [key]: value })))}</div>)}
    <details><summary>HSL 分色调整 <small>肤色可先试橙色</small></summary><div className="hsl-bands">{HSL_BANDS.map(key => <button type="button" key={key} aria-label={`选择${COLORS[key][0]}通道`} aria-pressed={key === band} style={{ background: COLORS[key][1] }} disabled={disabled} onClick={() => setBand(key)} title={COLORS[key][0]} />)}</div>
      {(['hue', 'saturation', 'luminance'] as const).map((key, index) => <div key={key}>{range(`${COLORS[band][0]}${['色相', '饱和度', '明度'][index]}`, settings.hsl[band][key], value => setSettings(previous => ({ ...previous, hsl: { ...previous.hsl, [band]: { ...previous.hsl[band], [key]: value } } })))}</div>)}
    </details>
    <details><summary>RGB 曲线 <small>按明暗区微调</small></summary><svg className="curve-preview" viewBox="0 0 200 120" role="img" aria-label="当前亮度曲线"><path d="M0 120L200 0" stroke="#657358" strokeDasharray="4 4" /><polyline points={curve.map(point => `${point.x * 200},${120 - point.y * 120}`).join(' ')} fill="none" stroke="#c2e5a9" strokeWidth="2" /></svg>
      {curve.map((point, index) => <div key={point.x}>{range(`曲线${['黑场', '暗调', '中间调', '亮调', '白场'][index]}`, Math.round(point.y * 100), value => setSettings(previous => ({ ...previous, curve: curve.map((item, i) => i === index ? { ...item, y: value / 100 } : item) })), 0, 100)}</div>)}
      <div className="editing-inline-actions"><button disabled={disabled} onClick={() => setSettings(previous => ({ ...previous, curve: [{ x: 0, y: 0 }, { x: .25, y: .2 }, { x: .5, y: .5 }, { x: .75, y: .8 }, { x: 1, y: 1 }] }))}>柔和 S 曲线</button><button disabled={disabled} onClick={() => setSettings(previous => ({ ...previous, curve: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }))}>重置曲线</button></div>
    </details>
    <p className="property-help">本地 8bit sRGB 调色。先小幅调整，再应用和前后对比；不会补回原片已经过曝的细节。</p>
    <button className="button button-secondary full-width" disabled={disabled || (!basicChanged && !hasAdvancedColor(settings))} onClick={async () => { if (await onApply(settings)) setSettings(normalizeAdvancedColor()); }}>应用调色</button>
    <button className="editing-reset" disabled={disabled || !hasAdvancedColor(settings)} onClick={() => setSettings(normalizeAdvancedColor())}>重置高级调色</button>
  </div>;
}
