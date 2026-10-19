/** Run after starting Vite: node src/imaging/browser-smoke.mjs [base URL]. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
try {
  const page = await browser.newPage()
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:5181')
  const checks = await page.evaluate(async () => {
    const imaging = await import('/src/imaging/index.ts')
    const makeCanvas = (width, height, color) => {
      const element = document.createElement('canvas')
      element.width = width
      element.height = height
      const context = element.getContext('2d')
      if (color) {
        context.fillStyle = color
        context.fillRect(0, 0, width, height)
      }
      return { element, context }
    }
    const sample = async (dataUrl, x, y) => {
      const image = await createImageBitmap(await (await fetch(dataUrl)).blob())
      const { element, context } = makeCanvas(image.width, image.height)
      context.drawImage(image, 0, 0)
      image.close()
      return { pixel: [...context.getImageData(x, y, 1, 1).data], width: element.width, height: element.height }
    }
    const original = makeCanvas(8, 4, 'rgb(200, 0, 0)')
    const edit = makeCanvas(4, 2, 'rgb(0, 0, 200)')
    const mask = makeCanvas(4, 2)
    mask.context.fillStyle = '#fff'
    mask.context.fillRect(2, 0, 2, 2)
    const composed = await imaging.composeEdit(original.element.toDataURL(), edit.element.toDataURL(), mask.element, 0.5)
    const squareEdit = makeCanvas(4, 4, 'rgb(0, 0, 200)')
    let mismatchedAspectRejected = false
    try {
      await imaging.composeEdit(original.element.toDataURL(), squareEdit.element.toDataURL(), mask.element, 1)
    } catch (error) {
      mismatchedAspectRejected = error.message.includes('模型返回画幅与原图不一致')
        && error.message.includes('已保留当前照片')
    }
    const protectedPixel = await sample(composed, 0, 1)
    const selectedPixel = await sample(composed, 7, 1)
    const payload = await imaging.createMaskPayload(mask.element, 8, 4)
    const maskProtected = await sample(`data:image/png;base64,${payload.maskBase64}`, 0, 1)
    const maskSelected = await sample(`data:image/png;base64,${payload.maskBase64}`, 7, 1)
    const guideProtected = await sample(`data:image/png;base64,${payload.maskGuideBase64}`, 0, 1)
    const guideSelected = await sample(`data:image/png;base64,${payload.maskGuideBase64}`, 7, 1)
    const resized = await imaging.resizeForModel(original.element.toDataURL(), 4)
    const zero = await imaging.applyAdjustments(original.element.toDataURL(), {
      exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0,
    })
    const identity = await sample(zero, 1, 1)
    const emptyMask = makeCanvas(4, 2)
    const full = await imaging.composeEdit(original.element.toDataURL(), edit.element.toDataURL(), emptyMask.element, 1)
    const emptyMeansFull = await sample(full, 0, 1)
    const exported = await imaging.encodeExport(composed, 'png')

    // Inject an EXIF orientation=6 tag into a real browser-generated JPEG.
    const jpeg = makeCanvas(3, 2, '#666').element.toDataURL('image/jpeg')
    const bytes = new Uint8Array(await (await fetch(jpeg)).arrayBuffer())
    const app1 = new Uint8Array([
      0xff, 0xe1, 0, 34, 69, 120, 105, 102, 0, 0,
      73, 73, 42, 0, 8, 0, 0, 0, 1, 0,
      0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
    ])
    const photo = await imaging.loadPhoto(new File([bytes.slice(0, 2), app1, bytes.slice(2)], 'rotated.jpg', { type: 'image/jpeg' }))
    let rawRejected = false
    try { await imaging.loadPhoto(new File(['raw'], 'photo.RW2')) } catch (error) { rawRejected = error.message.includes('RAW') }
    return {
      protectedPixel, selectedPixel, maskProtected, maskSelected, guideProtected, guideSelected,
      resized: { width: resized.width, height: resized.height, mimeType: resized.mimeType },
      identity, emptyMeansFull, exportedMime: exported.mimeType,
      hasSelection: payload.hasSelection, exif: { width: photo.width, height: photo.height }, rawRejected,
      mismatchedAspectRejected,
    }
  })

  assert.deepEqual(checks.protectedPixel, { pixel: [200, 0, 0, 255], width: 8, height: 4 })
  assert.deepEqual(checks.selectedPixel.pixel, [100, 0, 100, 255])
  assert.equal(checks.hasSelection, true)
  assert.equal(checks.maskProtected.pixel[3], 255)
  assert.equal(checks.maskSelected.pixel[3], 0)
  assert.deepEqual(checks.guideProtected.pixel, [0, 0, 0, 255])
  assert.deepEqual(checks.guideSelected.pixel, [255, 255, 255, 255])
  assert.deepEqual(checks.resized, { width: 4, height: 2, mimeType: 'image/jpeg' })
  assert.deepEqual(checks.identity.pixel, [200, 0, 0, 255])
  assert.deepEqual(checks.emptyMeansFull.pixel, [0, 0, 200, 255])
  assert.equal(checks.exportedMime, 'image/png')
  assert.deepEqual(checks.exif, { width: 2, height: 3 })
  assert.equal(checks.rawRejected, true)
  assert.equal(checks.mismatchedAspectRejected, true)
  console.log('Canvas 浏览器检查通过：蒙版缩放、保护区、强度、PNG编码、调色identity、EXIF方向、RAW拒绝与模型画幅校验。')
} finally {
  await browser.close()
}
