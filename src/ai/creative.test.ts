import { describe, expect, it } from 'vitest';
import { buildCreativePrompt, buildRetouchPrompt, SKY_PRESETS, STYLE_PRESETS } from './index';
import type { RetouchTool } from './index';

describe('创意编辑输入约束', () => {
  it('添加内容必须同时有选区与具体描述，追色必须有参考图', () => {
    expect(() => buildCreativePrompt({ tool: 'add', strength: 50, customPrompt: '一只橘猫' })).toThrow('涂抹');
    expect(() => buildCreativePrompt({ tool: 'add', strength: 50, hasSelection: true, customPrompt: ' \n ' })).toThrow('描述');
    expect(() => buildCreativePrompt({ tool: 'match', strength: 50 })).toThrow('参考图');
    expect(() => buildCreativePrompt({ tool: 'remove', strength: 50 })).toThrow('涂抹');
    expect(() => buildCreativePrompt({ tool: 'style', strength: 50, styleId: 'missing' })).toThrow('风格预设');
    expect(() => buildCreativePrompt({ tool: 'sky', strength: 50, skyId: 'missing' })).toThrow('天空预设');
  });

  it('添加只作用于选区；追色不复制参考主体或构图', () => {
    const adding = buildCreativePrompt({ tool: 'add', strength: 65, customPrompt: '一只趴着的橘猫', hasSelection: true });
    expect(adding).toContain('一只趴着的橘猫');
    expect(adding).toContain('严格保护选区外所有内容');
    expect(adding).toContain('透视、尺寸、遮挡、光线与接触阴影');
    const matching = buildCreativePrompt({ tool: 'match', strength: 45, hasReference: true });
    expect(matching).toContain('第 2 张风格参考图');
    expect(matching).toContain('不复制参考图中的人物、服装、物体、文字、背景、构图或场景');
    expect(matching).toContain('不改变人物身份、服装、几何形状或构图');
  });

  it('去路人保护前景主体，并可进一步限制于选区', () => {
    const automatic = buildCreativePrompt({ tool: 'people', strength: 45 });
    expect(automatic).toContain('默认保护前景主体、主要人物及其随行者');
    expect(automatic).toContain('不能确定是否是路人的人物应保留');
    const selected = buildCreativePrompt({ tool: 'people', strength: 45, hasSelection: true });
    expect(selected).toContain('只移除涂抹选区内的背景路人');
    expect(selected).toContain('选区外所有像素必须保持原样');
  });

  it('换天只修改真实天空并考虑边缘、反射及场景无天空的情况', () => {
    const prompt = buildCreativePrompt({ tool: 'sky', strength: 60, skyId: 'golden-hour' });
    expect(prompt).toContain('金色时刻');
    expect(prompt).toContain('只替换真实天空');
    expect(prompt).toContain('树梢、发丝、建筑');
    expect(prompt).toContain('玻璃/水面反射');
    expect(prompt).toContain('没有可见天空时不要凭空生成天空');
    expect(buildCreativePrompt({ tool: 'sky', strength: 60, hasSelection: true })).toContain('光线适配也不能越过选区');
  });
});

describe('摄影与艺术风格范围', () => {
  it('8 种预设具备可用色卡且无重复 ID，5 种天空同样完整', () => {
    expect(STYLE_PRESETS.map(preset => preset.name)).toEqual(['日系通透', '夏日青绿', '低饱和胶片', '森系柔光', '冷调街头', '暖调电影', '治愈手绘动画', '清透水彩']);
    for (const presets of [STYLE_PRESETS, SKY_PRESETS]) {
      expect(new Set(presets.map(preset => preset.id)).size).toBe(presets.length);
      for (const preset of presets) {
        expect(preset.colors).toHaveLength(3);
        expect(preset.colors.every(color => /^#[0-9a-f]{6}$/i.test(color))).toBe(true);
        expect(preset.description.length).toBeGreaterThan(5);
      }
    }
  });

  it('摄影预设只调影调与细微纹理，不重构人物或场景', () => {
    for (const style of STYLE_PRESETS.filter(preset => preset.category === 'photo')) {
      const prompt = buildCreativePrompt({ tool: 'style', strength: 50, styleId: style.id });
      expect(prompt).toContain('仅调整色调、明暗、对比度、光线观感和细微颗粒纹理');
      expect(prompt).toContain('不得添加、移除或重构对象');
      expect(prompt).toContain('不更改人物身份、服装或构图');
      expect(prompt).not.toContain('本次允许将照片转绘');
    }
  });

  it('艺术预设允许转绘但保留辨识与构图，不附加相互冲突的摄影守护词', () => {
    for (const style of STYLE_PRESETS.filter(preset => preset.category === 'art')) {
      const prompt = buildCreativePrompt({ tool: 'style', strength: 80, styleId: style.id });
      expect(prompt).toContain('本次允许将照片转绘');
      expect(prompt).toContain('保留原人物辨识度、服装与场景构图');
      expect(prompt).not.toMatch(/保持自然摄影质感|保留摄影质感|不把照片转为插画|避免.*重绘/);
      expect(prompt).toContain('手绘');
    }
    expect(buildCreativePrompt({ tool: 'style', strength: 70, styleId: 'healing-animation' })).toContain('蓬松云朵');
  });

  it('力度边界与旧版工具兼容，新增工具不改变老功能语义', () => {
    expect(buildCreativePrompt({ tool: 'sky', strength: 200 })).toContain('编辑力度：100/100');
    expect(buildCreativePrompt({ tool: 'people', strength: -10 })).toContain('编辑力度：0/100');
    expect(buildCreativePrompt({ tool: 'style', strength: Number.NaN })).toContain('编辑力度：40/100');
    expect(buildRetouchPrompt('remove', 50)).toContain('严格保护选区外所有内容');
    expect(buildRetouchPrompt('smooth', 40)).toContain('保留毛孔');
    expect(buildRetouchPrompt('blemish', 40)).toContain('保留正常毛孔、雀斑、痣');
    expect(() => buildCreativePrompt({ tool: 'unknown' as RetouchTool, strength: 50 })).toThrow('不支持');
  });
});
