/** Offline S9-sized pipeline smoke test. Start Vite, then pass its local URL. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(120000)
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:5178')
  const report = await page.evaluate(async () => {
    const imaging = await import('/src/imaging/index.ts')
    const timingsMs = {}
    const run = async (label, operation) => {
      const start = performance.now()
      const result = await operation()
      timingsMs[label] = Math.round(performance.now() - start)
      return result
    }
    const fixture = await run('fixture', async () => {
      const c = document.createElement('canvas')
      c.width = 6000
      c.height = 4000
      const context = c.getContext('2d')
      const pixels = context.createImageData(c.width, c.height)
      let seed = 1337
      for (let y = 0; y < c.height; y += 1) {
        for (let x = 0; x < c.width; x += 1) {
          const offset = (y * c.width + x) * 4
          seed = (Math.imul(seed, 1664525) + 1013904223) | 0
          const noise = ((seed >>> 24) - 128) * 0.22
          pixels.data[offset] = 55 + x / c.width * 140 + noise
          pixels.data[offset + 1] = 60 + y / c.height * 120 + noise * 0.8
          pixels.data[offset + 2] = 145 - x / c.width * 50 + noise * 0.7
          pixels.data[offset + 3] = 255
        }
      }
      context.putImageData(pixels, 0, 0)
      const blob = await new Promise(resolve => c.toBlob(resolve, 'image/jpeg', 0.92))
      c.width = c.height = 1
      return new File([blob], 'S9-6000x4000.jpg', { type: 'image/jpeg' })
    })
    const photo = await run('loadPhoto', () => imaging.loadPhoto(fixture))
    const resized = await run('resize2048', () => imaging.resizeForModel(photo.dataUrl, 2048))
    const mask = document.createElement('canvas')
    mask.width = resized.width
    mask.height = resized.height
    const context = mask.getContext('2d')
    context.fillStyle = 'white'
    context.beginPath()
    context.arc(mask.width / 2, mask.height / 2, 90, 0, Math.PI * 2)
    context.fill()
    const model = document.createElement('canvas')
    model.width = resized.width
    model.height = resized.height
    const editContext = model.getContext('2d')
    editContext.fillStyle = '#a8b3cd'
    editContext.fillRect(0, 0, model.width, model.height)
    const composed = await run('composeSmallSelection', () => imaging.composeEdit(photo.dataUrl, model.toDataURL(), mask, 1))
    const exported = await run('encodeJPEG', () => imaging.encodeExport(composed, 'jpeg', 0.95))
    const inspect = async dataUrl => {
      const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
      const c = document.createElement('canvas')
      c.width = 1
      c.height = 1
      const context = c.getContext('2d')
      context.drawImage(bitmap, 0, 0)
      const dimensions = { width: bitmap.width, height: bitmap.height }
      const corner = [...context.getImageData(0, 0, 1, 1).data]
      bitmap.close()
      return { ...dimensions, corner }
    }
    const before = await run('inspectOriginal', () => inspect(photo.dataUrl))
    const after = await run('inspectComposite', () => inspect(composed))
    const output = await run('inspectExport', () => inspect(`data:${exported.mimeType};base64,${exported.base64}`))
    return {
      fixtureBytes: fixture.size,
      model: { width: resized.width, height: resized.height, base64Length: resized.base64.length },
      compositeBase64Length: composed.length,
      exportedBase64Length: exported.base64.length,
      before, after, output, timingsMs,
    }
  })
  assert.deepEqual({ width: report.before.width, height: report.before.height }, { width: 6000, height: 4000 })
  assert.deepEqual({ width: report.after.width, height: report.after.height }, { width: 6000, height: 4000 })
  assert.deepEqual({ width: report.output.width, height: report.output.height }, { width: 6000, height: 4000 })
  assert.deepEqual(report.after.corner, report.before.corner)
  assert.deepEqual({ width: report.model.width, height: report.model.height }, { width: 2048, height: 1365 })
  console.log(JSON.stringify({ passed: true, platform: 'Chrome desktop headless, offline generated textured JPEG fixture', ...report }, null, 2))
} finally {
  await browser.close()
}
