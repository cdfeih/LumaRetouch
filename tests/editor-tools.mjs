/** Real UI color/crop/spot checks; cloud contract uses synthetic controlled responses. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
let outputImage = '', requests = 0;
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.includes('/__native/request')) {
    requests++;
    const request = route.request().postDataJSON();
    assert.ok(request.multipart.fields.prompt.includes('专项修饰'));
    return route.fulfill({ json: { status: 200, body: JSON.stringify({ data: [{ b64_json: outputImage }] }), contentType: 'application/json' } });
  }
  return url.startsWith(base) || /^(blob:|data:)/.test(url) ? route.continue() : route.abort();
});
await context.routeWebSocket('**/*', socket => socket.close());
const page = await context.newPage(); page.setDefaultTimeout(90000);
const errors = [], checks = []; page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
const settled = async () => { await page.locator('.busy-overlay').waitFor({ state: 'hidden' }); await page.waitForFunction(() => document.querySelector('.working-image')?.complete); };
const current = async () => { await settled(); return page.locator('.working-image').getAttribute('src'); };
const dims = () => page.locator('.working-image').evaluate(image => [image.naturalWidth, image.naturalHeight]);
const clickPhoto = async (x, y) => { const box = await page.getByTestId('mask-canvas').boundingBox(); await page.mouse.click(box.x + box.width * x, box.y + box.height * y); };
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
try {
  await page.goto(base); await page.locator('.project-loading-overlay').waitFor({ state: 'hidden' });
  const original = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480; const context = canvas.getContext('2d');
    const pixels = context.createImageData(640, 480);
    for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) {
      const i = (y * 640 + x) * 4, dot = Math.hypot(x - 320, y - 240) < 5;
      const texture = ((x * 7 + y * 11) % 5) - 2;
      pixels.data[i] = (dot ? 105 : 185) + texture; pixels.data[i + 1] = (dot ? 60 : 135) + texture; pixels.data[i + 2] = (dot ? 50 : 115) + texture; pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0); return canvas.toDataURL();
  });
  await page.getByTestId('photo-input').setInputFiles({ name: 'synthetic-editor.png', mimeType: 'image/png', buffer: Buffer.from(original.split(',')[1], 'base64') }); await settled();
  await check('advanced color controls apply and undo without losing dimensions', async () => {
    await page.getByRole('button', { name: '基础调色', exact: false }).click();
    await page.getByRole('slider', { name: '阴影', exact: true }).fill('20');
    await page.getByText('HSL 分色调整', { exact: false }).click();
    await page.getByRole('slider', { name: '橙色饱和度', exact: true }).fill('-25');
    await page.getByText('RGB 曲线', { exact: false }).click();
    await page.getByRole('button', { name: '柔和 S 曲线', exact: true }).click();
    await page.getByRole('button', { name: '应用调色', exact: true }).click();
    assert.notEqual(await current(), original); assert.deepEqual(await dims(), [640, 480]);
    await page.getByRole('button', { name: '撤销编辑', exact: true }).click(); assert.equal(await current(), original);
  });
  await check('rotation and crop restore image dimensions and aligned comparison through history', async () => {
    await page.getByRole('button', { name: '右转 90°', exact: true }).click(); await settled(); assert.deepEqual(await dims(), [480, 640]);
    await page.getByRole('button', { name: '前后对比', exact: true }).click();
    assert.deepEqual(await page.getByAltText('原始照片对比').evaluate(image => [image.naturalWidth, image.naturalHeight]), [480, 640]);
    await page.getByRole('button', { name: '前后对比', exact: true }).click();
    await page.getByRole('button', { name: '撤销编辑', exact: true }).click(); assert.deepEqual(await dims(), [640, 480]);
    await page.getByRole('button', { name: '裁剪照片', exact: true }).click();
    await page.getByRole('button', { name: '1:1', exact: true }).click(); await page.getByRole('button', { name: '应用裁剪', exact: true }).click();
    await settled(); const size = await dims(); assert.equal(size[0], size[1]);
    await page.getByRole('button', { name: '撤销编辑', exact: true }).click(); assert.equal(await current(), original);
  });
  await check('local point repair changes the blemish with no model request', async () => {
    await page.getByTestId('tool-point').click(); await clickPhoto(.5, .5);
    await page.getByRole('button', { name: '应用本地修补', exact: true }).click();
    assert.notEqual(await current(), original); assert.equal(requests, 0);
    await page.getByRole('button', { name: '撤销编辑', exact: true }).click(); assert.equal(await current(), original);
  });
  await check('one-sentence cloud point edit preserves every pixel outside its selection', async () => {
    await page.getByRole('button', { name: '一句话云端点修', exact: true }).click();
    await page.getByTestId('specialty-task-clothes-wrinkles').click();
    assert.equal(requests, 0);
    await clickPhoto(.3, .5);
    await page.getByRole('button', { name: '模型设置', exact: true }).first().click();
    await page.getByRole('button', { name: 'OpenAI', exact: true }).click();
    await page.getByPlaceholder('填写服务商提供的 API Key').fill('synthetic-ui-test-key');
    await page.getByRole('button', { name: '完成设置', exact: true }).click();
    outputImage = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 640; c.height = 480; const x = c.getContext('2d'); x.fillStyle = '#eeeeee'; x.fillRect(0, 0, 640, 480); return c.toDataURL().split(',')[1]; });
    const mask = await page.getByTestId('mask-canvas').evaluate(canvas => canvas.toDataURL());
    await page.getByRole('button', { name: '开始云端点修', exact: true }).click(); const edited = await current();
    const difference = await page.evaluate(async ({ original, edited, mask }) => {
      const read = async src => { const image = new Image(); image.src = src; await image.decode(); const c = document.createElement('canvas'); c.width = 640; c.height = 480; const x = c.getContext('2d'); x.drawImage(image, 0, 0, 640, 480); return x.getImageData(0, 0, 640, 480).data; };
      const [a, b, m] = await Promise.all([read(original), read(edited), read(mask)]); let outside = 0, inside = 0;
      for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) { if (!m[i + 3]) outside++; else inside++; }
      return { outside, inside };
    }, { original, edited, mask });
    assert.equal(difference.outside, 0); assert.ok(difference.inside > 0); assert.equal(requests, 1);
  });
  await check('cloud specialty brush prepares instructions without uploading and keeps irregular selection boundaries', async () => {
    const previousRequests = requests;
    await page.getByTestId('specialty-task-neck-lines').click();
    assert.equal(requests, previousRequests, 'choosing a specialty does not call AI');
    assert.match(await page.locator('#prompt').inputValue(), /颈/);
    await page.getByRole('button', { name: '涂选范围', exact: true }).click();
    const box = await page.getByTestId('mask-canvas').boundingBox();
    await page.mouse.move(box.x + box.width * .65, box.y + box.height * .35);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .65, box.y + box.height * .55, { steps: 8 });
    await page.mouse.move(box.x + box.width * .78, box.y + box.height * .55, { steps: 8 });
    await page.mouse.up();
    const before = await current();
    const mask = await page.getByTestId('mask-canvas').evaluate(canvas => canvas.toDataURL());
    await page.getByRole('button', { name: '开始云端点修', exact: true }).click();
    const edited = await current();
    const difference = await page.evaluate(async ({ before, edited, mask }) => {
      const read = async src => { const image = new Image(); image.src = src; await image.decode(); const c = document.createElement('canvas'); c.width = 640; c.height = 480; const x = c.getContext('2d'); x.drawImage(image, 0, 0, 640, 480); return x.getImageData(0, 0, 640, 480).data; };
      const [a, b, m] = await Promise.all([read(before), read(edited), read(mask)]); let outside = 0, inside = 0;
      for (let i = 0; i < a.length; i += 4) if ([0,1,2,3].some(k => a[i+k] !== b[i+k])) { if (!m[i+3]) outside++; else inside++; }
      return {outside, inside};
    }, {before, edited, mask});
    assert.equal(difference.outside, 0); assert.ok(difference.inside > 0);
    assert.equal(requests, previousRequests + 1);
  });
  await mkdir('artifacts/editor-tools', { recursive: true });
  await page.screenshot({ path: 'artifacts/editor-tools/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile UI should fit');
  await page.screenshot({ path: 'artifacts/editor-tools/mobile.png', fullPage: true });
  assert.deepEqual(errors, []); await writeFile('artifacts/editor-tools/report.json', JSON.stringify({ checks, requests, errors }, null, 2));
} finally { await browser.close(); }
