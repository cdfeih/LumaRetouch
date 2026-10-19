/**
 * 原像素保护端到端验收。先启动开发服务，再执行：node tests/protection.mjs
 * 仅使用 Canvas 生成的测试图与假 Key，拦截本地代理并拒绝所有外网请求。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const outputDir = path.resolve('artifacts/protection');
const executablePath = [process.env.LUMA_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const checks = [];
const externalRequests = [];
const rendererErrors = [];
let modelCalls = 0;
let lastRequest;
let modelBase64;
let original;
let selectedResult;
let fullResult;
await mkdir(outputDir, { recursive: true });
page.on('pageerror', error => rendererErrors.push(error.message));
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url.startsWith(baseUrl) || /^(data:|blob:)/.test(url)) return route.continue();
  externalRequests.push(url);
  return route.abort('blockedbyclient');
});
await page.route('**/__native/request', async route => {
  lastRequest = route.request().postDataJSON();
  modelCalls++;
  assert.equal(lastRequest.url, 'https://api.openai.com/v1/images/edits');
  assert.ok(lastRequest.multipart.files.some(file => file.field === 'mask'), '保护存在时应上传扣除保护区的透明编辑 mask');
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 200, body: JSON.stringify({ data: [{ b64_json: modelBase64 }] }), contentType: 'application/json' }) });
});

async function check(name, action) {
  const started = Date.now();
  await action();
  checks.push({ name, passed: true, elapsedMs: Date.now() - started });
  process.stdout.write(`PASS ${name}\n`);
}

async function waitForPhoto() {
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => {
    const image = document.querySelector('.working-image');
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  });
}

async function currentSrc() {
  await waitForPhoto();
  return page.locator('.working-image').getAttribute('src');
}

const coverage = () => page.getByTestId('protection-canvas').evaluate(canvas => {
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let selected = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) selected++;
  return selected;
});

async function freezeProtection() {
  return page.getByTestId('protection-canvas').evaluate(canvas => {
    window.__qaFrozenProtection = Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
    return window.__qaFrozenProtection.filter((_, index) => index % 4 === 3 && window.__qaFrozenProtection[index] > 0).length;
  });
}

async function comparePixels(before, after) {
  return page.evaluate(async ({ before, after }) => {
    async function decode(src) {
      const image = new Image(); image.src = src; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return { data: context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
    }
    const a = await decode(before), b = await decode(after), protection = window.__qaFrozenProtection;
    let protectedChanged = 0, unprotectedChanged = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const changed = a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3];
      if (changed && protection[i + 3] > 0) protectedChanged++;
      if (changed && protection[i + 3] === 0) unprotectedChanged++;
    }
    return { protectedChanged, unprotectedChanged, width: b.width, height: b.height };
  }, { before, after });
}

async function checkUploadedProtection() {
  const file = lastRequest.multipart.files.find(file => file.field === 'mask');
  const protectedTransparent = await page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const mask = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const protection = window.__qaFrozenProtection;
    let unsafePixels = 0;
    for (let i = 3; i < mask.length; i += 4) if (protection[i] > 0 && mask[i] !== 255) unsafePixels++;
    return unsafePixels;
  }, file.base64);
  assert.equal(protectedTransparent, 0, '上传的透明 mask 不应开放任意保护像素');
}

async function canvasBox() {
  const box = await page.getByTestId('mask-canvas').boundingBox();
  assert.ok(box && box.width > 100);
  return box;
}

