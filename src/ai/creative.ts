import { RetouchError } from './errors';
import type { RetouchTool } from './types';

export interface StylePreset {
  id: string;
  name: string;
  category: 'photo' | 'art';
  description: string;
  prompt: string;
  colors: [string, string, string];
}

export interface SkyPreset {
  id: string;
  name: string;
  description: string;
  prompt: string;
  colors: [string, string, string];
}

export const STYLE_PRESETS: StylePreset[] = [
  { id: 'japanese-clear', name: '日系通透', category: 'photo', description: '干净高光、柔和肤色与轻盈空气感', prompt: '日系通透摄影调色：轻盈干净的高光，柔和对比，略暖的自然肤色，清淡的蓝与青，通透明亮但不溢出曝光，保留阴影层次。', colors: ['#dbe9e7', '#a6c6c5', '#f1d5bc'] },
  { id: 'summer-green', name: '夏日青绿', category: 'photo', description: '清爽青绿、明亮日光和夏日气息', prompt: '夏日青绿摄影调色：清爽的青绿色植被，柔暖日光，淡蓝天空，适度鲜活的色彩；避免荧光绿与过饱和，保持真实肤色。', colors: ['#b8d5b3', '#75b8b0', '#f3e3b2'] },
  { id: 'muted-film', name: '低饱和胶片', category: 'photo', description: '克制色彩、柔和反差与细腻颗粒', prompt: '低饱和胶片摄影调色：克制的中低饱和度，柔和肩部高光与阴影过渡，轻微暖灰调，少量细腻胶片颗粒；保留清晰主体，不添加边框、日期或文字。', colors: ['#c6bcb0', '#8b9890', '#b0a59a'] },
  { id: 'forest-soft', name: '森系柔光', category: 'photo', description: '柔润绿色、漫射光与安静氛围', prompt: '森系柔光摄影调色：柔润自然的绿色和柔和漫射高光，空气感与适度低反差，温润肤色、清晰眼神与柔和暗部；不添加树木、雾气或新的植物。', colors: ['#d4dfc0', '#8fa38a', '#eadbc8'] },
  { id: 'cool-street', name: '冷调街头', category: 'photo', description: '冷青阴影、克制高光与城市质感', prompt: '冷调街头摄影调色：冷青色阴影、克制的中性色高光、适量结构对比和细微颗粒；肤色保持自然，避免全图偏蓝或丢失暗部细节。', colors: ['#718f9d', '#adb7b4', '#3c535f'] },
  { id: 'warm-cinema', name: '暖调电影', category: 'photo', description: '琥珀光影、柔和高光与电影层次', prompt: '暖调电影摄影调色：温暖琥珀高光、轻微冷青暗部、细腻的明暗层次，适当压低过亮高光，保持自然肤色与胶片般柔和质感。', colors: ['#dcaf76', '#ad8265', '#5f7c7d'] },
  { id: 'healing-animation', name: '治愈手绘动画', category: 'art', description: '手绘背景、柔软云朵与温暖自然光', prompt: '将照片转绘为温暖治愈的手绘动画画面：细腻手绘背景、柔和线稿和不完全均匀的笔触，温暖自然光，轻盈色块；画面原有植被可表现为葱绿层次，原有天空可表现为蓬松云朵。保留人物辨识、原有服装、姿态、物体关系与构图，仅在原有天空范围内重绘云朵，不扩展天空范围或加入新角色及无关主体。', colors: ['#a7cb80', '#a8d8ec', '#f1d89a'] },
  { id: 'clear-watercolor', name: '清透水彩', category: 'art', description: '透明叠色、轻柔晕染与细腻纸感', prompt: '将照片转绘为清透水彩插画：透明叠色、轻柔晕染、少量细腻纸张纹理与自然留白，重点五官和轮廓仍清楚可辨，保留原有服装、姿态、主体关系与构图，不增加无关物体。', colors: ['#c4dcd9', '#f1cfbb', '#d2c5df'] },
];

