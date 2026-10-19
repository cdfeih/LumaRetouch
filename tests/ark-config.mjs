/**
 * 方舟完整端点、错误恢复及添加内容蒙版预览回归验收。
 * 先运行 pnpm dev，再执行 node tests/ark-config.mjs。
 * 只使用本地生成图片及虚构 Key；模型请求全部本地拦截，外部网络全部拒绝。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const outputDir = path.resolve('artifacts/ark-config');
const endpoint = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const model = 'doubao-seedream-5-0-flash-260915';
const fakeKey = 'qa-ark-only-key-never-save';
const executablePath = [process.env.LUMA_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
const page = await context.newPage();
const events = [], requests = [], externalRequests = [], consoleErrors = [], interceptionErrors = [];
let responseImage;
await mkdir(outputDir, { recursive: true });
page.on('pageerror', error => consoleErrors.push(error.message));
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url.startsWith('data:') || url.startsWith('blob:') || new URL(url).origin === new URL(baseUrl).origin) return route.continue();
  externalRequests.push(url);
  return route.abort('blockedbyclient');
});
await page.route('**/__native/request', async route => {
  try {
    const req = route.request().postDataJSON();
    assert.equal(req.url, endpoint, '完整端点只能包含一次 images/generations');
    assert.equal((req.url.match(/\/images\/generations/g) || []).length, 1);
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.Authorization, `Bearer ${fakeKey}`);
    const body = JSON.parse(req.body);
    assert.equal(body.model, model);
    assert.equal(body.size, '2K');
    assert.equal(body.response_format, 'b64_json');
    assert.ok(Array.isArray(body.image) && body.image.length === 2, '原图与选区guide应作为两张图传入');
    requests.push({ url: req.url, model: body.model, size: body.size, imageCount: body.image.length, prompt: body.prompt });
    const result = requests.length === 1
      ? { status: 500, body: JSON.stringify({ error: { code: 'InternalError', message: 'QA simulated service failure' } }), contentType: 'application/json' }
      : { status: 200, body: JSON.stringify({ data: [{ b64_json: responseImage }] }), contentType: 'application/json' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  } catch (error) {
    interceptionErrors.push(error instanceof Error ? error.message : String(error));
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '测试代理拒绝了不符合约定的请求' }) });
  }
});

