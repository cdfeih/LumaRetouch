import { useId } from 'react';
import { SPECIALTY_CATEGORIES, SPECIALTY_TASKS, getSpecialtyTask } from '../point-retouch/tasks';
import type { SpecialtyTask } from '../point-retouch/tasks';
import './SpecialtyTasks.css';

export interface SpecialtyTasksProps {
  onSelect(task: SpecialtyTask): void;
  disabled?: boolean;
  selectedTaskId?: string;
}

/** Selecting a task only prepares instructions; the host owns selection and execution. */
export function SpecialtyTasks({ onSelect, disabled = false, selectedTaskId }: SpecialtyTasksProps) {
  const titleId = useId();
  const selected = getSpecialtyTask(selectedTaskId);
  return <section className="specialty-tasks" data-testid="specialty-tasks" aria-labelledby={titleId}>
    <div className="specialty-heading"><h3 id={titleId}>局部专项修饰</h3><span>云端模板</span></div>
    <p className="specialty-intro">用一段要求处理一小处问题。这些是<strong>云端局部图像编辑模板，并非专用模型</strong>。</p>
    <details className="specialty-help">
      <summary>不知道该选哪个功能？</summary>
      <ul>
        <li>先试「一键智能修图」：按照片决定皮肤与光影修饰力度，默认不改变脸型或身材。</li>
        <li>单颗小痘点先用本地「小瑕疵修补」；有干净纹理可用「指定供样修补」，都无需 API Key。</li>
        <li>手部、颈纹、衣物或碎发需要单独处理时，再选择下面的云端模板；明显曝光、偏色先用基础调色。</li>
      </ul>
    </details>
    {SPECIALTY_CATEGORIES.map(category => <div className="specialty-group" key={category.id}>
      <h4>{category.label}</h4>
      <div className="specialty-options">{SPECIALTY_TASKS.filter(item => item.category === category.id).map(item => <button
        type="button" key={item.id} data-testid={`specialty-task-${item.id}`} aria-pressed={selected?.id === item.id}
        disabled={disabled} onClick={() => { if (!disabled) onSelect(item); }}
      ><strong>{item.title}</strong><span>{item.summary}</span></button>)}</div>
    </div>)}
    {selected ? <div className="specialty-selected" data-testid="specialty-task-guide" aria-live="polite" aria-atomic="true">
      <h4>{selected.title} · 先圈一小处</h4>
      <p><strong>建议范围</strong>{selected.scopeHint}</p>
      <p className="specialty-radius">半径起点约为照片短边的 {Number((selected.suggestedRadiusRatio * 100).toFixed(1))}%，受画笔上限限制；可手动缩小并分次处理。</p>
      <ol><li>在照片上点选或涂选目标，绿色范围内允许修改；红色保护区优先保留。</li><li>检查并修改下方点修要求，再点击「开始云端点修」。</li><li>{selected.reviewHint}不满意可撤销，缩小范围后重试。</li></ol>
      <details><summary>查看此模板的默认要求</summary><p className="specialty-prompt">{selected.prompt}</p></details>
      <p className="specialty-limit"><strong>效果边界</strong>{selected.limitation}</p>
    </div> : <p className="specialty-empty">选择一项会填写点修要求并建议半径，然后在照片上圈选位置。</p>}
    <p className="specialty-cloud-note">选择模板不会上传照片或开始计费。点击「开始云端点修」后才会发送照片到所选模型，按服务商规则计费；模型仍可能误改细节，请在 100% 下复核。</p>
  </section>;
}