export const SKY_PRESETS: SkyPreset[] = [
  { id: 'blue-clouds', name: '晴空白云', description: '清澈蓝天与自然积云', prompt: '替换为清澈自然的蓝天与疏朗白色积云，云朵尺度和远近关系符合原照片视角。', colors: ['#65abe0', '#b7d9ee', '#f7fbfc'] },
  { id: 'golden-hour', name: '金色日落', description: '柔和金光与暖橙色晚霞', prompt: '替换为金色时刻的柔和日落天空，暖橙色薄云，太阳方向遵循原照片主光方向，避免强烈刺眼的假光源。', colors: ['#f3c36f', '#ee9d73', '#c4b3bd'] },
  { id: 'pink-dusk', name: '粉紫暮色', description: '克制的粉紫云霞与宁静暮光', prompt: '替换为宁静的粉紫暮色与层次细腻的晚霞，颜色克制真实，保留天空纵深，避免过饱和和不符合场景的巨大云团。', colors: ['#c0b3dc', '#e8bac9', '#f2d0bd'] },
  { id: 'dramatic-clouds', name: '层云光隙', description: '富有层次的云层与柔和光隙', prompt: '替换为富有层次的自然云层与柔和光隙，明暗方向符合原场景，保留细节而不过分 HDR 化，不添加闪电或不必要的极端天气。', colors: ['#657d92', '#aebfca', '#eadbbb'] },
  { id: 'starry-night', name: '静谧星空', description: '深蓝夜空与细小自然星点', prompt: '替换为深蓝色静谧夜空，少量细小且尺度合理的自然星点与很淡的银河氛围，避免巨大月亮、夸张星轨或科幻天体。', colors: ['#273d64', '#63739a', '#cbcbdc'] },
];

export interface CreativePromptInput {
  tool: RetouchTool;
  strength: number;
  customPrompt?: string;
  styleId?: string;
  skyId?: string;
  hasSelection?: boolean;
  /** 与用户绿色编辑选区区分：只有保护时，其他区域仍可自由布局。 */
  hasProtection?: boolean;
  hasReference?: boolean;
}

