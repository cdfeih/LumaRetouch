/**
 * 浏览器集成验收。先运行 pnpm dev --port 5178，再运行：
 * node tests/integration.mjs
 * 仅测试环境拦截 /__native/request；所有外部网络均拒绝，无模型消费。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const outputDir = path.resolve('artifacts/integration');
const candidateBrowsers = [
  process.env.LUMA_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const executablePath = candidateBrowsers.find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const fakeKey = 'qa-session-only-key-never-save';
const events = [];
const consoleErrors = [];
const externalRequests = [];
let modelImage;
let modelCalls = 0;
let lastModelRequest;
await mkdir(outputDir, { recursive: true });
page.on('pageerror', error => consoleErrors.push(error.message));

// 不允许测试失误触发任何实际云请求，包含 CDN。
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url.startsWith(baseUrl) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
  externalRequests.push(url);
  return route.abort('blockedbyclient');
});
await page.route('**/__native/request', async route => {
  const req = route.request().postDataJSON();
  modelCalls += 1;
  lastModelRequest = req;
  assert.equal(req.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.Authorization, `Bearer ${fakeKey}`);
  assert.ok(req.multipart.files.some(file => file.field === 'image'));
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    status: 200,
    body: JSON.stringify({ data: [{ b64_json: modelImage }] }),
    contentType: 'application/json',
  }) });
});

async function check(name, action) {
  const started = Date.now();
  await action();
  events.push({ name, passed: true, elapsedMs: Date.now() - started });
  process.stdout.write(`PASS ${name}\n`);
}

async function waitForPhoto() {
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.locator('.working-image').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const img = document.querySelector('.working-image');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  });
}

async function currentSrc() {
  await waitForPhoto();
  return page.locator('.working-image').getAttribute('src');
}

async function imageStats(source) {
  return page.evaluate(async src => {
    const img = new Image(); img.src = src; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
    return { width: img.width, height: img.height, corner: Array.from(pixels.slice(0, 4)), center: Array.from(pixels.slice(((img.height / 2 | 0) * img.width + (img.width / 2 | 0)) * 4, ((img.height / 2 | 0) * img.width + (img.width / 2 | 0)) * 4 + 4)) };
  }, source);
}

