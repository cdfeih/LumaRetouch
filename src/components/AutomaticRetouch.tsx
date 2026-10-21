import { Sparkles } from 'lucide-react';
import type { AutomaticRetouchProfile } from '../portrait/auto-retouch';
import type { AutomaticRetouchSession } from '../portrait/automatic-session';
import { PORTRAIT_FIELDS } from '../portrait/settings';
import './AutomaticRetouch.css';

export const AUTOMATIC_PROFILES: Array<{ id: AutomaticRetouchProfile; title: string; description: string }> = [
  { id: 'natural', title: '自然保真', description: '轻修皮肤、协调亮度，保留原有肤色与质感' },
  { id: 'bright', title: '人像通透', description: '在亮度与高光允许时适量提亮，避免一味美白' },
  { id: 'texture', title: '保纹理精修', description: '以中性灰光影为主，普通磨皮保持关闭' },
];
export function AutomaticRetouch({ disabled, profile, onProfileChange, onRun, report, onSpecialties }: {
  disabled: boolean; profile: AutomaticRetouchProfile; onProfileChange(profile: AutomaticRetouchProfile): void;
  onRun(): void; report?: AutomaticRetouchSession; onSpecialties(): void;
}) {
  const current = AUTOMATIC_PROFILES.find(item => item.id === profile)!;
  return <section className="automatic-retouch" aria-label="智能一键修图" data-testid="automatic-retouch">
    <div className="automatic-heading"><Sparkles size={17} /><strong>智能一键修图</strong><span>本地 · 无需 Key</span></div>
    <p>逐图分析光线与每张脸，再决定轻磨皮、小红点、肤色均匀、提亮、去油光和光影修饰的力度。默认保留脸型、身材与表情。</p>
    <div className="automatic-profiles" role="group" aria-label="智能修图方案">{AUTOMATIC_PROFILES.map(item => <button key={item.id} aria-pressed={profile === item.id} disabled={disabled} onClick={() => onProfileChange(item.id)}>{item.title}</button>)}</div>
    <small>{current.description}。方案会替换当前人物参数，塑形与五官细节归零。</small>
    <button className="button button-primary full-width" data-testid="automatic-run" disabled={disabled} onClick={onRun}><Sparkles size={16} />一键智能修图</button>
    {report && <div className="automatic-report" data-testid="automatic-report"><strong>本次实际执行</strong><p>{report.summary}</p><span>整体曝光：{report.exposure > 0 ? '+' : ''}{report.exposure} EV · {report.faces.length} 张脸</span>
      <details><summary>查看逐人物参数</summary>{report.faces.map((face, index) => <p key={index}><b>{face.label}</b>：{PORTRAIT_FIELDS.filter(field => face.settings[field.key] !== 0).map(field => `${field.label} ${face.settings[field.key]}`).join('、') || '本次保留原样'}</p>)}</details>
      {report.warnings.length > 0 && <details><summary>检查建议（{report.warnings.length}）</summary><ul>{report.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
      <small>同一底图可重新选择方案；下方人像参数已同步。检查 100% 细节后再导出。</small>
    </div>}
    <button className="automatic-specialties" disabled={disabled} onClick={onSpecialties}>手部、颈纹、衣物等专项点修 →</button>
    <p className="automatic-footnote">按像素统计给出保守建议；夜景、舞台光和特殊妆容请复核。复杂修复可另外使用云端点修。</p>
  </section>;
}
