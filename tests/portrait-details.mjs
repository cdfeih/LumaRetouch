/** Face-detail browser verification. Uses local mesh and worker; no API requests. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const outputDir = path.resolve('artifacts/portrait-details');
const executablePath = [process.env.LUMA_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage();
const externalRequests = [], rendererErrors = [];
await page.route('**/*', async route => {
  const url = route.request().url();
  if (url.startsWith(baseUrl) || /^(data:|blob:)/.test(url)) return route.continue();
  externalRequests.push(url); return route.abort('blockedbyclient');
});
page.on('pageerror', error => rendererErrors.push(error.message));
try {
  await page.goto(baseUrl);
  const fixture = `data:image/jpeg;base64,${(await readFile('tests/fixtures/mediapipe-portrait.jpg')).toString('base64')}`;
  const report = await page.evaluate(async ({ fixture, scale }) => {
    const { detectPortraitFaces, createFaceSkinMask, createFaceDetailMasks } = await import('/src/portrait/detection.ts');
    const { renderNaturalRetouch } = await import('/src/portrait/render.ts');
    const { isEyeWhitePixel, isTeethPixel } = await import('/src/portrait/retouch.ts');
    const decode = async src => {
      const image = new Image(); image.src = src; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return { canvas, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const decoded = await decode(fixture);
    if (scale !== 1) {
      const scaled = document.createElement('canvas'); scaled.width = decoded.canvas.width * scale; scaled.height = decoded.canvas.height * scale;
      scaled.getContext('2d').drawImage(decoded.canvas, 0, 0, scaled.width, scaled.height);
      fixture = scaled.toDataURL('image/png');
    }
    const original = await decode(fixture), width = original.canvas.width, height = original.canvas.height;
    // Normalize this fixture to a lossless reference so Chromium JPEG draw-path rounding is not mistaken for algorithmic edits.
    fixture = original.canvas.toDataURL('image/png');
    const faces = await detectPortraitFaces(fixture);
    if (faces.length !== 1) throw new Error(`Expected one fixture face, got ${faces.length}`);
    const face = faces[0], details = createFaceDetailMasks(face, width, height), skin = createFaceSkinMask(face, width, height);
    const zero = { smoothing: 0, blemish: 0, evenness: 0, brightening: 0, shine: 0, warmth: 0, deYellow: 0, deRedness: 0, rosiness: 0, darkCircles: 0, teethWhitening: 0, eyeWhitening: 0, lipColor: 0 };
    const checks = [];
    let eyeResult;
    for (const field of ['warmth', 'deYellow', 'deRedness', 'rosiness', 'darkCircles', 'teethWhitening', 'eyeWhitening', 'lipColor']) {
      const result = await renderNaturalRetouch(fixture, fixture, [{ face, settings: { ...zero, [field]: 100 } }]);
      const output = await decode(result);
      let changed = 0, forbidden = 0, irisChanged = 0;
      const irisIndices = [469,470,471,472,474,475,476,477];
      for (let pixel = 0; pixel < skin.length; pixel++) {
        const offset = pixel * 4;
        if (![0, 1, 2, 3].some(channel => original.pixels[offset + channel] !== output.pixels[offset + channel])) continue;
        changed++;
        const r = original.pixels[offset], g = original.pixels[offset + 1], b = original.pixels[offset + 2];
        const allowed = field === 'teethWhitening' ? details.teeth[pixel] && isTeethPixel(r, g, b)
          : field === 'eyeWhitening' ? details.eyes[pixel] && isEyeWhitePixel(r, g, b)
          : field === 'lipColor' ? details.lips[pixel] : field === 'darkCircles' ? skin[pixel] && details.underEyes[pixel] : skin[pixel];
        if (!allowed) forbidden++;
      }
      if (field === 'eyeWhitening') {
        for (const index of irisIndices) {
          const p = face.landmarks[index], pixel = Math.floor(p.y * height) * width + Math.floor(p.x * width);
          if ([0, 1, 2, 3].some(channel => original.pixels[pixel * 4 + channel] !== output.pixels[pixel * 4 + channel])) irisChanged++;
        }
        eyeResult = result;
      }
      checks.push({ field, changed, forbidden, irisChanged });
    }
    const reset = await decode(await renderNaturalRetouch(fixture, eyeResult, [{ face, settings: zero }]));
    let resetDifference = 0;
    for (let i = 0; i < original.pixels.length; i++) if (original.pixels[i] !== reset.pixels[i]) resetDifference++;
    const protection = document.createElement('canvas'); protection.width = width; protection.height = height;
    const protectionContext = protection.getContext('2d'); protectionContext.fillStyle = 'rgba(255,0,0,0.004)'; protectionContext.fillRect(0, 0, width, height);
    const protectedResult = await renderNaturalRetouch(fixture, fixture, [{ face, settings: { ...zero, eyeWhitening: 100, teethWhitening: 100, warmth: 100 } }], { protection });
    const selection = document.createElement('canvas'); selection.width = width; selection.height = height;
    selection.getContext('2d').fillRect(0, 0, 1, 1);
    const selectedResult = await renderNaturalRetouch(fixture, fixture, [{ face, settings: { ...zero, eyeWhitening: 100, teethWhitening: 100, warmth: 100 } }], { selection });
    return { width, height, checks, resetDifference, protectionUnchanged: protectedResult === fixture, greenExcludedUnchanged: selectedResult === fixture };
  }, { fixture, scale: Number(process.env.LUMA_DETAIL_SCALE || 1) });
  for (const check of report.checks) {
    assert.ok(check.changed > 0, `${check.field} has no visible pixel changes`);
    assert.equal(check.forbidden, 0, `${check.field} escaped its geometric/color zone`);
    assert.equal(check.irisChanged, 0, 'iris changed');
    process.stdout.write(`PASS ${check.field}: ${check.changed} local pixels, outside=0\n`);
  }
  assert.equal(report.resetDifference, 0); assert.equal(report.protectionUnchanged, true); assert.equal(report.greenExcludedUnchanged, true);
  assert.deepEqual(externalRequests, []); assert.deepEqual(rendererErrors, []);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: true, ...report, externalRequests, rendererErrors }, null, 2));
  process.stdout.write('PASS fixed-baseline reset, protection alpha=1 and green exclusion; no external requests\n');
} finally { await browser.close(); }
