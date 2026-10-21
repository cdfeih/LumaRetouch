export interface PhotoTransform {
  rotation?: 0 | 90 | 180 | 270
  flipHorizontal?: boolean
  flipVertical?: boolean
  /** Crop is normalized to the current source, before flips and clockwise rotation. */
  crop?: { x: number; y: number; width: number; height: number }
}

export function planPhotoTransform(width: number, height: number, transform: PhotoTransform) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error('照片尺寸无效。')
  const rotation = transform.rotation ?? 0
  if (![0, 90, 180, 270].includes(rotation)) throw new Error('旋转角度须为 0、90、180 或 270 度。')
  const crop = transform.crop ?? { x: 0, y: 0, width: 1, height: 1 }
  if (!Object.values(crop).every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > 1 + 1e-8 || crop.y + crop.height > 1 + 1e-8) throw new Error('裁切范围须位于照片内，且宽高不能为零。')
  const x = Math.min(width - 1, Math.round(crop.x * width)), y = Math.min(height - 1, Math.round(crop.y * height))
  const right = Math.min(width, Math.round((crop.x + crop.width) * width)), bottom = Math.min(height, Math.round((crop.y + crop.height) * height))
  const sourceWidth = Math.max(1, right - x), sourceHeight = Math.max(1, bottom - y)
  const swap = rotation === 90 || rotation === 270
  return { x, y, sourceWidth, sourceHeight, width: swap ? sourceHeight : sourceWidth, height: swap ? sourceWidth : sourceHeight,
    rotation, flipHorizontal: transform.flipHorizontal === true, flipVertical: transform.flipVertical === true }
}