/** 输入校验与编辑语义同处，避免无参考追色或无目标生成被误提交。 */
export function buildCreativePrompt(input: CreativePromptInput): string {
  const { tool, hasSelection = false, hasProtection = false, hasReference = false } = input;
  const custom = input.customPrompt?.trim().slice(0, 1500) ?? '';
  const amount = Math.round(Math.max(0, Math.min(100, Number.isFinite(input.strength) ? input.strength : 40)));
  if (tool === 'remove' && !hasSelection) throw new RetouchError('INPUT', '先涂抹要移除的物体。');
  if (tool === 'add' && !custom) throw new RetouchError('INPUT', '请描述希望添加什么内容。');
  if (tool === 'match' && !hasReference) throw new RetouchError('INPUT', '请先导入用于追色的风格参考图。');
  const identity = '请只返回第 1 张待修图片的编辑结果。保持原始人物身份、五官比例、脸型、年龄、表情、姿势、服装、主体关系、构图和画幅，不裁剪或移动画面。';
  let task: string;
  let renderGuard = '保持自然摄影质感与真实纹理，避免蜡像感或不必要的重绘。';
  switch (tool) {
    case 'smooth': task = '对人物皮肤做自然磨皮：减轻皮肤粗糙和局部肤色不匀，保留毛孔、细小纹理和自然明暗。避免蜡像感、塑料感及过度美白。只编辑皮肤，不修改眼睛、眉毛、嘴唇、头发、衣物和背景。'; break;
    case 'blemish': task = '识别并清除临时痘痘、小面积泛红和明显的小瑕疵，使用周围真实皮肤纹理自然修复。保留正常毛孔、雀斑、痣、胎记及身份特征，不做全脸模糊。'; break;
    case 'remove': task = '只移除用户涂抹选区（mask）内的目标物体，以相邻背景、纹理、光线和透视补全空缺。严格保护选区外所有内容；不要增加新主体，不把遮罩图或涂抹标记画入结果。'; break;
    case 'people': task = `去除背景中的路人或游客，以邻近背景结构自然修复遮挡区域。默认保护前景主体、主要人物及其随行者，保留主要人物的身份、服装和身体细节；不能确定是否是路人的人物应保留。${hasSelection ? '此次只移除涂抹选区内的背景路人，不触碰选区外人物。' : '只移除明确属于背景的非主体路人，不删除前景主体。'}`; break;
    case 'add': {
      const scope = hasSelection
        ? '仅在用户涂抹的选区内，按补充要求添加指定内容。根据选区可用空间合理安排大小，不以选区边缘切断新增主体。严格保护选区外所有内容，不擅自新增选区外对象。'
        : '用户未指定绿色编辑选区：根据补充要求自主安排新增内容的位置、大小与前后遮挡，不受绿色选区限制。尽量保留与任务无关的原有内容，仅做完成本次添加或互动所需的修改。';
      task = `${scope}正确匹配原照片的透视、尺寸、遮挡、光线与接触阴影。新增主体应完整呈现：人物或动物须保留完整头部、身体及必要的四肢，不能只生成局部躯干来满足放大要求。用户要求拥抱等互动时，按描述安排前后遮挡，允许新物体自然遮住原主体的局部衣物，但不要重绘原人物的脸或移动头部，未被遮挡的服装与姿态仍应保留；不以拼接断肢代替完整肢体。不移动已有主体，不把涂抹标记画入结果。`;
      break;
    }
    case 'sky': {
      const sky = input.skyId ? SKY_PRESETS.find(preset => preset.id === input.skyId) : SKY_PRESETS[0];
      if (!sky) throw new RetouchError('INPUT', '没有找到所选天空预设，请重新选择。');
      task = `天空替换：${sky.prompt}只替换真实天空，精细处理树梢、发丝、建筑等天空边缘，保留地面与前景主体。仅为融入新天空而适配必要的边缘色溢、玻璃/水面反射和光线过渡，不改变建筑结构、地貌或人物。原照片没有可见天空时不要凭空生成天空。`;
      break;
    }
    case 'style': {
      const style = input.styleId ? STYLE_PRESETS.find(preset => preset.id === input.styleId) : STYLE_PRESETS[0];
      if (!style) throw new RetouchError('INPUT', '没有找到所选风格预设，请重新选择。');
      task = `风格预设「${style.name}」：${style.prompt}`;
      renderGuard = style.category === 'art'
        ? '本次允许将照片转绘为手绘、动画或插画视觉语言，允许改变笔触、轮廓表现和材质；同时保留原人物辨识度、服装与场景构图。'
        : '仅调整色调、明暗、对比度、光线观感和细微颗粒纹理，保留摄影质感。不得添加、移除或重构对象，不更改人物身份、服装或构图，不把照片转为插画。';
      break;
    }
    case 'match': task = '将第 2 张风格参考图的色调、色彩关系、白平衡、明暗对比和光线氛围迁移到第 1 张待修照片。只追色和匹配影调，不复制参考图中的人物、服装、物体、文字、背景、构图或场景，不生成参考图中的新主体。'; renderGuard = '仅调整颜色、明暗、光线观感与细微颗粒纹理，保留原照片的自然肤色和摄影质感，不改变人物身份、服装、几何形状或构图。'; break;
    default: throw new RetouchError('INPUT', '不支持的修图工具。');
  }
  const selectionGuard = hasSelection ? '随附选区为本次唯一可编辑范围。选区外所有像素必须保持原样，即使是风格转换、天空反光或光线适配也不能越过选区。' : '';
  const protectionGuard = hasProtection ? '随附蒙版标明了不可编辑的保护区，保护区优先于任何生成要求，必须保留原有像素与位置。未指定绿色编辑选区时，保护区以外可按任务自由布局，保护区不是新物体的放置范围。' : '';
  const referenceGuard = hasReference && tool !== 'match' ? '第 2 张图仅为风格/色调参考，只按本任务允许的范围迁移视觉表现，不复制参考图中的人物、服装、主体或构图。' : '';
  return [identity, renderGuard, task, referenceGuard, selectionGuard, protectionGuard, `编辑力度：${amount}/100；0 表示保持原图，100 仍须保持主体辨识与编辑范围。`, custom ? `补充要求：${custom}\n以上身份、构图和选区保护约束始终适用。` : ''].filter(Boolean).join('\n');
}

/** 保留 0.1 调用合同：去物调用方已负责实际 mask 校验。 */
export function buildRetouchPrompt(tool: 'smooth' | 'blemish' | 'remove', strength: number, customPrompt = ''): string {
  return buildCreativePrompt({ tool, strength, customPrompt, hasSelection: tool === 'remove' });
}
