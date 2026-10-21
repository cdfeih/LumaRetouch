export type SpotPoint = { x: number; y: number };
export type SpotDonorImage = SpotPoint & { pixels: Uint8ClampedArray; width: number; height: number };
export type SpotPixelOptions = SpotPoint & { radius: number; sourcePoint?: SpotPoint; donorImage?: SpotDonorImage; protectionAlpha?: Uint8Array | Uint8ClampedArray; signal?: AbortSignal };
export type SpotPixelResult = { pixels: Uint8ClampedArray; changedPixels: number; warning?: string; sourcePoint?: SpotPoint };
type Color = { r: number; g: number; b: number; l: number };
type Ring = { mean: Color; deviation: number; edge: boolean };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const luminance = (r: number, g: number, b: number) => r * .2126 + g * .7152 + b * .0722;
const distanceColor = (a: Color, b: Color) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('已取消本地点修。', 'AbortError'); };
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function read(pixels: Uint8ClampedArray, width: number, height: number, x: number, y: number): Color | null {
  const px = Math.round(x), py = Math.round(y);
  if (px < 0 || py < 0 || px >= width || py >= height) return null;
  const i = (py * width + px) * 4;
  if (pixels[i + 3] < 255) return null;
  const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
  return { r, g, b, l: luminance(r, g, b) };
}

function ring(pixels: Uint8ClampedArray, width: number, height: number, point: SpotPoint, radius: number): Ring | null {
  const colors: Color[] = [], sectors: Color[][] = [[], [], [], []];
  for (let i = 0; i < 32; i++) {
    const angle = i / 32 * Math.PI * 2;
    const color = read(pixels, width, height, point.x + Math.cos(angle) * radius * .96, point.y + Math.sin(angle) * radius * .96);
    if (!color) return null;
    colors.push(color); sectors[Math.floor(i / 8)].push(color);
  }
  const average = (values: Color[]): Color => ({
    r: values.reduce((sum, value) => sum + value.r, 0) / values.length,
    g: values.reduce((sum, value) => sum + value.g, 0) / values.length,
    b: values.reduce((sum, value) => sum + value.b, 0) / values.length,
    l: values.reduce((sum, value) => sum + value.l, 0) / values.length,
  });
  const mean = average(colors), sectorsMean = sectors.map(average);
  const deviation = Math.sqrt(colors.reduce((sum, color) => sum + (color.l - mean.l) ** 2, 0) / colors.length);
  const abrupt = colors.filter((color, index) => Math.abs(color.l - colors[(index + 1) % colors.length].l) > 45).length;
  const edge = Math.max(distanceColor(sectorsMean[0], sectorsMean[2]), distanceColor(sectorsMean[1], sectorsMean[3])) > 68 || deviation > 33 || abrupt >= 4;
  return { mean, deviation, edge };
}

function donorCenterDeviation(pixels: Uint8ClampedArray, width: number, height: number, point: SpotPoint, radius: number, mean: Color): number {
  let difference = 0, strongest = 0;
  for (const dx of [-.3, 0, .3]) for (const dy of [-.3, 0, .3]) {
    const color = read(pixels, width, height, point.x + radius * dx, point.y + radius * dy);
    if (!color) return Infinity;
    const colorDifference = distanceColor(color, mean) / Math.sqrt(3);
    difference += colorDifference; strongest = Math.max(strongest, colorDifference);
  }
  // A red blemish may have the same luminance as clean skin. Reject strong chroma
  // outliers too, including a small dirty point at the center of a donor patch.
  return Math.max(difference / 9, strongest * .65);
}

