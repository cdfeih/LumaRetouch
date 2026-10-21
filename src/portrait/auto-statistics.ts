/** Deterministic photographic measurements, not lesion/age/gender recognition. */
export interface FaceSkinStatistics {
  sampleWidth: number; sampleHeight: number;
  originalFaceWidth: number; originalFaceHeight: number;
  candidateSamples: number; validSamples: number; localSamples: number; coverage: number;
  medianLuminance: number; shadowFraction: number; highlightFraction: number;
  shineFraction: number; fineTexture: number; midToneUnevenness: number;
  redSpotFraction: number; redChromaSpread: number;
  reliable: boolean; warnings: string[];
}
export interface FaceStatisticsOptions { originalFaceWidth: number; originalFaceHeight: number; candidateSamples?: number; faceWidthInSamples?: number }
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
function quantile(histogram: Uint32Array, count: number, q: number): number {
  if (!count) return 0;
  const target = Math.max(1, Math.ceil(count * q)); let sum = 0;
  for (let i = 0; i < histogram.length; i++) { sum += histogram[i]; if (sum >= target) return i; }
  return histogram.length - 1;
}

/** Eligible already intersects geometry, semantic face-skin, red protection and
 * green selection. Only same-skin neighbours enter any local measurement. */
export function analyzeFaceSkinPixels(source: Uint8ClampedArray, width: number, height: number, eligible: Uint8ClampedArray, options: FaceStatisticsOptions): FaceSkinStatistics {
  const count = width * height;
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0) || count > 1600 * 1600 || source.length !== count * 4 || eligible.length !== count
    || ![options.originalFaceWidth, options.originalFaceHeight].every(n => Number.isFinite(n) && n > 0)
    || options.candidateSamples !== undefined && (!Number.isSafeInteger(options.candidateSamples) || options.candidateSamples < 0 || options.candidateSamples > count)) throw new Error('智能修图皮肤统计尺寸无效。');
  const valid = new Uint8Array(count), light = new Uint8Array(count), luminance = new Uint32Array(256), red = new Uint32Array(511);
  let validSamples = 0, candidateSamples = options.candidateSamples ?? 0, shadows = 0, highlights = 0;
  for (let p = 0; p < count; p++) {
    if (!eligible[p]) continue;
    if (options.candidateSamples === undefined) candidateSamples++;
    const i = p * 4; if (source[i + 3] < 250) continue;
    const y = Math.round(source[i] * .2126 + source[i+1] * .7152 + source[i+2] * .0722);
    valid[p] = 1; light[p] = y; luminance[y]++; validSamples++;
    red[clamp(Math.round(source[i] - (source[i+1] + source[i+2]) / 2) + 255, 0, 510)]++;
    if (y <= 30) shadows++; if (y >= 248) highlights++;
  }
  const medianLuminance = quantile(luminance, validSamples, .5), coverage = candidateSamples ? clamp(validSamples / candidateSamples, 0, 1) : 0;
  let shiny = 0;
  for (let p = 0; p < count; p++) if (valid[p]) {
    const i = p * 4, spread = Math.max(source[i], source[i+1], source[i+2]) - Math.min(source[i], source[i+1], source[i+2]);
    if (light[p] > Math.max(200, medianLuminance + 30) && spread < 45) shiny++;
  }
  const fineHistogram = new Uint32Array(1024), midHistogram = new Uint32Array(1024);
  const step = Math.max(1, Math.floor(Math.sqrt(validSamples / 24000))), radius = clamp(Math.round((options.faceWidthInSamples ?? width) / 48), 3, 20);
  let localSamples = 0, redSpots = 0, midSamples = 0;
  const patchMean = (x: number, y: number) => {
    if (x < 1 || y < 1 || x + 1 >= width || y + 1 >= height) return NaN;
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const p = (y + dy) * width + x + dx; if (!valid[p]) return NaN; sum += light[p]; }
    return sum / 9;
  };
  for (let y = 1; y + 1 < height; y += step) for (let x = 1; x + 1 < width; x += step) {
    const p = y * width + x; if (!valid[p]) continue;
    let sumY = 0, sumRed = 0, neighbors = 0, edge = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const n = (y + dy) * width + x + dx; if (!valid[n]) continue;
      sumY += light[n]; const i = n * 4; sumRed += source[i] - (source[i+1] + source[i+2]) / 2;
      edge = Math.max(edge, Math.abs(light[n] - light[p])); neighbors++;
    }
    // Strong edges/moles/features are not evidence for automatic smoothing or
    // local-red-point repair. The renderer retains its own independent guards.
    if (neighbors !== 8 || edge > 28) continue;
    localSamples++; const meanY = sumY / 8, i = p * 4;
    fineHistogram[clamp(Math.round(Math.abs(light[p] - meanY) * 4), 0, 1023)]++;
    const localRedExcess = source[i] - (source[i+1] + source[i+2]) / 2 - sumRed / 8;
    if (localRedExcess > 12 && source[i] > source[i+1] * 1.08 && source[i] > source[i+2] * 1.05 && Math.abs(light[p] - meanY) < 60) redSpots++;
    const broad = [patchMean(x-radius,y), patchMean(x+radius,y), patchMean(x,y-radius), patchMean(x,y+radius)];
    if (broad.every(Number.isFinite)) {
      const difference = Math.abs((sumY + light[p]) / 9 - broad.reduce((a,b) => a+b, 0) / 4);
      midHistogram[clamp(Math.round(difference * 4), 0, 1023)]++; midSamples++;
    }
  }
  const shadowFraction = validSamples ? shadows / validSamples : 0, highlightFraction = validSamples ? highlights / validSamples : 0;
  const warnings: string[] = [];
  if (Math.min(options.originalFaceWidth, options.originalFaceHeight) < 72) warnings.push('原片中的脸较小，不自动判断细痘或皮肤纹理；建议使用更近、更清晰的原片。');
  if (validSamples < 192 || localSamples < 64 || coverage < .12) warnings.push('可编辑且高置信的皮肤样本不足，保守跳过此人物的自动皮肤参数。');
  if (shadowFraction > .6 || highlightFraction > .35) warnings.push('皮肤采样大面积接近纯黑或纯白，无法可靠判断细节，已跳过自动皮肤修饰。');
  return {
    sampleWidth: width, sampleHeight: height, originalFaceWidth: options.originalFaceWidth, originalFaceHeight: options.originalFaceHeight,
    candidateSamples, validSamples, localSamples, coverage, medianLuminance, shadowFraction, highlightFraction,
    shineFraction: validSamples ? shiny / validSamples : 0,
    fineTexture: quantile(fineHistogram, localSamples, .5) / 4,
    midToneUnevenness: quantile(midHistogram, midSamples, .8) / 4,
    redSpotFraction: localSamples ? redSpots / localSamples : 0,
    redChromaSpread: quantile(red, validSamples, .9) - quantile(red, validSamples, .1),
    reliable: warnings.length === 0, warnings,
  };
}