async function paintCenter() {
  const box = await canvasBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.4);
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const fixtures = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    const context = canvas.getContext('2d');
    context.fillStyle = '#7398b1'; context.fillRect(0, 0, 640, 480);
    context.fillStyle = '#285b6e';
    for (let y = 0; y < 480; y += 32) context.fillRect(0, y, 150, 9);
    // 模型 fixture 保留同位置面部结构；移除受保护头部已由新回归验证拒绝。
    const face = color => {
      context.fillStyle = color; context.beginPath(); context.arc(320, 192, 65, 0, 2 * Math.PI); context.fill();
      context.fillStyle = '#283747'; context.fillRect(290, 177, 14, 10); context.fillRect(337, 177, 14, 10);
      context.fillStyle = '#a86a61'; context.fillRect(309, 213, 27, 7);
    };
    face('#f0c8a3');
    const original = canvas.toDataURL('image/png').split(',')[1];
    context.fillStyle = '#8d9d7a'; context.fillRect(0, 0, 640, 480);
    const second = canvas.toDataURL('image/png').split(',')[1];
    context.fillStyle = '#df4967'; context.fillRect(0, 0, 640, 480);
    face('#eab9a3');
    return { original, second, model: canvas.toDataURL('image/png').split(',')[1] };
  });
  modelBase64 = fixtures.model;
  await page.getByTestId('photo-input').setInputFiles([
    { name: 'protection-qa.png', mimeType: 'image/png', buffer: Buffer.from(fixtures.original, 'base64') },
    { name: 'other-qa.png', mimeType: 'image/png', buffer: Buffer.from(fixtures.second, 'base64') },
  ]);
  original = await currentSrc();
  await page.getByRole('button', { name: '模型设置', exact: true }).first().click();
  await page.locator('.secret-input input').fill('qa-protection-fake-key-only');
  await page.getByRole('button', { name: '完成设置', exact: true }).click();

  await check('保护画笔由真实 pointer 画入保护层，擦除和撤回恢复确切像素', async () => {
    await page.getByRole('button', { name: '保护画笔', exact: true }).click();
    await page.getByRole('slider', { name: '画笔大小', exact: true }).press('End');
    await paintCenter();
    const painted = await coverage();
    assert.ok(painted > 1000);
    await page.getByRole('button', { name: '擦除保护区', exact: true }).click();
    const box = await canvasBox();
    const x = box.x + box.width / 2, y = box.y + box.height * 0.4;
    // 一个连续圆形擦除笔划覆盖原笔划的抗锯齿边缘，仍只占一条撤回记录。
    await page.mouse.move(x + 12, y);
    await page.mouse.down();
    for (let step = 1; step <= 12; step++) {
      const angle = step * Math.PI / 6;
      await page.mouse.move(x + Math.cos(angle) * 12, y + Math.sin(angle) * 12);
    }
    await page.mouse.up();
    assert.equal(await coverage(), 0);
    await page.getByRole('button', { name: '撤回涂抹', exact: true }).click();
    assert.equal(await coverage(), painted);
    checks.push({ name: '保护层擦除撤回像素证据', protectedPixels: painted, passed: true });
    assert.equal(modelCalls, 0);
  });

  await check('工具切换保留保护，编辑选区全部被保护覆盖时阻止上传', async () => {
    const beforeSwitch = await coverage();
    await page.getByTestId('tool-add').click();
    assert.equal(await coverage(), beforeSwitch);
    await page.getByRole('button', { name: '画笔', exact: true }).click();
    await page.getByRole('slider', { name: '画笔大小', exact: true }).press('Home');
    await paintCenter();
    await page.locator('#prompt').fill('在选区内添加一只完整的橘猫');
    await page.locator('.run-button').click();
    await page.getByRole('alert').filter({ hasText: /保护|选区/ }).waitFor();
    await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
    assert.equal(modelCalls, 0);
    assert.equal(await currentSrc(), original);
    await page.getByRole('button', { name: '清除', exact: true }).click();
  });

  await check('局部生成在保护边缘硬保留原始 RGBA，上传 mask 同样排除保护区', async () => {
    const brush = page.getByRole('slider', { name: '画笔大小', exact: true });
    await brush.press('Home');
    for (let i = 0; i < 33; i++) await brush.press('ArrowRight');
    const box = await canvasBox();
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.4, { steps: 18 });
    await page.mouse.up();
    assert.ok(await freezeProtection() > 1000);
    await page.locator('.run-button').click();
    await page.getByTestId('result-full').waitFor({ state: 'visible' });
    selectedResult = await currentSrc();
    const pixels = await comparePixels(original, selectedResult);
    assert.equal(pixels.protectedChanged, 0);
    assert.ok(pixels.unprotectedChanged > 100);
    await checkUploadedProtection();
    assert.equal(modelCalls, 1);
    checks.push({ name: '局部合成保护像素证据', ...pixels, passed: true });
  });

  await check('清空 live 保护层后切完整画面，任务保护快照仍生效且不再调用模型', async () => {
    const clear = page.getByRole('button', { name: '清除保护区', exact: true });
    if (await clear.isEnabled()) await clear.click();
    assert.equal(await coverage(), 0);
    await page.getByTestId('result-full').click();
    fullResult = await currentSrc();
    const fullPixels = await comparePixels(original, fullResult);
    const selectedPixels = await comparePixels(original, selectedResult);
    assert.equal(fullPixels.protectedChanged, 0);
    assert.ok(fullPixels.unprotectedChanged > selectedPixels.unprotectedChanged, '完整画面应真实展示未保护区域的模型改动');
    assert.equal(modelCalls, 1);
    await page.getByTestId('result-selection').click();
    assert.equal(await currentSrc(), selectedResult);
    await page.getByTestId('result-full').click();
    assert.equal(await currentSrc(), fullResult);
    assert.equal(modelCalls, 1);
    await page.screenshot({ path: path.join(outputDir, 'protected-full.png'), fullPage: true });
    checks.push({ name: '完整版保护快照像素证据', ...fullPixels, modelCalls, passed: true });
  });

  await check('完整版撤销回到本次 AI 前照片，不增加额外历史或请求', async () => {
    assert.equal(await page.locator('.document-tag').innerText(), '1 次编辑');
    await page.getByRole('button', { name: '撤销编辑', exact: true }).click();
    assert.equal(await currentSrc(), original);
    assert.equal(await page.getByTestId('result-full').count(), 0);
    assert.equal(modelCalls, 1);
  });

  await check('未涂编辑选区的整图 AI 同样应用保护，并上传全图减保护区 mask', async () => {
    await page.getByRole('button', { name: '保护画笔', exact: true }).click();
    await page.getByRole('slider', { name: '画笔大小', exact: true }).press('End');
    await paintCenter();
    assert.ok(await freezeProtection() > 1000);
    await page.getByTestId('tool-smooth').click();
    assert.ok(await coverage() > 1000);
    await page.locator('.run-button').click();
    await page.getByRole('status').filter({ hasText: /AI 处理完成/ }).waitFor();
    const global = await comparePixels(original, await currentSrc());
    assert.equal(global.protectedChanged, 0);
    assert.ok(global.unprotectedChanged > 100000);
    await checkUploadedProtection();
    assert.equal(modelCalls, 2);
    checks.push({ name: '整图合成保护像素证据', ...global, passed: true });
  });

  await check('切换照片清空保护层，不串用上一张的保护范围', async () => {
    await page.getByRole('button', { name: '选择照片 other-qa.png', exact: true }).click();
    await waitForPhoto();
    assert.equal(await coverage(), 0);
    await page.getByRole('button', { name: '选择照片 protection-qa.png', exact: true }).click();
    await waitForPhoto();
    assert.equal(await coverage(), 0);
    assert.equal(modelCalls, 2);
  });

  await check('390 px 保护工具界面无横向溢出', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(sizes.page <= sizes.viewport && sizes.body <= sizes.viewport, JSON.stringify(sizes));
    await page.screenshot({ path: path.join(outputDir, 'android-390-protection.png'), fullPage: true });
  });

  assert.deepEqual(externalRequests, []);
  assert.deepEqual(rendererErrors, []);
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: true, modelCalls, externalRequests, rendererErrors, checks }, null, 2));
  process.stdout.write(`保护区集成验收通过；报告：${outputDir}\n`);
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: false, modelCalls, externalRequests, rendererErrors, checks, failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2));
  throw error;
} finally {
  await browser.close();
}