/** Local texture transfer only. Pixel coordinates are used inside this pure worker-free kernel. */
export async function repairSpotPixels(pixels: Uint8ClampedArray, width: number, height: number, options: SpotPixelOptions): Promise<SpotPixelResult> {
  abort(options.signal);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || pixels.length !== width * height * 4
    || ![options.x, options.y, options.radius].every(Number.isFinite) || options.x < 0 || options.y < 0 || options.x >= width || options.y >= height || options.radius < 2 || options.radius > 192
    || options.protectionAlpha && options.protectionAlpha.length !== width * height) throw new Error('点修像素或画笔参数无效。');
  const unchanged = (warning?: string): SpotPixelResult => ({ pixels, changedPixels: 0, warning });
  const target = { x: options.x, y: options.y }, radius = options.radius;
  const donorImage = options.donorImage;
  if (donorImage && (!options.sourcePoint || donorImage.pixels.length !== donorImage.width * donorImage.height * 4 || ![donorImage.x, donorImage.y].every(Number.isFinite))) throw new Error('点修供样数据无效。');
  const donorPixels = donorImage?.pixels ?? pixels, donorWidth = donorImage?.width ?? width, donorHeight = donorImage?.height ?? height;
  const targetRing = ring(pixels, width, height, target, radius);
  if (!targetRing) return unchanged('目标贴近图片或透明边界，请缩小画笔并把修复中心移到不透明区域。');
  if (targetRing.edge) return unchanged('画笔跨过明显的明暗、发际或物体边缘，本次未修改。请缩小画笔，避免覆盖五官和轮廓。');
  let donor: SpotPoint | undefined, donorRing: Ring | undefined;
  if (options.sourcePoint) {
    const point = options.sourcePoint;
    if (![point.x, point.y].every(Number.isFinite) || Math.hypot(point.x - target.x, point.y - target.y) < radius * 2.1) return unchanged('供样点与目标太近或无效，请选择至少两个画笔半径以外的干净纹理。');
    const samplePoint = donorImage ? { x: donorImage.x, y: donorImage.y } : point;
    const sample = ring(donorPixels, donorWidth, donorHeight, samplePoint, radius);
    if (!sample || sample.edge || distanceColor(sample.mean, targetRing.mean) > 85) return unchanged('供样区域跨边缘、透明边界或与目标色差过大，请重新选择相近肤色与纹理。');
    donor = samplePoint; donorRing = sample;
  } else {
    let bestScore = Infinity;
    for (const multiple of [2.5, 3.5, 4.75]) for (let direction = 0; direction < 16; direction++) {
      abort(options.signal);
      const angle = direction / 16 * Math.PI * 2;
      const point = { x: target.x + Math.cos(angle) * radius * multiple, y: target.y + Math.sin(angle) * radius * multiple };
      const sample = ring(pixels, width, height, point, radius);
      if (!sample || sample.edge) continue;
      const colorDifference = distanceColor(sample.mean, targetRing.mean);
      const centerDeviation = donorCenterDeviation(pixels, width, height, point, radius, sample.mean);
      if (colorDifference > 65 || centerDeviation > 24) continue;
      const score = colorDifference + Math.abs(sample.deviation - targetRing.deviation) * 1.5 + centerDeviation * 1.2 + multiple * .35;
      if (score < bestScore) { bestScore = score; donor = point; donorRing = sample; }
    }
    if (!donor || !donorRing) return unchanged('附近没有找到可靠的同色纹理，本次未修改。可缩小画笔，或手动选择干净供样点。');
  }
  const output = new Uint8ClampedArray(pixels);
  const minX = Math.max(0, Math.floor(target.x - radius)), maxX = Math.min(width - 1, Math.ceil(target.x + radius));
  const minY = Math.max(0, Math.floor(target.y - radius)), maxY = Math.min(height - 1, Math.ceil(target.y + radius));
  const offset = [donorRing!.mean.r - targetRing.mean.r, donorRing!.mean.g - targetRing.mean.g, donorRing!.mean.b - targetRing.mean.b].map(value => clamp(-value, -20, 20));
  let changedPixels = 0, protectedPixels = 0, transparentPixels = 0;
  // Let pending cancellation reach the main thread before applying a patch.
  await yieldTask(); abort(options.signal);
  for (let y = minY; y <= maxY; y++) {
    if ((y - minY) % 32 === 0) { await yieldTask(); abort(options.signal); }
    for (let x = minX; x <= maxX; x++) {
      const normalized = Math.hypot(x - target.x, y - target.y) / radius;
      if (normalized >= 1) continue;
      const pixel = y * width + x, index = pixel * 4;
      if (options.protectionAlpha?.[pixel]) { protectedPixels++; continue; }
      if (pixels[index + 3] < 255) { transparentPixels++; continue; }
      const sampled = read(donorPixels, donorWidth, donorHeight, donor.x + x - target.x, donor.y + y - target.y);
      if (!sampled) { transparentPixels++; continue; }
      const t = clamp((normalized - .5) / .5, 0, 1), feather = 1 - t * t * (3 - 2 * t);
      const sample = [sampled.r, sampled.g, sampled.b]; let changed = false;
      for (let channel = 0; channel < 3; channel++) {
        const value = Math.round(clamp(pixels[index + channel] + (sample[channel] + offset[channel] - pixels[index + channel]) * feather, 0, 255));
        output[index + channel] = value; changed ||= value !== pixels[index + channel];
      }
      if (changed) changedPixels++;
    }
  }
  abort(options.signal);
  if (!changedPixels) return unchanged(protectedPixels ? '目标范围已被保护区覆盖或没有可见变化，原图保持不变。' : '供样与目标没有可见差异，原图保持不变。');
  return { pixels: output, changedPixels, sourcePoint: donor,
    warning: protectedPixels ? '已保留红色保护区，请检查保护边界的纹理衔接。' : transparentPixels ? '已保留透明及半透明边界，请检查修复边缘。' : undefined };
}
