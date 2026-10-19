/** About eight pixels on a 2048px model input, bounded for original-size output. */
export function protectionTransitionRadius(width: number, height: number): number {
  // Tiny fixtures/icons do not have room for a meaningful exterior transition.
  if (Math.min(width, height) < 16) return 0
  return Math.max(2, Math.min(32, Math.round(Math.max(width, height) * 8 / 2048)))
}

/**
 * Editable coverage outside a binary protection boundary. Every nonzero alpha is
 * a distance seed, including antialiased alpha=1. This never softens protection:
 * the compositor still independently vetoes all protected pixels.
 *
 * Pass a strip with a radius-sized halo above/below and request its central rows.
 * The small integer chamfer field uses one byte per halo pixel, rather than a
 * full-photo floating-point distance map. Three/four steps approximate circular
 * distance, and smoothstep joins the unchanged boundary to the edited exterior.
 */
export function protectionTransitionCoverage(
  protection: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  startRow = 0,
  rowCount = height,
): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || protection.length !== width * height * 4
    || !Number.isInteger(startRow) || !Number.isInteger(rowCount)
    || startRow < 0 || rowCount < 0 || startRow + rowCount > height) {
    throw new Error('保护区过渡的像素尺寸不一致。')
  }
  const boundedRadius = Number.isFinite(radius) ? Math.max(0, Math.min(32, Math.round(radius))) : 0
  const limit = boundedRadius * 3
  const coverage = new Uint8ClampedArray(width * rowCount)
  if (limit === 0) {
    for (let i = 0, p = startRow * width; i < coverage.length; i += 1, p += 1) {
      coverage[i] = protection[p * 4 + 3] > 0 ? 0 : 255
    }
    return coverage
  }
  const distances = new Uint8Array(width * height)
  for (let p = 0; p < distances.length; p += 1) {
    distances[p] = protection[p * 4 + 3] > 0 ? 0 : limit
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x
      let distance = distances[p]
      if (x > 0) distance = Math.min(distance, distances[p - 1] + 3)
      if (y > 0) {
        distance = Math.min(distance, distances[p - width] + 3)
        if (x > 0) distance = Math.min(distance, distances[p - width - 1] + 4)
        if (x + 1 < width) distance = Math.min(distance, distances[p - width + 1] + 4)
      }
      distances[p] = distance
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const p = y * width + x
      let distance = distances[p]
      if (x + 1 < width) distance = Math.min(distance, distances[p + 1] + 3)
      if (y + 1 < height) {
        distance = Math.min(distance, distances[p + width] + 3)
        if (x > 0) distance = Math.min(distance, distances[p + width - 1] + 4)
        if (x + 1 < width) distance = Math.min(distance, distances[p + width + 1] + 4)
      }
      distances[p] = distance
    }
  }
  for (let i = 0, p = startRow * width; i < coverage.length; i += 1, p += 1) {
    const t = distances[p] / limit
    coverage[i] = Math.round(255 * t * t * (3 - 2 * t))
  }
  return coverage
}
