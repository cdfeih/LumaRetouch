/** User-editable cloud image-editing instructions, not dedicated retouch models. */
export interface SpecialtyTask {
  readonly id: string;
  readonly title: string;
  readonly category: 'skin' | 'clothes' | 'hair';
  readonly summary: string;
  readonly defaultMode: 'instruction';
  readonly prompt: string;
  readonly suggestedRadiusRatio: number;
  readonly scopeHint: string;
  readonly reviewHint: string;
  readonly limitation: string;
}

export const SPECIALTY_CATEGORIES = [
  { id: 'skin', label: '局部皮肤' },
  { id: 'clothes', label: '衣物整理' },
  { id: 'hair', label: '毛发整理' },
] as const;

const preservation = '只修改本次局部选区内的目标，保留自然纹理、原有肤色与光线。不改变人物五官、脸型、身体轮廓、手指数量和肢体姿势，不添加新物体。';
const task = (value: Omit<SpecialtyTask, 'defaultMode' | 'prompt'> & { prompt: string }): SpecialtyTask => Object.freeze({
  ...value, defaultMode: 'instruction', prompt: `${value.prompt}${preservation}`,
});

export const SPECIALTY_TASKS: readonly SpecialtyTask[] = Object.freeze([
  task({
    id: 'hand-skin', title: '手部肤色与小瑕疵', category: 'skin',
    summary: '减轻手背局部偏色、斑点，保留关节细节。', suggestedRadiusRatio: .025,
    prompt: '轻柔减淡这处手部明显偏色与小瑕疵，让色调与相邻皮肤自然衔接；保留掌纹、关节褶皱、指甲和正常高光，不统一涂白。',
    scopeHint: '先圈手背的一小块皮肤；避开指缝、指甲和手指边缘，分次修饰。单颗小痘点可先试本地“小瑕疵修补”。',
    reviewHint: '放大到 100% 检查指缝、关节纹理和肤色衔接。',
    limitation: '遮挡、失焦或过曝的手部细节无法可靠补回；模型可能误改指甲和关节。',
  }),
  task({
    id: 'neck-lines', title: '减淡颈纹', category: 'skin',
    summary: '减轻明显颈纹，保留转头产生的自然褶皱。', suggestedRadiusRatio: .02,
    prompt: '轻柔减淡这处过深的颈纹与局部色差，保留皮肤毛孔、自然褶皱和转头张力；不抹平成塑料质感，不改变颈部宽度、长度或下颌边缘。',
    scopeHint: '沿一条明显颈纹分段点选；给边缘留少量皮肤过渡，避开下颌、衣领和项链。',
    reviewHint: '对比颈纹深浅、下颌边缘和衣领，保留正常的皮肤起伏。',
    limitation: '深褶皱与硬阴影可能无法自然区分；不能保证减淡后仍完全保留原有立体感。',
  }),
  task({
    id: 'skin-sweat', title: '减轻皮肤汗珠', category: 'skin',
    summary: '处理局部汗珠与湿亮，保留正常皮肤高光。', suggestedRadiusRatio: .012,
    prompt: '轻柔减少这处皮肤表面明显的汗珠和湿亮反光，保留正常高光、毛孔与真实肤质，不去除珠宝或正常皮肤纹理，不整体压暗。',
    scopeHint: '一次只圈几颗汗珠或一小片湿亮；靠近眼睛、嘴唇和首饰时缩小半径。',
    reviewHint: '检查正常高光是否还在、皮肤是否出现重复纹理或局部变灰。',
    limitation: '汗珠与正常反光可能被混淆；已经过曝的皮肤纹理不能可靠恢复。',
  }),
  task({
    id: 'clothes-sweat', title: '减轻衣物汗渍', category: 'clothes',
    summary: '减淡布料上的局部汗渍，保留原本颜色。', suggestedRadiusRatio: .035,
    prompt: '减淡这处衣物上明显的汗渍与局部湿痕，使其与相邻干燥布料自然衔接；保留衣服颜色、布料纤维、接缝、印花和正常阴影，不改变服装款式。',
    scopeHint: '选汗渍中间的一小块并留少量干燥布料作过渡，分次处理；避开图案、纽扣和接缝。',
    reviewHint: '检查布料颜色是否一致，印花、接缝和正常腋下阴影是否保留。',
    limitation: '大面积湿透、复杂印花和深阴影可能出现色块；不能还原被遮住的真实布纹。',
  }),
  task({
    id: 'clothes-wrinkles', title: '减轻衣物褶皱', category: 'clothes',
    summary: '整理杂乱褶皱，保留正常垂坠与接缝。', suggestedRadiusRatio: .03,
    prompt: '减轻这处衣物杂乱、过深的褶皱，保留服装款式、接缝、布料纹理、印花与自然垂坠；不抹掉随动作形成的正常衣褶，不改变身体形状。',
    scopeHint: '圈一小段杂乱衣褶；避开纽扣、文字、印花与接缝，较长褶皱分段处理。',
    reviewHint: '检查布料纹理、文字图案、衣服轮廓和关节附近的自然衣褶。',
    limitation: '复杂图案或紧身布料可能失真；无法保证文字与细密纹理完全不变。',
  }),
  task({
    id: 'flyaway-hair', title: '整理碎发', category: 'hair',
    summary: '清理外侧零碎飞发，保留发型与发际线。', suggestedRadiusRatio: .012,
    prompt: '只清理这处明显偏离发型的少量零碎飞发，让后方背景自然衔接；保留原发型、发量、发际线和自然发丝，不增加头发，不改变头部轮廓。',
    scopeHint: '只圈外侧零碎飞发和少量邻近背景；不要把整片头发、发际线或耳朵圈入。',
    reviewHint: '检查头发边缘、耳朵与背景是否有糊边、缺口或重复纹理。',
    limitation: '密集发丝、透明发丝和复杂背景容易留痕；不是发丝分割或发型重建模型。',
  }),
  task({
    id: 'local-tattoo', title: '局部纹身处理', category: 'skin',
    summary: '减淡小块纹身，让相邻肤质自然衔接。', suggestedRadiusRatio: .025,
    prompt: '减淡这处小块纹身，使选区与相邻未纹身皮肤自然衔接；保留皮肤纹理、毛孔与正常光影，不改变肢体形状，不磨平周围皮肤。',
    scopeHint: '一次圈一小部分纹身并带少量周围皮肤；避开肢体轮廓、关节和衣物边缘。',
    reviewHint: '检查是否残留色块，皮肤纹理和肢体明暗是否连续。',
    limitation: '大面积、深色或跨关节纹身可能需要多次调整；不能找回纹身下方真实皮肤细节。',
  }),
  task({
    id: 'local-body-hair', title: '局部体毛整理', category: 'hair',
    summary: '减淡手臂或腿部小范围明显体毛。', suggestedRadiusRatio: .02,
    prompt: '轻柔减淡这处手臂或腿部过于醒目的少量体毛，保留自然皮肤纹理和少量正常细毛；不处理头发、眉毛或睫毛，不改变肢体粗细与轮廓。',
    scopeHint: '在手臂或腿部皮肤中间圈一小块，避开轮廓与衣物；不要用于头发、眉毛、睫毛。',
    reviewHint: '检查是否出现塑料皮肤、重复毛孔或肢体边缘变形。',
    limitation: '密集、逆光或跨轮廓体毛可能残留或糊边；不是专用体毛检测模型。',
  }),
]);

export function getSpecialtyTask(id: string | undefined): SpecialtyTask | undefined {
  return SPECIALTY_TASKS.find(item => item.id === id);
}

/** Original-image pixels; match the point-tool UI's 2..128 px and 12%-of-short-edge limits. */
export function suggestSpecialtyRadius(task: SpecialtyTask, width?: number, height?: number): number {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 24;
  const shorter = Math.min(width, height);
  const maximum = Math.max(2, Math.min(128, Math.floor(shorter * .12)));
  return Math.max(2, Math.min(maximum, Math.round(shorter * task.suggestedRadiusRatio)));
}
