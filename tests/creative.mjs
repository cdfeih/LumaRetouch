/**
 * 0.2 创意工具集成验收：先运行 pnpm dev，再执行 node tests/creative.mjs。
 * 模型请求在浏览器本地拦截；任何外部请求都会被阻断，不使用真实 API Key。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const outputDir = path.resolve('artifacts/creative');
const executablePath = [process.env.LUMA_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, hasTouch: true });
const page = await context.newPage();
const fakeKey = 'qa-creative-only-key-never-save';
const events = [], requests = [], externalRequests = [], consoleErrors = [], interceptionErrors = [];
let modelImages = [];
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
    assert.equal(req.url, 'https://api.openai.com/v1/images/edits');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.Authorization, `Bearer ${fakeKey}`);
    assert.ok(req.multipart?.files.some(file => file.field === 'image' || file.field === 'image[]'));
    requests.push(req);
    const result = modelImages[(requests.length - 1) % modelImages.length];
    assert.ok(result);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      status: 200, body: JSON.stringify({ data: [{ b64_json: result }] }), contentType: 'application/json',
    }) });
  } catch (error) {
    interceptionErrors.push(error instanceof Error ? error.message : String(error));
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '测试代理拒绝不符合约定的请求' }) });
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
async function currentImage() {
  await settled();
  return page.locator('.working-image').getAttribute('src');
}
const tool = id => page.getByTestId(`tool-${id}`);
const hasMask = req => req.multipart.files.some(file => file.field === 'mask');
const prompt = req => req.multipart.fields.prompt;
async function noUpload() {
  const count = requests.length;
  await page.locator('.run-button').click();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.waitForTimeout(120);
  assert.equal(requests.length, count, '输入缺失时不得上传照片或触发付费请求');
  assert.ok(await page.getByRole('alert').count(), '缺少必填输入时应给出错误提示');
}
async function runEdit() {
  const before = await currentImage(), count = requests.length;
  await page.locator('.run-button').click();
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.waitForFunction(previous => document.querySelector('.working-image')?.getAttribute('src') !== previous, before);
  assert.equal(requests.length, count + 1);
  return requests.at(-1);
}
async function paint() {
  await page.getByRole('button', { name: '画笔', exact: true }).click();
  const mask = page.getByTestId('mask-canvas');
  await mask.scrollIntoViewIfNeeded();
  const box = await mask.boundingBox();
  assert.ok(box?.width > 30);
  await page.mouse.move(box.x + box.width * 0.44, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.56, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
}
async function imageStats(source) {
  return page.evaluate(async src => {
    const bitmap = await createImageBitmap(await (await fetch(src)).blob());
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    return { width: canvas.width, height: canvas.height, corner: [...ctx.getImageData(0, 0, 1, 1).data] };
  }, source);
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const fixtures = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 640, 480); gradient.addColorStop(0, '#457da8'); gradient.addColorStop(1, '#dec39d');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = '#edd4b8'; ctx.fillRect(240, 150, 160, 280);
    const original = canvas.toDataURL().split(',')[1];
    const model = ['#bb5877', '#72a883', '#ac9165', '#7a93ad', '#c297b3', '#728da1', '#b3a265', '#91b6ab'].map(color => {
      ctx.fillStyle = color; ctx.fillRect(0, 0, 640, 480); return canvas.toDataURL().split(',')[1];
    });
    canvas.width = 320; canvas.height = 240;
    ctx.fillStyle = '#d2a478'; ctx.fillRect(0, 0, 320, 240);
    return { original, reference: canvas.toDataURL().split(',')[1], model };
  });
  modelImages = fixtures.model;
  await page.getByTestId('photo-input').setInputFiles({ name: 'creative-original.png', mimeType: 'image/png', buffer: Buffer.from(fixtures.original, 'base64') });
  const original = await currentImage();
  await page.locator('.settings-top').click();
  await page.locator('.secret-input input').fill(fakeKey);
  await page.getByRole('button', { name: '完成设置', exact: true }).click();

  await check('换天选择日落预设后发出包含具体天气要求的真实编辑合同', async () => {
    await tool('sky').click();
    await page.getByTestId('sky-preset-golden-hour').click();
    await page.screenshot({ path: path.join(outputDir, 'desktop-sky.png'), fullPage: true });
    const req = await runEdit();
    assert.match(prompt(req), /天空替换/);
    assert.match(prompt(req), /金色.*日落/);
    assert.match(prompt(req), /保留地面与前景主体/);
    assert.equal(hasMask(req), false);
  });

  await check('去路人无选区走语义保护主体，有选区走透明蒙版局部合成', async () => {
    await tool('people').click();
    const whole = await runEdit();
    assert.match(prompt(whole), /背景.*路人|路人.*背景/);
    assert.match(prompt(whole), /保护前景主体/);
    assert.equal(hasMask(whole), false);
    const before = await imageStats(await currentImage());
    await paint();
    const local = await runEdit();
    assert.equal(hasMask(local), true);
    assert.match(prompt(local), /此次只移除涂抹选区内/);
    assert.deepEqual((await imageStats(await currentImage())).corner, before.corner);
  });

  await check('添加内容缺描述不上传，纯文字可整图生成，有绿区时仍只编辑选区', async () => {
    await tool('add').click();
    await page.locator('#prompt').fill('');
    await noUpload();
    await page.locator('#prompt').fill('在主体旁边添加一只小红气球');
    const free = await runEdit();
    assert.equal(hasMask(free), false);
    assert.match(prompt(free), /小红气球/);
    assert.doesNotMatch(prompt(free), /仅在用户涂抹的选区内|随附选区为本次唯一可编辑范围/);
    await paint();
    await page.locator('#prompt').fill('');
    await noUpload();
    await page.locator('#prompt').fill('在选区中添加一只小红气球');
    const before = await imageStats(await currentImage());
    const req = await runEdit();
    assert.equal(hasMask(req), true);
    assert.match(prompt(req), /小红气球/);
    assert.match(prompt(req), /仅在用户涂抹的选区内/);
    assert.deepEqual((await imageStats(await currentImage())).corner, before.corner);
  });

  await check('日系摄影与治愈动画预设发送不同且不互相矛盾的执行指令', async () => {
    await tool('style').click();
    await page.locator('#prompt').fill('');
    await page.getByTestId('style-category-photo').click();
    await page.getByTestId('style-preset-japanese-clear').click();
    const photo = await runEdit();
    assert.match(prompt(photo), /日系通透/);
    assert.match(prompt(photo), /不得添加、移除或重构对象/);
    assert.match(prompt(photo), /不把照片转为插画/);
    await page.getByTestId('style-category-art').click();
    await page.getByTestId('style-preset-healing-animation').click();
    await page.screenshot({ path: path.join(outputDir, 'desktop-art-style.png'), fullPage: true });
    const art = await runEdit();
    assert.match(prompt(art), /治愈.*手绘|手绘.*治愈/);
    assert.match(prompt(art), /允许.*转绘/);
    assert.doesNotMatch(prompt(art), /不把照片转为插画|保持自然摄影质感与真实纹理/);
    assert.notEqual(prompt(photo), prompt(art));
  });

  let beforeReference, afterReference;
  await check('参考追色没有参考图不上传，导入参考图不上传，开始后发送有角色区分的双图', async () => {
    await tool('match').click();
    await noUpload();
    const count = requests.length;
    await page.getByTestId('reference-input').setInputFiles({ name: 'warm-reference.png', mimeType: 'image/png', buffer: Buffer.from(fixtures.reference, 'base64') });
    await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
    assert.equal(requests.length, count);
    assert.equal(await page.getByTestId('reference-remove').count(), 1);
    beforeReference = await currentImage();
    const req = await runEdit();
    afterReference = await currentImage();
    const images = req.multipart.files.filter(file => file.field === 'image[]');
    assert.equal(images.length, 2);
    assert.match(images[0].name, /^photo\./);
    assert.match(images[1].name, /^reference\./);
    assert.notEqual(images[0].base64, images[1].base64);
    assert.match(prompt(req), /第 2 张风格参考图/);
    assert.match(prompt(req), /不复制参考图中的人物/);
    assert.equal(hasMask(req), false);
    await page.screenshot({ path: path.join(outputDir, 'desktop-reference-match.png'), fullPage: true });
  });

  await check('新增工具后仍保留原图、确切撤销重做与原尺寸PNG导出', async () => {
    const count = requests.length;
    await page.getByRole('button', { name: '前后对比', exact: true }).click();
    assert.equal(await page.getByAltText('原始照片对比').getAttribute('src'), original);
    await page.getByRole('button', { name: '前后对比', exact: true }).click();
    await page.getByRole('button', { name: '撤销编辑', exact: true }).click();
    assert.equal(await currentImage(), beforeReference);
    await page.getByRole('button', { name: '重做编辑', exact: true }).click();
    assert.equal(await currentImage(), afterReference);
    await page.getByRole('button', { name: '导出照片', exact: true }).click();
    await page.locator('.format-options button').filter({ hasText: 'PNG' }).click();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存照片', exact: true }).click();
    const download = await downloadEvent;
    const target = path.join(outputDir, download.suggestedFilename());
    await download.saveAs(target);
    const bytes = await readFile(target);
    assert.equal(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true);
    assert.deepEqual(await imageStats(`data:image/png;base64,${bytes.toString('base64')}`), await imageStats(afterReference));
    assert.equal(requests.length, count);
  });

  await check('390px手机触屏导航可访问全部新工具且页面无横向溢出', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const id of ['smooth', 'blemish', 'remove', 'sky', 'people', 'add', 'style', 'match']) {
      await tool(id).scrollIntoViewIfNeeded();
      await tool(id).tap();
      assert.match(await tool(id).getAttribute('class'), /selected/);
    }
    await tool('style').tap();
    await page.getByTestId('style-category-art').tap();
    await page.getByTestId('style-preset-healing-animation').tap();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(outputDir, 'android-390-creative.png'), fullPage: true });
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(dimensions.page <= dimensions.viewport && dimensions.body <= dimensions.viewport, JSON.stringify(dimensions));
    await tool('match').tap();
    await page.getByTestId('reference-remove').tap();
    const count = requests.length;
    await noUpload();
    assert.equal(requests.length, count);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(outputDir, 'android-390-match.png'), fullPage: true });
    events.push({ name: '手机布局尺寸证据', ...dimensions, passed: true });
  });

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(interceptionErrors, []);
  const summaries = requests.map(req => ({ prompt: prompt(req), fileRoles: req.multipart.files.map(file => ({ field: file.field, name: file.name, mimeType: file.mimeType })) }));
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: true, baseUrl, modelCalls: requests.length, externalRequests, consoleErrors, events, requests: summaries }, null, 2));
  console.log(`0.2创意工具验收全部通过；报告与截图：${outputDir}`);
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: false, baseUrl, modelCalls: requests.length, externalRequests, consoleErrors, interceptionErrors, events, failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2));
  throw error;
} finally {
  await browser.close();
}
