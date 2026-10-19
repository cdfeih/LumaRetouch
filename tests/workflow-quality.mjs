/** New workflow acceptance: node tests/workflow-quality.mjs. Real local models; cloud output is stubbed. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const outputDir = path.resolve('artifacts/workflow-quality');
const executablePath = [process.env.LUMA_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(45000);
const checks = [], externalRequests = [], rendererErrors = [], localModels = new Set();
let modelCalls = 0, modelImage = '';
await mkdir(outputDir, { recursive: true });
page.on('pageerror', error => rendererErrors.push(error.message));
// Other development sessions may save files during this suite. Do not let HMR
// replace this test's in-memory document session in the middle of a check.
await context.routeWebSocket('**/*', socket => socket.close());
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url.includes('/__native/request')) {
    modelCalls++;
    assert.ok(modelImage, 'Only the explicit cloud-mixing fixture may request a model');
    const request = route.request().postDataJSON();
    assert.equal(request.url, 'https://api.openai.com/v1/images/edits');
    assert.equal(request.headers.Authorization, 'Bearer qa-workflow-fake-key');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: modelImage }] }) }) });
  }
  if (new URL(url).origin === new URL(baseUrl).origin || /^(data:|blob:)/.test(url)) {
    if (/\.(?:task|wasm)(?:\?|$)/.test(url)) localModels.add(url);
    return route.continue();
  }
  externalRequests.push(url); return route.abort('blockedbyclient');
});

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
async function runNatural() { await page.getByRole('button', { name: '开始一键自然精修', exact: true }).click(); await settled(); }
async function selectPhoto(name) { await page.getByRole('button', { name: `选择照片 ${name}`, exact: true }).click(); await settled(); }
async function importPng(source, name) {
  await page.getByTestId('photo-input').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(source.split(',')[1], 'base64') });
  await settled();
}
async function constantPhoto(width, height, color) {
  return page.evaluate(({ width, height, color }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); context.fillStyle = `rgb(${color.join(',')})`; context.fillRect(0, 0, width, height);
    return canvas.toDataURL('image/png');
  }, { width, height, color });
}
async function pixel(source) {
  return page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data];
  }, source);
}
async function difference(before, after) {
  return page.evaluate(async ({ before, after }) => {
    const decode = async source => {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const a = await decode(before), b = await decode(after);
    if (a.length !== b.length) throw new Error('Compared photo dimensions differ');
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) if ([0, 1, 2, 3].some(channel => a[i + channel] !== b[i + channel])) changed++;
    return changed;
  }, { before, after });
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await check('新手指南可访问，明确本地精修、画笔与导出步骤', async () => {
    await page.getByRole('button', { name: '第一次用？看 4 步入门', exact: true }).click();
    const guide = page.getByRole('dialog', { name: '4 步修出自然照片', exact: true });
    await guide.waitFor(); assert.equal(await guide.locator('ol > li').count(), 4);
    assert.match(await guide.innerText(), /绿色表示允许改，红色表示必须保留/);
    await page.keyboard.press('Escape');
    await guide.waitFor({ state: 'hidden' });
  });

  await check('真实本地模型跨照片保留45磨皮参数，同参不叠加、归零恢复A原片像素', async () => {
    const portrait = await readFile('tests/fixtures/mediapipe-portrait.jpg');
    await page.getByTestId('photo-input').setInputFiles([
      { name: 'portrait-A.jpg', mimeType: 'image/jpeg', buffer: portrait },
      { name: 'portrait-B.jpg', mimeType: 'image/jpeg', buffer: portrait },
    ]);
    await settled(); await page.getByTestId('tool-natural').click();
    const original = await current();
    await page.getByRole('slider', { name: '轻磨皮', exact: true }).fill('45');
    await runNatural(); const first = await current();
    const changed = await difference(original, first); assert.ok(changed > 100, `Retouch changed ${changed} pixels`);
    assert.ok(localModels.size > 0, 'The actual local model/wasm must have loaded');
    await selectPhoto('portrait-B.jpg');
    assert.equal(await page.getByRole('slider', { name: '轻磨皮', exact: true }).inputValue(), '28');
    await selectPhoto('portrait-A.jpg');
    assert.equal(await page.getByRole('slider', { name: '轻磨皮', exact: true }).inputValue(), '45');
    await runNatural(); const repeated = await current(); assert.equal(await difference(first, repeated), 0);
    await page.getByRole('button', { name: '全部归零', exact: true }).click(); await runNatural();
    assert.equal(await difference(original, await current()), 0);
    checks.push({ name: '跨照片人像重算像素证据', passed: true, initiallyChangedPixels: changed, repeatedChangedPixels: 0, zeroChangedPixels: 0 });
    assert.equal(modelCalls, 0);
  });

  await check('云端磨皮25%真实混合为[70,65,70]，不产生额外付费请求', async () => {
    await importPng(await constantPhoto(640, 480, [20, 40, 60]), 'cloud-mix.png');
    modelImage = (await constantPhoto(640, 480, [220, 140, 100])).split(',')[1];
    await page.getByTestId('tool-smooth').click();
    await page.getByRole('slider', { name: '精修程度', exact: true }).fill('25');
    await page.getByRole('button', { name: '开始质感磨皮', exact: true }).click();
    await page.getByRole('dialog', { name: '连接你的 AI 模型', exact: true }).waitFor();
    await page.getByRole('checkbox', { name: /记住 API Key/ }).uncheck();
    await page.locator('.secret-input input').fill('qa-workflow-fake-key');
    await page.getByRole('button', { name: '完成设置', exact: true }).click();
    await page.getByRole('button', { name: '开始质感磨皮', exact: true }).click(); await settled();
    assert.deepEqual(await pixel(await current()), [70, 65, 70, 255]); assert.equal(modelCalls, 1);
  });

  await check('照片体检手动运行，建议曝光在本机生效且不请求模型', async () => {
    const health = page.getByTestId('photo-health');
    assert.equal(await page.getByTestId('photo-health-report').count(), 0);
    await health.getByRole('button', { name: /照片体检/ }).click();
    assert.equal(await page.getByTestId('photo-health-report').count(), 0);
    await page.getByTestId('photo-health-inspect').click(); await page.getByTestId('photo-health-report').waitFor();
    assert.equal(await health.locator('svg rect').count(), 64);
    assert.match(await health.innerText(), /640 × 480 px/);
    const before = await current();
    await health.getByRole('button', { name: /应用亮度建议/ }).click(); await settled();
    const after = await current(); assert.ok(await difference(before, after) > 1000);
    const lifted = await pixel(after); assert.ok(lifted[0] > 70 && lifted[0] < 255); assert.equal(lifted[3], 255);
    assert.equal(modelCalls, 1); assert.equal(await page.getByTestId('photo-health-report').count(), 0);
    await page.screenshot({ path: path.join(outputDir, 'desktop-workflow.png'), fullPage: true });
  });

  await check('有未导出修改时拦截离开，导出PNG后当前版本显示已导出', async () => {
    const protectedUnload = await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
    assert.equal(protectedUnload, true);
    assert.match(await page.locator('.image-status').innerText(), /有未导出修改/);
    await page.getByRole('button', { name: '导出照片', exact: true }).click();
    await page.getByRole('button', { name: /PNG.*无损编码/ }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存照片', exact: true }).click();
    const download = await downloaded; await download.saveAs(path.join(outputDir, download.suggestedFilename()));
    await settled(); await page.getByRole('dialog', { name: '导出你的照片', exact: true }).waitFor({ state: 'hidden' });
    assert.match(await page.locator('.image-status').innerText(), /当前版本已导出/);
  });

  await check('4000×3000照片可达100%原像素，390px页面及批量入口均可用', async () => {
    await importPng(await constantPhoto(4000, 3000, [95, 125, 155]), 'large-photo.png');
    await page.getByRole('button', { name: '100%细节', exact: true }).click();
    const actual = await page.locator('.working-image').evaluate(image => ({ width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, original: image.naturalWidth }));
    assert.deepEqual(actual, { width: 4000, height: 3000, original: 4000 });
    assert.equal(await page.locator('.canvas-toolbar output').innerText(), '100%');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '100%细节', exact: true }).click();
    assert.equal(await page.locator('.working-image').evaluate(image => image.getBoundingClientRect().width), 4000);
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth, scrollArea: document.querySelector('.photo-scroll').scrollWidth }));
    assert.ok(sizes.page <= sizes.viewport && sizes.body <= sizes.viewport, JSON.stringify(sizes)); assert.ok(sizes.scrollArea > 4000);
    const batch = page.getByTestId('open-batch'); assert.equal(await batch.isVisible(), true);
    const box = await batch.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
    await batch.click(); await page.getByTestId('batch-studio').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape'); await page.getByTestId('batch-studio').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '第一次使用？查看修图步骤与画笔说明', exact: true }).click();
    await page.getByRole('dialog', { name: '4 步修出自然照片', exact: true }).waitFor();
    await page.screenshot({ path: path.join(outputDir, 'mobile-guide.png'), fullPage: true });
    await page.getByRole('button', { name: '关闭新手指南', exact: true }).click();
    await page.getByRole('button', { name: '适合窗口', exact: true }).click(); await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(outputDir, 'mobile-workflow.png'), fullPage: true });
    checks.push({ name: '原像素与移动布局证据', passed: true, actual, sizes });
  });

  assert.equal(modelCalls, 1); assert.deepEqual(externalRequests, []); assert.deepEqual(rendererErrors, []);
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: true, modelCalls, localModels: [...localModels], externalRequests, rendererErrors, checks }, null, 2));
  process.stdout.write(`工作流质量验收通过；报告：${outputDir}\n`);
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: false, modelCalls, localModels: [...localModels], externalRequests, rendererErrors, checks, failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
