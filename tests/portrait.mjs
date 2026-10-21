/** 本地人像精修验收：node tests/portrait.mjs。真实 MediaPipe，禁止云端请求和真实 Key。 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const outputDir = path.resolve('artifacts/portrait');
const executablePath = [process.env.LUMA_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const checks = [], externalRequests = [], rendererErrors = [];
let modelCalls = 0, fixtureBuffer, original;
await mkdir(outputDir, { recursive: true });
page.on('pageerror', error => rendererErrors.push(error.message));
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url.includes('/__native/request')) { modelCalls++; return route.abort('blockedbyclient'); }
  if (url.startsWith(baseUrl) || /^(data:|blob:)/.test(url)) return route.continue();
  externalRequests.push(url); return route.abort('blockedbyclient');
});

const run = () => page.getByRole('button', { name: '应用当前人像参数', exact: true }).click();
const slider = name => page.getByRole('slider', { name, exact: true });
const person = n => page.getByRole('button', { name: `人物 ${n}`, exact: true });
const allPeople = () => page.getByRole('button', { name: '所有人', exact: true });
async function check(name, action) {
  const started = Date.now(); await action();
  checks.push({ name, passed: true, elapsedMs: Date.now() - started });
  process.stdout.write(`PASS ${name}\n`);
}
async function settled() {
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => {
    const image = document.querySelector('.working-image');
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  });
}
async function current() { await settled(); return page.locator('.working-image').getAttribute('src'); }
async function setSlider(name, value) { await slider(name).fill(String(value)); }
async function runChanged() {
  const before = await current(); await run(); await settled();
  await page.waitForFunction(before => document.querySelector('.working-image')?.getAttribute('src') !== before, before);
  return current();
}
async function importFixture() {
  await page.getByTestId('photo-input').setInputFiles({ name: 'two-local-portraits.png', mimeType: 'image/png', buffer: fixtureBuffer });
  original = await current();
  await page.evaluate(source => { window.__portraitOriginal = source; }, original);
}
async function cacheEvidence() {
  return page.evaluate(async () => {
    const { detectPortraitFaces, createFaceSkinMask } = await import('/src/portrait/detection.ts');
    const image = new Image(); image.src = window.__portraitOriginal; await image.decode();
    const faces = await detectPortraitFaces(image.src);
    window.__portraitFaces = faces;
    window.__portraitMasks = faces.map(face => createFaceSkinMask(face, image.width, image.height));
    return { width: image.width, height: image.height, faces: faces.map(face => ({ id: face.id, bounds: face.bounds, landmarks: face.landmarks.length })) };
  });
}
async function pixelEvidence(before, after) {
  return page.evaluate(async ({ before, after }) => {
    const decode = async src => {
      const image = new Image(); image.src = src; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return { pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
    };
    const a = await decode(before), b = await decode(after), masks = window.__portraitMasks;
    let changed = 0, outsideSkinChanged = 0, featureChanged = 0;
    const perFace = masks.map(() => 0), featurePixels = new Set();
    // Sample every real landmark belonging to the excluded eyes/brows/lips.
    const indices = [33, 133, 159, 145, 263, 362, 386, 374, 70, 63, 105, 300, 293, 334, 61, 291, 0, 17];
    for (const face of window.__portraitFaces) for (const index of indices) {
      const p = face.landmarks[index], x = Math.min(a.width - 1, Math.floor(p.x * a.width)), y = Math.min(a.height - 1, Math.floor(p.y * a.height));
      const pixel = y * a.width + x;
      if (masks.every(mask => mask[pixel] === 0)) featurePixels.add(pixel);
    }
    for (let pixel = 0; pixel < a.width * a.height; pixel++) {
      const i = pixel * 4;
      if (![0, 1, 2, 3].some(channel => a.pixels[i + channel] !== b.pixels[i + channel])) continue;
      changed++;
      if (masks.every(mask => mask[pixel] === 0)) outsideSkinChanged++;
      masks.forEach((mask, index) => { if (mask[pixel] > 0) perFace[index]++; });
      if (featurePixels.has(pixel)) featureChanged++;
    }
    return { changed, outsideSkinChanged, perFace, featureChanged, featureSamples: featurePixels.size };
  }, { before, after });
}
async function setMask(kind, style) {
  await page.evaluate(({ kind, style }) => {
    const canvas = document.querySelector(`[data-testid="${kind}-canvas"]`), ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (style === 'all') { ctx.fillStyle = 'rgba(255,0,0,1)'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    if (style === 'left') { ctx.fillStyle = 'rgba(0,255,0,1)'; ctx.fillRect(0, 0, canvas.width / 2, canvas.height); }
  }, { kind, style });
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const portrait = `data:image/jpeg;base64,${(await readFile('tests/fixtures/mediapipe-portrait.jpg')).toString('base64')}`;
  const fixture = await page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width * 2; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); ctx.drawImage(image, image.width, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  }, portrait);
  fixtureBuffer = Buffer.from(fixture, 'base64');
  await importFixture();

  await check('无 API Key 一键自动识别真实两张人脸并精修，眼眉嘴与背景原像素保留', async () => {
    const after = await runChanged();
    assert.equal(await page.getByRole('dialog', { name: '连接你的 AI 模型' }).count(), 0);
    assert.equal(await person(1).count(), 1); assert.equal(await person(2).count(), 1);
    assert.equal(await allPeople().getAttribute('aria-pressed'), 'true');
    const detected = await cacheEvidence(); assert.equal(detected.faces.length, 2);
    assert.ok(detected.faces.every(face => face.landmarks === 478));
    const pixels = await pixelEvidence(original, after);
    assert.ok(pixels.perFace.every(value => value > 1000), JSON.stringify(pixels));
    assert.equal(pixels.outsideSkinChanged, 0); assert.equal(pixels.featureChanged, 0); assert.ok(pixels.featureSamples >= 20);
    assert.equal(modelCalls, 0); assert.deepEqual(externalRequests, []);
    checks.push({ name: '真实本地检测与像素证据', passed: true, ...detected, ...pixels });
    await page.screenshot({ path: path.join(outputDir, 'natural-two-people.png'), fullPage: true });
    await page.getByRole('button', { name: '撤销编辑', exact: true }).click(); assert.equal(await current(), original);
  });

  await check('多人参数独立，单独应用第一人时其他人及非皮肤像素不变', async () => {
    await person(1).click(); await page.getByRole('button', { name: '全部归零', exact: true }).click();
    await setSlider('肤色提亮', 75);
    await person(2).click(); assert.equal(await slider('肤色提亮').inputValue(), '16');
    await page.getByRole('button', { name: '全部归零', exact: true }).click(); await setSlider('肤色提亮', 30);
    await person(1).click(); assert.equal(await slider('肤色提亮').inputValue(), '75');
    const afterFirst = await runChanged(), first = await pixelEvidence(original, afterFirst);
    assert.ok(first.perFace[0] > 1000); assert.equal(first.perFace[1], 0); assert.equal(first.outsideSkinChanged, 0);
    await person(2).click(); assert.equal(await slider('肤色提亮').inputValue(), '30');
    const afterBoth = await runChanged(), second = await pixelEvidence(afterFirst, afterBoth);
    assert.equal(second.perFace[0], 0); assert.ok(second.perFace[1] > 1000); assert.equal(second.outsideSkinChanged, 0);
    checks.push({ name: '分人物前后两次处理像素证据', passed: true, first, second });
    await run(); await settled(); assert.equal(await current(), afterBoth, '相同参数重复应用不能叠加磨皮或提亮');
    await page.screenshot({ path: path.join(outputDir, 'individual-person-settings.png'), fullPage: true });
  });

  await check('个人预设只保存参数，同名更新，刷新后可套用和删除且不触发模型', async () => {
    await person(1).click(); const before = await current();
    await page.getByLabel('预设名称', { exact: true }).fill('我的自然肤色');
    await page.getByRole('button', { name: '保存为个人预设', exact: true }).click();
    await setSlider('肤色提亮', 67);
    await page.getByLabel('预设名称', { exact: true }).fill('我的自然肤色');
    await page.getByRole('button', { name: '保存为个人预设', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '应用预设 我的自然肤色', exact: true }).count(), 1);
    assert.equal(await current(), before);
    const saved = await page.evaluate(() => localStorage.getItem('luma-natural-presets-v1'));
    const values = JSON.parse(saved); assert.equal(values.length, 1); assert.equal(values[0].settings.brightening, 67);
    assert.deepEqual(Object.keys(values[0]).sort(), ['id', 'name', 'settings']);
    assert.doesNotMatch(saved, /data:image|apiKey|landmarks|thumbnail|face-1/);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '应用预设 我的自然肤色', exact: true }).click();
    assert.equal(await slider('肤色提亮').inputValue(), '67');
    assert.equal(await page.getByRole('dialog', { name: '连接你的 AI 模型' }).count(), 0);
    assert.equal(modelCalls, 0);
    await page.getByRole('button', { name: '删除预设 我的自然肤色', exact: true }).click();
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('button', { name: '应用预设 我的自然肤色', exact: true }).count(), 0);
  });

  await check('绿色选区限制精修范围，整图红色保护保持所有像素完全一致', async () => {
    await importFixture(); await page.getByRole('button', { name: '识别人像', exact: true }).click(); await settled();
    await person(2).waitFor(); await cacheEvidence();
    await page.getByRole('button', { name: '恢复自然参数', exact: true }).click();
    await setMask('mask', 'left');
    const after = await runChanged(), selected = await pixelEvidence(original, after);
    assert.ok(selected.perFace[0] > 1000); assert.equal(selected.perFace[1], 0); assert.equal(selected.outsideSkinChanged, 0);
    await setMask('mask', 'clear');
    await setMask('protection', 'all'); const protectedBefore = await current();
    await setSlider('肤色提亮', 95); await run(); await settled();
    assert.equal(await current(), protectedBefore);
    checks.push({ name: '绿区局部像素证据与全保护无变化', passed: true, ...selected });
    await setMask('protection', 'clear');
  });

  await check('390 px 手机精修与预设操作均可访问，无页面横向溢出', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('tool-natural').click();
    await person(1).scrollIntoViewIfNeeded(); assert.equal(await person(1).isVisible(), true);
    await slider('肤色提亮').scrollIntoViewIfNeeded(); assert.equal(await slider('肤色提亮').isVisible(), true);
    await page.getByLabel('预设名称', { exact: true }).fill('手机自然预设');
    const save = page.getByRole('button', { name: '保存为个人预设', exact: true }); await save.scrollIntoViewIfNeeded();
    assert.equal(await save.isVisible(), true); await save.click();
    assert.equal(await page.getByRole('button', { name: '应用预设 手机自然预设', exact: true }).count(), 1);
    await page.screenshot({ path: path.join(outputDir, 'android-390-portrait-presets.png'), fullPage: true });
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(sizes.page <= sizes.viewport && sizes.body <= sizes.viewport, JSON.stringify(sizes));
  });

  assert.equal(modelCalls, 0); assert.deepEqual(externalRequests, []); assert.deepEqual(rendererErrors, []);
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: true, modelCalls, externalRequests, rendererErrors, checks }, null, 2));
  process.stdout.write(`本地人像精修验收通过；报告：${outputDir}\n`);
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: false, modelCalls, externalRequests, rendererErrors, checks, failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