async function check(name, action) {
  const started = Date.now();
  await action();
  events.push({ name, passed: true, elapsedMs: Date.now() - started });
  console.log(`PASS ${name}`);
}
async function settled() {
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => {
    const image = document.querySelector('.working-image');
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  });
}
async function source() {
  await settled();
  return page.locator('.working-image').getAttribute('src');
}
async function paint() {
  await page.getByRole('button', { name: '画笔', exact: true }).click();
  const canvas = page.getByTestId('mask-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 100);
  await page.mouse.move(box.x + box.width * 0.47, box.y + box.height * 0.62);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * 0.62, { steps: 8 });
  await page.mouse.up();
}
async function successfulEdit() {
  const before = await source(), count = requests.length;
  await page.locator('.run-button').click();
  await page.getByTestId('result-full').waitFor({ state: 'visible' });
  await settled();
  assert.equal(requests.length, count + 1);
  assert.notEqual(await source(), before);
  return source();
}
async function stats(dataUrl) {
  return page.evaluate(async src => {
    const bitmap = await createImageBitmap(await (await fetch(src)).blob());
    const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
    const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    return { width: c.width, height: c.height, corner: [...ctx.getImageData(0, 0, 1, 1).data] };
  }, dataUrl);
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  // Explicitly wait for current HMR-rendered controls before beginning acceptance.
  await page.getByTestId('tool-add').waitFor({ state: 'visible' });
  const fixtures = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3b7598'; ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = '#ecd1b0'; ctx.fillRect(220, 100, 160, 330);
    const original = c.toDataURL().split(',')[1];
    ctx.fillStyle = '#cc4058'; ctx.fillRect(0, 0, 640, 480);
    return { original, full: c.toDataURL().split(',')[1] };
  });
  responseImage = fixtures.full;
  await page.getByTestId('photo-input').setInputFiles({ name: 'ark-qa-original.png', mimeType: 'image/png', buffer: Buffer.from(fixtures.original, 'base64') });
  const original = await source();

  await check('方舟设置允许完整端点并解释基础地址和完整地址的关系', async () => {
    await page.locator('.settings-top').click();
    await page.locator('.provider-grid button').filter({ hasText: '火山方舟' }).click();
    await page.getByLabel('API 地址', { exact: false }).fill(endpoint);
    await page.getByLabel('模型名称／接入点 ID', { exact: true }).fill(model);
    await page.locator('.secret-input input').fill(fakeKey);
    assert.match(await page.locator('#ark-address-help').innerText(), /完整.*images\/generations/);
    await page.getByRole('button', { name: '完成设置', exact: true }).click();
    assert.equal(requests.length, 0);
  });

  await page.getByTestId('tool-add').click();
  await page.locator('#prompt').fill('添加一只猫咪，比人物更大，完整展示猫的头部与四肢');
  await paint();
  await page.getByTestId('mask-canvas').evaluate(canvas => {
    window.__arkQaMask = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  });

  await check('HTTP 500 保留当前照片与选区，不自动重试付费请求', async () => {
    await page.locator('.run-button').click();
    await page.getByRole('alert').filter({ hasText: /HTTP\s*500/ }).waitFor();
    await settled();
    assert.equal(requests.length, 1);
    assert.equal(await source(), original);
    assert.equal(await page.getByRole('button', { name: '撤销编辑', exact: true }).isDisabled(), true);
    assert.equal(await page.getByTestId('result-full').count(), 0);
    const selection = await page.getByTestId('mask-canvas').evaluate(canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((v, i) => i % 4 === 3 && v > 0));
    assert.equal(selection, true);
    await page.waitForTimeout(1100);
    assert.equal(requests.length, 1);
    await page.screenshot({ path: path.join(outputDir, 'desktop-http500.png'), fullPage: true });
  });

  let masked;
  await check('手动重试一次成功后局部合成逐像素保留选区外区域', async () => {
    masked = await successfulEdit();
    assert.equal(requests.length, 2);
    const evidence = await page.evaluate(async ({ before, after }) => {
      async function pixels(src) {
        const image = await createImageBitmap(await (await fetch(src)).blob());
        const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
        const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0); image.close();
        return ctx.getImageData(0, 0, c.width, c.height).data;
      }
      const a = await pixels(before), b = await pixels(after), mask = window.__arkQaMask;
      let outsideChanged = 0, insideChanged = 0;
      for (let i = 0; i < a.length; i += 4) {
        const changed = a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3];
        if (changed) { if (mask[i + 3] === 0) outsideChanged++; else insideChanged++; }
      }
      return { outsideChanged, insideChanged };
    }, { before: original, after: masked });
    assert.equal(evidence.outsideChanged, 0);
    assert.ok(evidence.insideChanged > 100);
    events.push({ name: '局部保护像素证据', ...evidence, passed: true });
    await page.screenshot({ path: path.join(outputDir, 'desktop-selection-review.png'), fullPage: true });
  });

  await check('完整模型画面和选区结果本地切换不调用模型、不增加编辑次数', async () => {
    const count = requests.length;
    const editLabel = await page.locator('.document-tag').innerText();
    await page.getByTestId('result-full').click();
    await settled();
    assert.deepEqual(await stats(await source()), { width: 640, height: 480, corner: [204, 64, 88, 255] });
    assert.equal(await page.locator('.document-tag').innerText(), editLabel);
    assert.match(await page.locator('.preservation-note').innerText(), /完整画面.*背景可能变化/);
    await page.getByTestId('result-selection').click();
    await settled();
    assert.equal(await source(), masked);
    assert.equal(requests.length, count);
    assert.equal(await page.locator('.document-tag').innerText(), editLabel);
  });

  await check('撤销返回原图且清除旧的添加结果检查面板', async () => {
    await page.getByRole('button', { name: '撤销编辑', exact: true }).click();
    assert.equal(await source(), original);
    assert.equal(await page.getByTestId('result-full').count(), 0);
    assert.equal(requests.length, 2);
  });

  await paint();
  await successfulEdit();
  await check('390px触屏可切换完整画面，方舟地址说明和设置不横向溢出', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('result-full').tap();
    await settled();
    assert.deepEqual((await stats(await source())).corner, [204, 64, 88, 255]);
    await page.getByTestId('result-selection').tap();
    await settled();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(outputDir, 'android-390-add-review.png'), fullPage: true });
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(dimensions.page <= dimensions.viewport && dimensions.body <= dimensions.viewport, JSON.stringify(dimensions));
    await page.locator('.settings-top').tap();
    assert.ok(await page.locator('#ark-address-help').isVisible());
    assert.equal(await page.getByLabel('API 地址', { exact: false }).inputValue(), endpoint);
    await page.screenshot({ path: path.join(outputDir, 'android-390-ark-settings.png'), fullPage: true });
    await page.getByRole('button', { name: '关闭模型设置', exact: true }).tap();
    assert.equal(requests.length, 3);
  });

  await check('应用本地调色后不保留过时的完整模型画面入口', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: /基础调色/ }).click();
    await page.getByRole('slider', { name: '曝光', exact: true }).press('ArrowRight');
    await page.getByRole('button', { name: '应用调色', exact: true }).click();
    await settled();
    assert.equal(await page.getByTestId('result-full').count(), 0);
    assert.equal(await page.getByTestId('result-selection').count(), 0);
    assert.equal(requests.length, 3);
  });

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(interceptionErrors, []);
  assert.deepEqual(externalRequests, []);
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: true, baseUrl, modelCalls: requests.length, externalRequests, consoleErrors, events, requests }, null, 2));
  console.log(`方舟配置与添加结果检查全部通过：${outputDir}`);
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: false, baseUrl, modelCalls: requests.length, externalRequests, consoleErrors, interceptionErrors, events, failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2));
  throw error;
} finally {
  await browser.close();
}
