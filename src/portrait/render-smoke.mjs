/** Local browser/Worker finishing acceptance. No face model or paid API is called. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5178'
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
try {
  const context = await browser.newContext()
  const external = []
  await context.route('**/*', route => {
    const url = route.request().url()
    if (url.startsWith('data:') || url.startsWith('blob:') || new URL(url).origin === new URL(baseUrl).origin) return route.continue()
    external.push(url)
    return route.abort()
  })
  const page = await context.newPage()
  const errors = []
  let workers = 0
  page.on('pageerror', error => errors.push(error.message))
  page.on('worker', () => { workers += 1 })
  await page.goto(baseUrl)
  const report = await page.evaluate(async () => {
    const { renderNaturalRetouch } = await import('/src/portrait/render.ts')
    const { createFaceSkinMask } = await import('/src/portrait/detection.ts')
    const ZERO = { smoothing: 0, blemish: 0, evenness: 0, brightening: 0, shine: 0 }
    const OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109]
    const LE = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246]
    const RE = [263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466]
    const LB = [70,63,105,66,107,55,65,52,53,46]
    const RB = [300,293,334,296,336,285,295,282,283,276]
    const LIPS = [61,146,91,181,84,17,314,405,321,375,291,409,270,269,267,0,37,39,40,185]
    function face(cx) {
      const landmarks = Array.from({ length: 478 }, () => ({ x: cx, y: 0.5 }))
      function ellipse(indices, x, y, rx, ry) {
        indices.forEach((index, n) => {
          const angle = n / indices.length * Math.PI * 2 - Math.PI / 2
          landmarks[index] = { x: x + rx * Math.cos(angle), y: y + ry * Math.sin(angle) }
        })
      }
      ellipse(OVAL, cx, 0.5, 0.17, 0.36)
      ellipse(LE, cx - 0.055, 0.42, 0.027, 0.023)
      ellipse(RE, cx + 0.055, 0.42, 0.027, 0.023)
      ellipse(LB, cx - 0.055, 0.34, 0.03, 0.012)
      ellipse(RB, cx + 0.055, 0.34, 0.03, 0.012)
      ellipse(LIPS, cx, 0.66, 0.045, 0.035)
      return { id: `face-${cx}`, label: 'QA face', bounds: { x: cx - 0.17, y: 0.14, width: 0.34, height: 0.72 }, landmarks, thumbnail: '' }
    }
    function canvas(w, h, color) {
      const element = document.createElement('canvas'); element.width = w; element.height = h
      const context = element.getContext('2d')
      if (color) { context.fillStyle = color; context.fillRect(0, 0, w, h) }
      return { element, context }
    }
    async function pixels(src) {
      const bitmap = await createImageBitmap(await (await fetch(src)).blob())
      const target = canvas(bitmap.width, bitmap.height)
      target.context.drawImage(bitmap, 0, 0); bitmap.close()
      return { data: target.context.getImageData(0, 0, target.element.width, target.element.height).data, width: target.element.width, height: target.element.height }
    }
    const width = 2000, height = 1200
    const baseline = canvas(width, height, 'rgb(170,130,110)').element.toDataURL()
    const current = canvas(width, height, 'rgb(20,40,60)').element.toDataURL()
    const targetFace = face(0.73), otherFace = face(0.27)
    window.__portraitSmokeFixture = { baseline, current, face: targetFace }
    const mask = createFaceSkinMask(targetFace, width, height)
    const other = createFaceSkinMask(otherFace, width, height)
    const protection = canvas(500, 300)
    const protectedPixels = protection.context.createImageData(500, 300)
    for (let y = 160; y < 185; y += 1) for (let x = 345; x < 375; x += 1) protectedPixels.data[(y * 500 + x) * 4 + 3] = 1
    protection.context.putImageData(protectedPixels, 0, 0)
    const selection = canvas(500, 300)
    selection.context.fillStyle = '#fff'; selection.context.fillRect(250, 150, 250, 150)
    const started = performance.now()
    const rendered = await renderNaturalRetouch(baseline, current, [{ face: targetFace, settings: { ...ZERO, brightening: 100 } }], { protection: protection.element, selection: selection.element })
    const elapsedMs = Math.round(performance.now() - started)
    const result = await pixels(rendered), original = await pixels(current)
    const p = canvas(width, height); p.context.imageSmoothingEnabled = false; p.context.drawImage(protection.element, 0, 0, width, height)
    const protectionNative = p.context.getImageData(0, 0, width, height).data
    const s = canvas(width, height); s.context.imageSmoothingEnabled = false; s.context.drawImage(selection.element, 0, 0, width, height)
    const selectionNative = s.context.getImageData(0, 0, width, height).data
    let protectedChanged = 0, excludedChanged = 0, otherPersonChanged = 0, greenOutsideChanged = 0, editableChanged = 0, protectedCount = 0
    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      const o = pixel * 4
      const changed = result.data[o] !== original.data[o] || result.data[o + 1] !== original.data[o + 1] || result.data[o + 2] !== original.data[o + 2] || result.data[o + 3] !== original.data[o + 3]
      if (protectionNative[o + 3] > 0) { protectedCount++; if (changed) protectedChanged++ }
      if (changed && mask[pixel] === 0) excludedChanged++
      if (changed && other[pixel] > 0) otherPersonChanged++
      if (changed && selectionNative[o + 3] === 0) greenOutsideChanged++
      if (changed && mask[pixel] > 0) editableChanged++
    }
    const zero = await pixels(await renderNaturalRetouch(baseline, current, [{ face: targetFace, settings: ZERO }], { selection: canvas(500, 300).element }))
    let zeroRestoreMismatch = 0
    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      const expected = mask[pixel] > 0 ? [170, 130, 110, 255] : [20, 40, 60, 255]
      if (expected.some((value, channel) => zero.data[pixel * 4 + channel] !== value)) zeroRestoreMismatch++
    }
    const fullyProtected = await renderNaturalRetouch(baseline, current, [{ face: targetFace, settings: { ...ZERO, brightening: 100 } }], { protection: canvas(10, 10, '#fff').element })
    const aborted = new AbortController(); aborted.abort()
    let cancel = ''
    try { await renderNaturalRetouch(baseline, current, [{ face: targetFace, settings: ZERO }], { signal: aborted.signal }) } catch (error) { cancel = error.name }
    let badDimensions = false
    try { await renderNaturalRetouch(baseline, canvas(20, 20, '#fff').element.toDataURL(), [{ face: targetFace, settings: ZERO }]) } catch (error) { badDimensions = error.message.includes('尺寸不一致') }
    return { width: result.width, height: result.height, elapsedMs, protectedCount, protectedChanged, excludedChanged, otherPersonChanged, greenOutsideChanged, editableChanged, zeroRestoreMismatch, fullyProtectedUnchanged: fullyProtected === current, cancel, badDimensions }
  })
  assert.equal(report.width, 2000); assert.equal(report.height, 1200)
  assert.ok(report.protectedCount > 1000); assert.ok(report.editableChanged > 10000)
  for (const key of ['protectedChanged', 'excludedChanged', 'otherPersonChanged', 'greenOutsideChanged', 'zeroRestoreMismatch']) assert.equal(report[key], 0, key)
  assert.equal(report.fullyProtectedUnchanged, true); assert.equal(report.cancel, 'AbortError'); assert.equal(report.badDimensions, true)
  assert.ok(workers >= 3)
  const abortDuringWorker = new Promise((resolve, reject) => {
    page.once('worker', () => {
      page.evaluate(() => window.__portraitSmokeAbort.abort()).then(resolve, reject)
    })
  })
  const runningCancel = await page.evaluate(async () => {
    const { renderNaturalRetouch } = await import('/src/portrait/render.ts')
    const fixture = window.__portraitSmokeFixture
    const controller = new AbortController()
    window.__portraitSmokeAbort = controller
    try {
      await renderNaturalRetouch(fixture.baseline, fixture.current, [{ face: fixture.face, settings: {
        smoothing: 100, blemish: 100, evenness: 100, brightening: 100, shine: 100,
      } }], { signal: controller.signal })
      return 'completed'
    } catch (error) { return error.name }
  })
  await abortDuringWorker
  assert.equal(runningCancel, 'AbortError')
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  console.log(JSON.stringify({ passed: true, workers, runningCancel, externalRequests: external.length, ...report }, null, 2))
} finally {
  await browser.close()
}
