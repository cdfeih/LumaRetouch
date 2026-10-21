import type { PortraitSettings } from '../portrait/settings';

export type BatchAutomaticProfile = 'natural' | 'bright' | 'texture';
/** Compact accepted-result metadata. No face landmarks, thumbnails, or shared/global preset are implied. */
export interface BatchAutomaticSummary {
  profile: BatchAutomaticProfile;
  exposure: number;
  summary: string;
  subjects: Array<{ label: string; settings: PortraitSettings }>;
  steps: string[];
  warnings: string[];
}
export const BATCH_AUTOMATIC_PROFILES: ReadonlyArray<{ id: BatchAutomaticProfile; name: string; description: string }> = [
  { id: 'natural', name: '智能自然', description: '逐张分析亮度、可用面部皮肤和瑕疵迹象，为各张脸安排保守修饰；保持人物原有轮廓。' },
  { id: 'bright', name: '智能通透', description: '按每张照片亮度与各脸局部阴影、泛红迹象安排轻提亮与修匀；高光风险较高时不继续推亮。' },
  { id: 'texture', name: '智能保纹理', description: '逐脸评估明暗不匀，优先安排中性灰光影辅助，限制普通磨皮；不保证恢复毛孔或严重瑕疵。' },
];
