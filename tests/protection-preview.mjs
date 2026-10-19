/** 红色标记显示、纯图上传、导出隔离与错位拒绝。仅本地公开 fixture / 受控模型响应。 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const outputDir = path.resolve('artifacts/protection-preview');
const executablePath = [process.env.LUMA_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage(); page.setDefaultTimeout(30000);
const checks = [], requests = [], externalRequests = [], rendererErrors = [];
let modelBase64, expectedUpload;
await mkdir(outputDir, { recursive: true });
page.on('pageerror', error => rendererErrors.push(error.message));
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.startsWith(baseUrl) || /^(data:|blob:)/.test(url)) return route.continue();
  externalRequests.push(url); return route.abort('blockedbyclient');
});
await page.route('**/__native/request', async route => {
  const request = route.request().postDataJSON(), body = JSON.parse(request.body);
  requests.push(body);
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 200, body: JSON.stringify({ data: [{ b64_json: modelBase64 }] }) }) });
});
async function check(name, action) {
  const started = Date.now(); const evidence = await action();
  checks.push({ name, passed: true, elapsedMs: Date.now() - started, ...evidence });
  process.stdout.write(`PASS ${name}\n`);
}
async function settled() {
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => { const image = document.querySelector('.working-image'); return image?.complete && image.naturalWidth > 0; });
}
async function current() { await settled(); return page.locator('.working-image').getAttribute('src'); }
async function difference(first, second) {
  return page.evaluate(async ({ first, second }) => {
    const pixels = async src => {
      const image = new Image(); image.src = src; await image.decode();
      const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
      const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
      return { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
    };
    const a = await pixels(first), b = await pixels(second);
    if (a.width !== b.width || a.height !== b.height) throw new Error('输出改变照片尺寸');
    let changed = 0;
    for (let i = 0; i < a.data.length; i += 4) if ([0,1,2,3].some(channel => a.data[i + channel] !== b.data[i + channel])) changed++;
    return changed;
  }, { first, second });
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const portrait = `data:image/jpeg;base64,${(await readFile('tests/fixtures/mediapipe-portrait.jpg')).toString('base64')}`;
  const fixtures = await page.evaluate(async src => {
    const image = new Image(); image.src = src; await image.decode();
    const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
    const original = c.toDataURL();
    ctx.fillStyle = '#84adcf'; ctx.fillRect(20, c.height - 150, 100, 100);
    const valid = c.toDataURL().split(',')[1];
    ctx.fillStyle = '#28435d'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(image, 100, 0);
    return { original, valid, shifted: c.toDataURL().split(',')[1] };
  }, portrait);
  modelBase64 = fixtures.valid;
  await page.getByTestId('photo-input').setInputFiles({ name: 'protected-public-portrait.png', mimeType: 'image/png', buffer: Buffer.from(fixtures.original.split(',')[1], 'base64') });
  await settled(); const original = await current();
  expectedUpload = await page.evaluate(async source => (await (await import('/src/imaging/index.ts')).resizeForModel(source, 2048)).base64, original);
  const face = await page.evaluate(async source => (await (await import('/src/portrait/detection.ts')).detectPortraitFaces(source))[0].bounds, original);
  await page.getByTestId('tool-add').click();
  await page.getByRole('button', { name: '模型设置', exact: true }).first().click();
  await page.getByRole('button', { name: '火山方舟 · 豆包', exact: true }).click();
  await page.locator('.secret-input input').fill('qa-protection-preview-only');
  await page.getByRole('button', { name: '完成设置', exact: true }).click();
  await page.locator('#prompt').fill('在左下角添加一个浅蓝色方形摆件，保持人物不变');
  await page.getByRole('button', { name: '保护画笔', exact: true }).click();
  const box = await page.getByTestId('mask-canvas').boundingBox();
  await page.getByRole('slider', { name: '画笔大小', exact: true }).fill(String(Math.min(160, Math.ceil(face.width * box.width * 1.3))));
  await page.mouse.move(box.x + (face.x + face.width / 2) * box.width, box.y + (face.y + face.height * 0.25) * box.height);
  await page.mouse.down();
  await page.mouse.move(box.x + (face.x + face.width / 2) * box.width, box.y + (face.y + face.height * 1.15) * box.height, { steps: 6 });
  await page.mouse.up();
  assert.equal(await page.getByTestId('protection-canvas').evaluate(c => Number(getComputedStyle(c).opacity)), 0.5);

  await check('纯图与黑白保护参考图上传，红色显示层不进入模型输入', async () => {
    await page.locator('.run-button').click(); await settled();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].image[0], `data:image/jpeg;base64,${expectedUpload}`);
    const nonGray = await page.evaluate(async src => {
      const image = new Image(); image.src = src; await image.decode();
      const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
      const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let count = 0; for (let i = 0; i < data.length; i += 4) if (data[i] !== data[i+1] || data[i] !== data[i+2]) count++;
      return count;
    }, requests[0].image[1]);
    assert.equal(nonGray, 0);
    assert.notEqual(await current(), original);
  });
  const result = await current();
  await check('处理后自动隐藏保护标记，保护数据仍在，可独立显示和隐藏', async () => {
    assert.equal(await page.getByTestId('protection-canvas').evaluate(c => Number(getComputedStyle(c).opacity)), 0);
    const protectedPixels = await page.getByTestId('protection-canvas').evaluate(c => {
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let count = 0; for (let i = 3; i < data.length; i += 4) if (data[i]) count++; return count;
    });
    assert.ok(protectedPixels > 100);
    await page.getByTestId('protection-visibility').click();
    assert.equal(await page.getByTestId('protection-canvas').evaluate(c => Number(getComputedStyle(c).opacity)), 0.5);
    assert.equal(await current(), result);
    return { protectedPixels };
  });
  await check('即使重新显示红色标记，实际导出 PNG 与纯图结果逐像素一致', async () => {
    await page.getByRole('button', { name: '导出照片', exact: true }).click();
    await page.getByRole('button', { name: /PNG/ }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存照片', exact: true }).click();
    const download = await downloadPromise, filename = path.join(outputDir, 'export-with-visible-protection.png');
    await download.saveAs(filename); await settled();
    const exported = `data:image/png;base64,${(await readFile(filename)).toString('base64')}`;
    assert.equal(await difference(result, exported), 0);
  });
  await check('明显移动受保护头部的模型结果被拒绝，不替换照片或增加历史', async () => {
    modelBase64 = fixtures.shifted;
    const edits = await page.locator('.document-tag').innerText();
    await page.locator('.run-button').click();
    await page.getByRole('alert').filter({ hasText: /位置|移动|错位|变化|偏移/ }).waitFor();
    await settled();
    assert.equal(await current(), result);
    assert.equal(await page.locator('.document-tag').innerText(), edits);
    assert.equal(requests.length, 2);
  });
  await page.screenshot({ path: path.join(outputDir, 'protected-preview.png'), fullPage: true });
  assert.deepEqual(externalRequests, []); assert.deepEqual(rendererErrors, []);
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: true, requests: requests.length, externalRequests, rendererErrors, checks }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: false, checks, externalRequests, rendererErrors, failure: { message: error.message, stack: error.stack } }, null, 2));
  throw error;
} finally { await context.close(); await browser.close(); }
