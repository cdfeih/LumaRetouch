/** 自由添加验收：node tests/free-add.mjs。全外网拒绝，仅测试图、假 Key 和受控模型 fixture。 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const outputDir = path.resolve('artifacts/free-add');
const executablePath = [process.env.LUMA_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const checks = [], requests = [], externalRequests = [], rendererErrors = [];
let modelBase64;
let original;
await mkdir(outputDir, { recursive: true });
page.on('pageerror', error => rendererErrors.push(error.message));
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url.startsWith(baseUrl) || /^(data:|blob:)/.test(url)) return route.continue();
  externalRequests.push(url);
  return route.abort('blockedbyclient');
});
await page.route('**/__native/request', async route => {
  const req = route.request().postDataJSON();
  assert.equal(req.url, 'https://api.openai.com/v1/images/edits');
  requests.push(req);
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 200, body: JSON.stringify({ data: [{ b64_json: modelBase64 }] }), contentType: 'application/json' }) });
});
const hasMask = req => req.multipart.files.some(file => file.field === 'mask');
const prompt = req => req.multipart.fields.prompt;
const brush = () => page.getByRole('slider', { name: '画笔大小', exact: true });
const run = () => page.locator('.run-button').click();

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
async function runSuccess() {
  const previous = await current(), before = requests.length;
  await run(); await settled();
  await page.waitForFunction(src => document.querySelector('.working-image')?.getAttribute('src') !== src, previous);
  assert.equal(requests.length, before + 1);
  return requests.at(-1);
}
async function runBlocked() {
  const before = requests.length, image = await current();
  await run(); await page.getByRole('alert').waitFor(); await settled();
  assert.equal(requests.length, before);
  assert.equal(await current(), image);
}
async function undoToOriginal() {
  await page.getByRole('button', { name: '撤销编辑', exact: true }).click();
  assert.equal(await current(), original);
}
async function box() {
  const bounds = await page.getByTestId('mask-canvas').boundingBox(); assert.ok(bounds && bounds.width > 100); return bounds;
}
async function centerPaint() {
  const b = await box(); await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.4);
}
async function protectFace() {
  const clear = page.getByRole('button', { name: '清除保护区', exact: true });
  if (await clear.isEnabled()) await clear.click();
  await page.getByRole('button', { name: '保护画笔', exact: true }).click();
  await brush().press('End'); await centerPaint();
}
async function captureMasks() {
  return page.evaluate(() => {
    const read = name => {
      const canvas = document.querySelector(`[data-testid="${name}"]`);
      return [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data];
    };
    window.__qaProtection = read('protection-canvas'); window.__qaGreen = read('mask-canvas');
    return { protected: window.__qaProtection.filter((v, i) => i % 4 === 3 && v > 0).length, green: window.__qaGreen.filter((v, i) => i % 4 === 3 && v > 0).length };
  });
}
async function pixelEvidence(after) {
  return page.evaluate(async ({ before, after }) => {
    const decode = async src => {
      const image = new Image(); image.src = src; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const a = await decode(before), b = await decode(after), p = window.__qaProtection, green = window.__qaGreen;
    let protectedChanged = 0, unprotectedChanged = 0, outsideGreenChanged = 0;
    for (let i = 0; i < a.length; i += 4) {
      const changed = [0, 1, 2, 3].some(channel => a[i + channel] !== b[i + channel]);
      if (!changed) continue;
      if (p[i + 3] > 0) protectedChanged++; else unprotectedChanged++;
      if (green[i + 3] === 0) outsideGreenChanged++;
    }
    return { protectedChanged, unprotectedChanged, outsideGreenChanged };
  }, { before: original, after });
}
async function uploadedProtectionComplement(req) {
  const mask = req.multipart.files.find(file => file.field === 'mask'); assert.ok(mask);
  return page.evaluate(async encoded => {
    const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data, p = window.__qaProtection;
    let protectedOpen = 0, editable = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (p[i] > 0 && data[i] !== 255) protectedOpen++;
      if (p[i] === 0 && data[i] === 0) editable++;
    }
    return { protectedOpen, editable };
  }, mask.base64);
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const fixture = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#7598b2'; ctx.fillRect(0, 0, 640, 480);
    const face = color => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(320, 192, 65, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = '#283b48'; ctx.fillRect(290, 178, 14, 10); ctx.fillRect(337, 178, 14, 10);
    };
    face('#edc9a6');
    const source = canvas.toDataURL().split(',')[1];
    ctx.fillStyle = '#dd526b'; ctx.fillRect(0, 0, 640, 480);
    // 同一头部位置但改变肤色，继续验证红区像素来自原图而非模型。
    face('#eab9a3');
    return { source, model: canvas.toDataURL().split(',')[1] };
  });
  modelBase64 = fixture.model;
  await page.getByTestId('photo-input').setInputFiles({ name: 'free-add-qa.png', mimeType: 'image/png', buffer: Buffer.from(fixture.source, 'base64') });
  original = await current();
  await page.locator('.settings-top').click(); await page.locator('.secret-input input').fill('qa-free-add-no-real-key');
  await page.getByRole('button', { name: '完成设置', exact: true }).click();
  await page.getByTestId('tool-add').click();

  await check('添加内容无描述仍拦截，绿色和红色区域均无需预先绘制', async () => {
    const masks = await captureMasks(); assert.deepEqual(masks, { protected: 0, green: 0 });
    await page.locator('#prompt').fill(''); await runBlocked(); assert.equal(requests.length, 0);
  });
  await check('仅文字描述直接单图生成，没有伪造绿色选区或 mask', async () => {
    await page.locator('#prompt').fill('在主体旁边添加一只完整的橘猫');
    const masks = await captureMasks(); assert.deepEqual(masks, { protected: 0, green: 0 });
    const req = await runSuccess(); assert.equal(hasMask(req), false);
    assert.equal(req.multipart.files.filter(file => file.field === 'image').length, 1);
    assert.doesNotMatch(prompt(req), /仅在用户涂抹的选区内|随附选区为本次唯一可编辑范围/);
    assert.ok((await pixelEvidence(await current())).unprotectedChanged > 100000);
    await undoToOriginal();
  });
  await check('只有红色保护时发送全图减保护区，保护脸眼原像素完全不变', async () => {
    await protectFace(); const masks = await captureMasks(); assert.equal(masks.green, 0); assert.ok(masks.protected > 1000);
    const req = await runSuccess(); assert.equal(hasMask(req), true);
    assert.doesNotMatch(prompt(req), /仅在用户涂抹的选区内|随附选区为本次唯一可编辑范围/);
    const uploaded = await uploadedProtectionComplement(req); assert.equal(uploaded.protectedOpen, 0); assert.ok(uploaded.editable > 100000);
    const pixels = await pixelEvidence(await current()); assert.equal(pixels.protectedChanged, 0); assert.ok(pixels.unprotectedChanged > 100000);
    checks.push({ name: '自由添加红区保护像素证据', ...pixels, ...uploaded, passed: true });
    await page.screenshot({ path: path.join(outputDir, 'protected-free-add.png'), fullPage: true });
    await undoToOriginal();
  });
  await check('可选绿色选区仍限制局部范围，红色保护保持最高优先级', async () => {
    await protectFace(); await page.getByRole('button', { name: '画笔', exact: true }).click();
    await brush().press('Home'); for (let i = 0; i < 33; i++) await brush().press('ArrowRight');
    const b = await box(); await page.mouse.move(b.x + b.width * 0.15, b.y + b.height * 0.4); await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.85, b.y + b.height * 0.4, { steps: 18 }); await page.mouse.up();
    const masks = await captureMasks(); assert.ok(masks.green > 100 && masks.protected > 1000);
    const req = await runSuccess(); assert.equal(hasMask(req), true); assert.match(prompt(req), /选区/);
    const pixels = await pixelEvidence(await current()); assert.equal(pixels.protectedChanged, 0); assert.equal(pixels.outsideGreenChanged, 0);
    assert.ok(pixels.unprotectedChanged > 100 && pixels.unprotectedChanged < 100000);
    checks.push({ name: '可选绿区局部保护像素证据', ...pixels, passed: true });
    await undoToOriginal();
  });
  await check('用户主动绘制的绿色选区全被红色保护覆盖时拒绝上传', async () => {
    await protectFace(); await page.getByRole('button', { name: '画笔', exact: true }).click(); await brush().press('Home'); await centerPaint();
    const masks = await captureMasks(); assert.ok(masks.green > 0 && masks.protected > 1000);
    await runBlocked(); assert.equal(requests.length, 3);
    await page.getByRole('button', { name: '清除', exact: true }).click();
  });
  await check('涂抹去物仍必须有绿色选区，只有红色保护不能替代编辑选区', async () => {
    await page.getByTestId('tool-remove').click();
    const masks = await captureMasks(); assert.equal(masks.green, 0);
    await runBlocked(); assert.equal(requests.length, 3);
  });
  await check('390 px 文案明确纯文字添加与保护可选，界面无横向溢出', async () => {
    await page.getByTestId('tool-add').click(); await page.setViewportSize({ width: 390, height: 844 });
    const closeToast = page.getByRole('button', { name: '关闭提示', exact: true });
    if (await closeToast.isVisible()) await closeToast.click();
    await page.waitForTimeout(100);
    const text = await page.locator('.properties-sidebar').innerText();
    assert.match(text, /描述|文字|提示/);
    assert.match(text, /无需|不必|不涂|可选|直接/);
    const size = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(size.page <= size.viewport && size.body <= size.viewport, JSON.stringify(size));
    await page.screenshot({ path: path.join(outputDir, 'android-390-free-add.png'), fullPage: true });
    assert.equal(requests.length, 3);
  });
  assert.deepEqual(externalRequests, []); assert.deepEqual(rendererErrors, []);
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: true, modelCalls: requests.length, externalRequests, rendererErrors, checks }, null, 2));
  process.stdout.write(`自由添加验收通过；报告：${outputDir}\n`);
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: false, modelCalls: requests.length, externalRequests, rendererErrors, checks, failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
