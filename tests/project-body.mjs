/** Real body-model + IndexedDB refresh regression. Own ephemeral Vite server;
 * no user browser, private photos, model API calls, or fixed-port leftovers. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

let server, browser, page, failure;
const external = [], errors = [], models = new Set();
let cloudCalls = 0;
const report = { passed: false };
await mkdir('artifacts/project-body', { recursive: true });
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, clearScreen: false });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object' && address.port !== 5178, 'use an owned ephemeral port');
  const base = `http://127.0.0.1:${address.port}`; report.port = address.port;
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.includes('/__native/request')) { cloudCalls++; return route.abort(); }
    if (/\/models\/.*\.(?:task|wasm|tflite)(?:\?|$)/.test(url)) models.add(url);
    return url.startsWith(base) || /^(data:|blob:)/.test(url) ? route.continue() : (external.push(url), route.abort());
  });
  page = await context.newPage(); page.setDefaultTimeout(90000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  const ready = async () => {
    await page.locator('.project-loading-overlay').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('.workspace')?.inert === false);
    await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  };
  const settled = async () => { await ready(); await page.waitForFunction(() => { const image = document.querySelector('.working-image'); return image?.complete && image.naturalWidth > 0; }); };
  const current = async () => { await settled(); return page.locator('.working-image').getAttribute('src'); };
  const apply = async () => { await page.getByRole('button', { name: '应用人像精修', exact: true }).click(); await settled(); };
  const difference = (before, after) => page.evaluate(async ({ before, after }) => {
    const decode = async source => { const image = new Image(); image.src = source; await image.decode(); const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0); return { width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data }; };
    const a = await decode(before), b = await decode(after); if (a.width !== b.width || a.height !== b.height) throw new Error('Unexpected restored dimensions');
    let pixels = 0, maximum = 0; for (let i = 0; i < a.data.length; i += 4) { let changed = false; for (let k = 0; k < 4; k++) { const n = Math.abs(a.data[i+k] - b.data[i+k]); if (n) changed = true; maximum = Math.max(maximum, n); } if (changed) pixels++; }
    return { width: a.width, height: a.height, pixels, maximum };
  }, { before, after });
  const maskEvidence = () => page.evaluate(async () => {
    const { loadProjectDraft } = await import('/src/editor/project.ts');
    const draft = await loadProjectDraft(); if (!draft) throw new Error('Missing persisted project');
    const session = draft.sessions[draft.activeId]; if (!session) throw new Error('Missing portrait session');
    const summarize = (body, from) => {
      const data = body.mask.data; let nonzero = 0; for (const n of data) if (n) nonzero++;
      return { from, id: body.id, width: body.mask.width, height: body.mask.height, typed: data instanceof Uint8ClampedArray, length: data.length, expectedLength: body.mask.width * body.mask.height, nonzero };
    };
    const masks = [...(session.detectedBodies || []).map(body => summarize(body, 'detectedBodies')), ...session.people.filter(person => person.body).map(person => summarize(person.body, 'people'))];
    return { selected: session.selected, waistSlim: session.parameters[session.selected]?.waistSlim, masks, documentCount: draft.documents.length };
  });

  await page.goto(base); await ready();
  const fixture = `data:image/jpeg;base64,${(await readFile('tests/fixtures/mediapipe-pose.jpg')).toString('base64')}`;
  // Lossless reference isolates shape/reset behavior from browser JPEG draw-path rounding.
  const source = await page.evaluate(async source => { const image = new Image(); image.src = source; await image.decode(); const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; c.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0); return c.toDataURL('image/png'); }, fixture);
  await page.getByTestId('photo-input').setInputFiles({ name: 'body-draft-public.png', mimeType: 'image/png', buffer: Buffer.from(source.split(',')[1], 'base64') });
  await settled(); await page.getByTestId('tool-natural').click();
  await page.getByRole('tab', { name: '身体塑形', exact: true }).click();
  await page.getByRole('button', { name: '识别人像与身体', exact: true }).click(); await settled();
  await page.getByRole('button', { name: '人物 1', exact: true }).click();
  await page.getByRole('button', { name: '全部归零', exact: true }).click();
  await page.getByRole('slider', { name: '瘦腰', exact: true }).fill('75');
  const original = await current(); await apply(); const shaped = await current();
  report.firstApply = await difference(original, shaped); assert.ok(report.firstApply.pixels > 100, JSON.stringify(report.firstApply));
  await page.getByRole('button', { name: '立即保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.project-status')?.classList.contains('saved'));
  report.beforeReload = await maskEvidence();
  await page.reload(); await settled();
  assert.equal(await page.getByRole('slider', { name: '瘦腰', exact: true }).inputValue(), '75');
  report.afterReload = await maskEvidence();
  for (const evidence of [report.beforeReload, report.afterReload]) {
    assert.equal(evidence.waistSlim, 75); assert.ok(evidence.masks.length >= 2);
    for (const mask of evidence.masks) { assert.equal(mask.typed, true, JSON.stringify(mask)); assert.equal(mask.length, mask.expectedLength, JSON.stringify(mask)); assert.ok(mask.nonzero > 20, JSON.stringify(mask)); }
  }
  report.reloadedPixels = await difference(shaped, await current()); assert.equal(report.reloadedPixels.pixels, 0);
  await apply(); report.repeatAfterReload = await difference(shaped, await current()); assert.equal(report.repeatAfterReload.pixels, 0);
  await page.getByRole('button', { name: '本组归零', exact: true }).click(); await apply();
  report.resetToOriginal = await difference(original, await current()); assert.equal(report.resetToOriginal.pixels, 0);
  assert.ok([...models].some(url => url.includes('pose_landmarker_lite.task')), 'use the real local pose model');
  assert.equal([...models].some(url => url.includes('selfie_multiclass_256x256.tflite')), false, 'zero color settings do not need the skin model');
  assert.equal(cloudCalls, 0); assert.deepEqual(external, []); assert.deepEqual(errors, []); report.passed = true;
} catch (error) {
  failure = error; report.failure = { message: error.message, stack: error.stack };
  await page?.screenshot({ path: 'artifacts/project-body/failure.png', fullPage: true }).catch(() => {});
} finally {
  await browser?.close(); await server?.close();
  report.serverClosed = !server?.httpServer?.listening;
  Object.assign(report, { models: [...models], cloudCalls, external, errors });
  await writeFile('artifacts/project-body/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;
