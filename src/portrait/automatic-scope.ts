/** Pixel-only identity of editable/protected ranges, not a security digest. */
export interface AutomaticScopePixels {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
  /** ImageData RGBA by default; alpha-only buffers can use stride 1. */
  stride?: 1 | 4;
}

function alphaSignature(mask?: AutomaticScopePixels | null): string {
  if (!mask) return 'empty';
  const { width, height, data } = mask, stride = mask.stride ?? 4;
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 0)
    || width * height > 40_000_000 || ![1, 4].includes(stride) || data.length !== width * height * stride) {
    throw new Error('智能修图画笔范围尺寸无效。');
  }
  let first = 0x811c9dc5, second = 0x9e3779b9, nonzero = 0;
  for (let index = stride - 1; index < data.length; index += stride) {
    const alpha = data[index]; if (alpha) nonzero++;
    first = Math.imul(first ^ alpha, 0x01000193);
    second = Math.imul(second ^ alpha, 0x85ebca77);
    second = second << 13 | second >>> 19;
  }
  if (!nonzero) return 'empty';
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0');
  return `${width}x${height}:${nonzero}:${hex(first)}${hex(second)}`;
}

/** Alpha=1 is significant; RGB is irrelevant. Red/green roles never alias. */
export function automaticScopeSignature(protection?: AutomaticScopePixels | null, selection?: AutomaticScopePixels | null): string {
  return `red=${alphaSignature(protection)};green=${alphaSignature(selection)}`;
}

function readMask(canvas?: HTMLCanvasElement | null): AutomaticScopePixels | null {
  if (!canvas?.width || !canvas.height) return null;
  if (canvas.width * canvas.height > 40_000_000) throw new Error('智能修图画笔范围过大。');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法读取智能修图画笔范围。');
  return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
}

/** Capture synchronously before choosing the fixed baseline. Does not mutate canvases. */
export function captureAutomaticScopeSignature(protection?: HTMLCanvasElement | null, selection?: HTMLCanvasElement | null): string {
  return automaticScopeSignature(readMask(protection), readMask(selection));
}
