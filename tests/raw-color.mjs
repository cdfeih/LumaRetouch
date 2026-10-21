/** Local APIs + a public CC0 S9 RAW. No paid API or private photo is used. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'

const baseUrl = process.env.LUMA_TEST_URL || process.argv[2] || 'http://127.0.0.1:5178'
const fixture = path.resolve(process.env.LUMA_RAW_FIXTURE || 'artifacts/raw/Panasonic-DC-S9-24MP.RW2')
const output = path.resolve('artifacts/raw-color')
await mkdir(output, { recursive: true })
const digest = createHash('sha256').update(await readFile(fixture)).digest('hex')
assert.equal(digest, '290ad5b4e396cb241a59459b2613d2b0659a03ff654e5d5368b3376d35812e50', '仅使用已核实 CC0 S9 样片')
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
const context = await browser.newContext()
const external = [], resources = [], errors = []
const events = []
await context.route('**/*', route => {
  const url = route.request().url()
  if (/^(blob:|data:)/.test(url) || new URL(url).origin === new URL(baseUrl).origin) return route.continue()
  external.push(url); return route.abort('blockedbyclient')
})
const page = await context.newPage()
const testUrl = new URL('/__luma_raw_color_test', baseUrl).href
await page.route(testUrl, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:16px;background:#172116;color:#fff"></body></html>' }))
page.on('request', req => { if (/raw|wasm/i.test(req.url())) resources.push(req.url()) })
page.on('pageerror', error => errors.push(error.message))
page.setDefaultTimeout(120_000)
try {
  await page.goto(testUrl)
  const geometry = await page.evaluate(async () => {
    const { transformPhoto, applyAdjustments, DEFAULT_ADJUSTMENTS } = await import('/src/imaging/index.ts')
    const source = document.createElement('canvas'); source.width = 3; source.height = 2
    const ctx = source.getContext('2d')
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff']
    colors.forEach((color, i) => { ctx.fillStyle = color; ctx.fillRect(i % 3, Math.floor(i / 3), 1, 1) })
    const read = async result => {
      const img = await createImageBitmap(await (await fetch(result.dataUrl || result)).blob())
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const x = c.getContext('2d'); x.drawImage(img, 0, 0); img.close()
      return { width: c.width, height: c.height, pixels: [...x.getImageData(0, 0, c.width, c.height).data] }
    }
    const rotated = await read(await transformPhoto(source.toDataURL(), { rotation: 90 }))
    const flipped = await read(await transformPhoto(source.toDataURL(), { flipHorizontal: true }))
    const cropped = await read(await transformPhoto(source.toDataURL(), { crop: { x: 1 / 3, y: 0, width: 2 / 3, height: .5 } }))
    const neutral = await read(await applyAdjustments(source.toDataURL(), DEFAULT_ADJUSTMENTS))
    const advanced = await read(await applyAdjustments(source.toDataURL(), DEFAULT_ADJUSTMENTS, { highlights: -80, shadows: 20, hsl: {}, curve: [{ x: 0, y: 0 }, { x: .5, y: .7 }, { x: 1, y: 1 }] }))
    return { rotated, flipped, cropped, neutral, advanced }
  })
  assert.deepEqual([geometry.rotated.width, geometry.rotated.height], [2, 3])
  assert.deepEqual(geometry.rotated.pixels.slice(0, 8), [255, 255, 0, 255, 255, 0, 0, 255])
  assert.deepEqual(geometry.flipped.pixels.slice(0, 4), [0, 0, 255, 255])
  assert.deepEqual(geometry.cropped.pixels, [0, 255, 0, 255, 0, 0, 255, 255])
  assert.deepEqual(geometry.neutral.pixels.slice(0, 4), [255, 0, 0, 255])
  assert.notDeepEqual(geometry.advanced.pixels, geometry.neutral.pixels)
  events.push({ check: '裁切、顺时针旋转、翻转、原尺寸调色', passed: true })
  await page.evaluate(() => { const input = document.createElement('input'); input.id = 'raw-fixture'; input.type = 'file'; input.hidden = true; document.body.appendChild(input) })
  await page.locator('#raw-fixture').setInputFiles(fixture)
  const raw = await page.evaluate(async () => {
    const { loadPhoto } = await import('/src/imaging/index.ts')
    const file = document.querySelector('#raw-fixture').files[0]
    const progress = [], start = performance.now()
    const image = await loadPhoto(file, { onProgress: message => progress.push(message) })
    const bitmap = await createImageBitmap(await (await fetch(image.dataUrl)).blob())
    const c = document.createElement('canvas'); c.width = c.height = 64
    const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0, 64, 64); bitmap.close()
    const pixels = ctx.getImageData(0, 0, 64, 64).data
    let sum = 0, nonBlack = 0, max = 0, min = 255
    for (let i = 0; i < pixels.length; i += 4) { const y = .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2]; sum += y; if (y > 4) nonBlack++; max = Math.max(max, y); min = Math.min(min, y) }
    const preview = document.createElement('img'); preview.src = image.dataUrl; preview.style.cssText = 'max-width:96vw;max-height:92vh;object-fit:contain'; preview.id = 'raw-preview'
    document.querySelector('#raw-preview')?.remove(); document.body.appendChild(preview)
    return { width: image.width, height: image.height, mimeType: image.mimeType, raw: image.raw, warnings: image.warnings, progress,
      ms: Math.round(performance.now() - start), mean: sum / 4096, nonBlackFraction: nonBlack / 4096, range: max - min }
  })
  assert.deepEqual([raw.width, raw.height], [6016, 4016])
  assert.equal(raw.raw.source, 'sensor-demosaic'); assert.equal(raw.raw.output, '8bit-srgb')
  assert.match(raw.raw.camera, /Panasonic DC-S9/); assert.match(raw.raw.decoder, /0\.22\.1/)
  assert.equal(raw.mimeType, 'image/png'); assert.ok(raw.warnings.some(value => value.includes('不是 16bit')))
  assert.ok(raw.mean > 15 && raw.mean < 245); assert.ok(raw.range > 80); assert.ok(raw.nonBlackFraction > .8)
  events.push({ check: 'CC0 S9 24MP RW2 完整传感器解码', passed: true, ...raw })
  const lifecycle = await page.evaluate(async () => {
    const { decodeRaw } = await import('/src/raw/index.ts')
    const file = document.querySelector('#raw-fixture').files[0]
    const controller = new AbortController(), start = performance.now()
    let cancelled = ''
    try { await decodeRaw(file, { signal: controller.signal, onProgress: () => controller.abort() }) } catch (error) { cancelled = error.name }
    const c = document.createElement('canvas'); c.width = c.height = 2
    const blob = await new Promise(resolve => c.toBlob(resolve, 'image/jpeg'))
    let renamedJpeg = ''
    try { await decodeRaw(new File([blob], 'fake.RW2')) } catch (error) { renamedJpeg = error.message }
    let oversized = ''
    try { await decodeRaw({ size: 80 * 1024 * 1024 + 1 }) } catch (error) { oversized = error.message }
    return { cancelled, cancelledAndInvalidMs: Math.round(performance.now() - start), renamedJpeg, oversized }
  })
  assert.equal(lifecycle.cancelled, 'AbortError'); assert.match(lifecycle.renamedJpeg, /无法完整解码/); assert.match(lifecycle.oversized, /80 MB/)
  events.push({ check: '取消、拒绝改名JPEG伪RAW、文件上限', passed: true, ...lifecycle })
  assert.deepEqual(external, [])
  await page.locator('#raw-preview').screenshot({ path: path.join(output, 's9-full-decode.png') })
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, fixtureSha256: digest, external, resources, errors, events }, null, 2))
  console.log(JSON.stringify({ passed: true, events, external, resources: resources.length, errors }, null, 2))
} catch (error) {
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, events, external, resources, errors, failure: error.message, stack: error.stack }, null, 2))
  throw error
} finally { await browser.close() }