let original;
let edited;
let adjusted;
try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const fixtures = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#7698ad'; ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = '#e4cbb1'; ctx.fillRect(180, 100, 280, 330);
    ctx.fillStyle = '#3a5d6d';
    for (let y = 0; y < 480; y += 40) ctx.fillRect(0, y, 160, 12);
    const png = canvas.toDataURL('image/png').split(',')[1];
    const jpeg = canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
    ctx.fillStyle = '#e53f59'; ctx.fillRect(0, 0, 640, 480);
    return { png, jpeg, model: canvas.toDataURL('image/png').split(',')[1] };
  });
  modelImage = fixtures.model;
  await page.screenshot({ path: path.join(outputDir, 'desktop-empty.png'), fullPage: true });

  await check('JPEG 与 PNG 真实解码导入、切换照片', async () => {
    await page.getByTestId('photo-input').setInputFiles([
      { name: 'qa-original.png', mimeType: 'image/png', buffer: Buffer.from(fixtures.png, 'base64') },
      { name: 'qa-original.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(fixtures.jpeg, 'base64') },
    ]);
    await waitForPhoto();
    assert.equal(await page.locator('.thumbnail').count(), 2);
    await page.getByRole('button', { name: '选择照片 qa-original.jpg', exact: true }).click();
    assert.deepEqual(await imageStats(await currentSrc()).then(({ width, height }) => ({ width, height })), { width: 640, height: 480 });
    assert.match(await currentSrc(), /^data:image\/jpeg;base64,/);
    await page.getByRole('button', { name: '选择照片 qa-original.png', exact: true }).click();
    original = await currentSrc();
    assert.match(original, /^data:image\/png;base64,/);
    assert.equal(modelCalls, 0);
  });

  await check('无 Key 启动 AI 打开设置；Key 仅保留于当前会话', async () => {
    await page.getByRole('button', { name: '开始质感磨皮', exact: true }).click();
    await page.getByRole('dialog', { name: '连接你的 AI 模型' }).waitFor();
    await page.locator('.secret-input input').fill(fakeKey);
    await page.getByRole('button', { name: '完成设置', exact: true }).click();
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert.equal(storage.includes(fakeKey), false);
    assert.equal(storage.includes('apiKey'), false);
    assert.equal(modelCalls, 0);
  });

  await check('涂抹去物缺少选区时阻止上传', async () => {
    await page.getByRole('button', { name: /涂抹去物.*OBJECT REMOVAL/ }).click();
    await page.getByRole('button', { name: '开始涂抹去物', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '先用画笔涂过需要移除的物体' }).waitFor();
    assert.equal(modelCalls, 0);
  });

  await check('撤回首笔与擦除至空按真实 alpha 刷新选区，空选区不上传且擦除可撤回', async () => {
    const box = await page.getByTestId('mask-canvas').boundingBox();
    assert.ok(box && box.width > 100);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const selectionTitle = page.locator('.property-title').filter({ hasText: '局部选区' }).locator('span');
    const selectedPixels = () => page.getByTestId('mask-canvas').evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let selected = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) selected++;
      return selected;
    });
    const undoMask = page.getByRole('button', { name: '撤回涂抹', exact: true });
    await page.mouse.click(center.x, center.y);
    const firstPaintPixels = await selectedPixels();
    assert.ok(firstPaintPixels > 100);
    assert.equal(await selectionTitle.innerText(), '已涂选');
    await undoMask.click();
    assert.equal(await selectedPixels(), 0);
    assert.equal(await selectionTitle.innerText(), '未涂选');
    assert.equal(await undoMask.isDisabled(), true);
    await page.getByRole('button', { name: '开始涂抹去物', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '先用画笔涂过需要移除的物体' }).waitFor();
    assert.equal(modelCalls, 0);

    await page.mouse.click(center.x, center.y);
    const beforeErasingPixels = await selectedPixels();
    assert.ok(beforeErasingPixels > 100);
    await page.getByRole('button', { name: '擦除选区', exact: true }).click();
    const brush = page.getByRole('slider', { name: '画笔大小', exact: true });
    await brush.press('End');
    await page.mouse.click(center.x, center.y);
    assert.equal(await selectedPixels(), 0);
    assert.equal(await selectionTitle.innerText(), '未涂选');
    assert.equal(await undoMask.isEnabled(), true, '擦除导致选区为空后仍必须允许撤回擦除');
    await page.getByRole('button', { name: '开始涂抹去物', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '先用画笔涂过需要移除的物体' }).waitFor();
    assert.equal(modelCalls, 0);
    await undoMask.click();
    assert.equal(await selectedPixels(), beforeErasingPixels, '撤回擦除必须恢复实际选区像素');
    assert.equal(await selectionTitle.innerText(), '已涂选');
    await page.getByRole('button', { name: '清除', exact: true }).click();
    assert.equal(await selectedPixels(), 0);
    await page.getByRole('button', { name: '画笔', exact: true }).click();
    await brush.press('Home');
    for (let i = 0; i < 33; i++) await brush.press('ArrowRight');
    assert.equal(await brush.inputValue(), '38');
    events.push({ name: '空选区状态回归像素证据', firstPaintPixels, beforeErasingPixels, emptySelectionModelCalls: modelCalls, passed: true });
  });

  await check('鼠标真实涂抹生成透明 mask 并进入选区合成流程', async () => {
    const box = await page.getByTestId('mask-canvas').boundingBox();
    assert.ok(box && box.width > 100);
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 12 });
    await page.mouse.up();
    const selection = await page.getByTestId('mask-canvas').evaluate(canvas => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      window.__qaMask = Array.from(data);
      return { selected: data.filter((_, i) => i % 4 === 3 && data[i] > 0).length, pixels: canvas.width * canvas.height };
    });
    assert.ok(selection.selected > 100 && selection.selected < selection.pixels / 2);
    await page.screenshot({ path: path.join(outputDir, 'desktop-selection.png'), fullPage: true });
    await page.getByRole('button', { name: '开始涂抹去物', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'AI 处理完成，已仅合成到涂抹区域' }).waitFor();
    edited = await currentSrc();
    assert.equal(modelCalls, 1);
    assert.ok(lastModelRequest.multipart.files.some(file => file.field === 'mask' && file.mimeType === 'image/png'));
    assert.notEqual(edited, original);
    const result = await page.evaluate(async ({ before, after }) => {
      async function pixels(source) {
        const img = new Image(); img.src = source; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
        return { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
      }
      const a = await pixels(before), b = await pixels(after), mask = window.__qaMask;
      let outsideChanged = 0, insideChanged = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const changed = a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3];
        if (changed && mask[i + 3] === 0) outsideChanged++;
        if (changed && mask[i + 3] > 0) insideChanged++;
      }
      return { outsideChanged, insideChanged, width: b.width, height: b.height };
    }, { before: original, after: edited });
    assert.equal(result.outsideChanged, 0, '选区外必须逐像素保持原样');
    assert.ok(result.insideChanged > 100);
    assert.deepEqual({ width: result.width, height: result.height }, { width: 640, height: 480 });
    events.push({ name: '选区合成像素证据', ...result, passed: true });
  });

  await check('前后对比展示原图，撤销与重做恢复确切图像', async () => {
    await page.getByRole('button', { name: '前后对比', exact: true }).click();
    assert.equal(await page.getByAltText('原始照片对比').getAttribute('src'), original);
    await page.getByRole('slider', { name: '前后对比分界' }).press('End');
    assert.match(await page.locator('.original-overlay').getAttribute('style'), /inset\(0(?:px)? 0% 0(?:px)? 0(?:px)?\)/);
    await page.getByRole('button', { name: '前后对比', exact: true }).click();
    await page.getByRole('button', { name: '撤销编辑', exact: true }).click();
    assert.equal(await currentSrc(), original);
    await page.getByRole('button', { name: '重做编辑', exact: true }).click();
    assert.equal(await currentSrc(), edited);
    assert.equal(modelCalls, 1);
  });

  await check('曝光与白平衡偏移本地处理实际改变像素且不调用云模型', async () => {
    await page.getByRole('button', { name: /基础调色/ }).click();
    for (let i = 0; i < 3; i++) await page.getByRole('slider', { name: '曝光', exact: true }).press('ArrowRight');
    for (let i = 0; i < 30; i++) await page.getByRole('slider', { name: '蓝—琥珀偏移', exact: true }).press('ArrowRight');
    await page.getByRole('button', { name: '应用调色', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已应用本地调色' }).waitFor();
    adjusted = await currentSrc();
    assert.notDeepEqual((await imageStats(adjusted)).corner, (await imageStats(edited)).corner);
    assert.equal(modelCalls, 1);
    await page.screenshot({ path: path.join(outputDir, 'desktop-edited.png'), fullPage: true });
  });

  await check('PNG 与 JPEG 导出为真实文件，维持原始尺寸', async () => {
    for (const format of ['PNG', 'JPEG']) {
      await page.getByRole('button', { name: '导出照片', exact: true }).click();
      await page.getByRole('dialog', { name: '导出你的照片' }).waitFor();
      await page.locator('.format-options button').filter({ hasText: format }).click();
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: '保存照片', exact: true }).click();
      const download = await downloadPromise;
      const saved = path.join(outputDir, download.suggestedFilename());
      await download.saveAs(saved);
      const bytes = await readFile(saved);
      assert.ok(bytes.length > 100);
      assert.equal(format === 'PNG' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : bytes[0] === 255 && bytes[1] === 216, true);
      const mime = format === 'PNG' ? 'image/png' : 'image/jpeg';
      const stats = await imageStats(`data:${mime};base64,${bytes.toString('base64')}`);
      assert.equal(stats.width, 640); assert.equal(stats.height, 480);
      if (format === 'PNG') assert.deepEqual(stats, await imageStats(adjusted));
    }
  });

  await check('390 px 安卓屏宽完整界面无横向溢出', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    const overflow = await page.evaluate(() => ({ viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
    assert.ok(overflow.pageWidth <= overflow.viewport && overflow.bodyWidth <= overflow.viewport, JSON.stringify(overflow));
    await page.screenshot({ path: path.join(outputDir, 'android-390-edited.png'), fullPage: true });
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('dialog', { name: '连接你的 AI 模型' }).waitFor();
    assert.ok(await page.locator('.settings-modal').evaluate(element => element.getBoundingClientRect().right <= innerWidth));
    await page.screenshot({ path: path.join(outputDir, 'android-390-settings.png'), fullPage: true });
    await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  });

  await check('刷新后 Key 清空，localStorage 与 sessionStorage 无密钥', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    assert.equal(await page.locator('.secret-input input').inputValue(), '');
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert.equal(storage.includes(fakeKey), false);
    assert.equal(storage.includes('apiKey'), false);
  });

  assert.deepEqual(consoleErrors, [], '浏览器不应有未捕获的 JavaScript 错误');
  assert.deepEqual(externalRequests, [], '测试不得触发外部网络');
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: true, baseUrl, modelCalls, externalRequests, consoleErrors, events }, null, 2));
  process.stdout.write(`全部集成测试通过；报告与截图：${outputDir}\n`);
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: false, baseUrl, modelCalls, externalRequests, consoleErrors, events, failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2));
  throw error;
} finally {
  await browser.close();
}
