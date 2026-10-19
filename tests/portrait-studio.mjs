/** Real local-model UI acceptance: node tests/portrait-studio.mjs. No paid image APIs. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const outputDir = path.resolve('artifacts/portrait-studio');
const executablePath = [process.env.LUMA_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(20000);
const checks = [], externalRequests = [], rendererErrors = [];
let modelCalls = 0;
await mkdir(outputDir, { recursive: true });
page.on('pageerror', error => rendererErrors.push(error.message));
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.includes('/__native/request')) { modelCalls++; return route.abort('blockedbyclient'); }
  if (url.startsWith(baseUrl) || /^(data:|blob:)/.test(url)) return route.continue();
  externalRequests.push(url); return route.abort('blockedbyclient');
});
const tab = name => page.getByRole('tab', { name, exact: true });
const slider = name => page.getByRole('slider', { name, exact: true });
const person = n => page.getByRole('button', { name: `人物 ${n}`, exact: true });
const zero = () => page.getByRole('button', { name: '全部归零', exact: true }).click();
const run = () => page.getByRole('button', { name: '应用人像精修', exact: true }).click();
async function check(name, action) {
  const start = Date.now(); await action(); checks.push({ name, passed: true, elapsedMs: Date.now() - start });
  process.stdout.write(`PASS ${name}\n`);
}
async function settled() {
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => { const image = document.querySelector('.working-image'); return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0; });
}
async function apply() { await run(); await settled(); }
async function capture(name) {
  await settled();
  return page.evaluate(name => { window.__studioSnapshots ??= {}; window.__studioSnapshots[name] = document.querySelector('.working-image').src; return window.__studioSnapshots[name].length; }, name);
}
async function importFixture(source, name) {
  await page.getByTestId('photo-input').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(source.split(',')[1], 'base64') });
  await page.getByTestId('tool-natural').click(); await settled(); await capture('original');
}
async function fixture(file, copies = 2) {
  const source = `data:image/jpeg;base64,${(await readFile(file)).toString('base64')}`;
  return page.evaluate(async ({ source, copies }) => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width * copies; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); for (let i = 0; i < copies; i++) ctx.drawImage(image, i * image.width, 0);
    return canvas.toDataURL('image/png');
  }, { source, copies });
}
async function evidence(kind) {
  return page.evaluate(async kind => {
    const source = window.__studioSnapshots.original;
    const { detectPortraitFaces, createFaceSkinMask } = await import('/src/portrait/detection.ts');
    const image = new Image(); image.src = source; await image.decode();
    const faces = await detectPortraitFaces(source);
    let bodies = [];
    if (kind === 'body') bodies = await (await import('/src/portrait/body.ts')).detectPortraitBodies(source);
    window.__studioEvidence = { faces, bodies, width: image.width, height: image.height,
      masks: faces.map(face => createFaceSkinMask(face, image.width, image.height)) };
    return { faces: faces.length, bodies: bodies.length, width: image.width, height: image.height };
  }, kind);
}
async function difference(before, after) {
  return page.evaluate(async ({ before, after }) => {
    const decode = async name => {
      const image = new Image(); image.src = window.__studioSnapshots[name]; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, image.width, image.height).data;
    };
    const a = await decode(before), b = await decode(after), { width, height, faces, masks, bodies } = window.__studioEvidence;
    let changed = 0, rightChanged = 0, outsideSkinChanged = 0, eyeChanged = 0, featureChanged = 0, otherBodyChanged = 0;
    const eyes = new Set(), features = new Set(), indices = [33,133,159,145,263,362,386,374];
    for (const face of faces) for (const index of indices) {
      const point = face.landmarks[index], x = Math.round(point.x * width), y = Math.round(point.y * height);
      for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) {
        const pixel = yy * width + xx;
        // Eyelid landmarks lie on a boundary; sample the excluded eye side,
        // rather than adjacent cheek skin that brightness is meant to change.
        if (xx >= 0 && xx < width && yy >= 0 && yy < height && masks.every(mask => mask[pixel] === 0)) eyes.add(pixel);
      }
    }
    for (const face of faces) for (const index of [1,61,291,70,105,300,334]) {
      const point = face.landmarks[index], x = Math.round(point.x * width), y = Math.round(point.y * height);
      for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) if (xx >= 0 && xx < width && yy >= 0 && yy < height) features.add(yy * width + xx);
    }
    for (let pixel = 0; pixel < width * height; pixel++) {
      const offset = pixel * 4;
      if (![0,1,2,3].some(c => a[offset + c] !== b[offset + c])) continue;
      changed++; const x = pixel % width, y = Math.floor(pixel / width);
      if (x >= width / 2) rightChanged++;
      if (masks.length && masks.every(mask => mask[pixel] === 0)) outsideSkinChanged++;
      if (eyes.has(pixel)) eyeChanged++;
      if (features.has(pixel)) featureChanged++;
      const other = bodies[1]; if (other) {
        const mx = Math.min(other.mask.width - 1, Math.floor(x * other.mask.width / width)), my = Math.min(other.mask.height - 1, Math.floor(y * other.mask.height / height));
        if (other.mask.data[my * other.mask.width + mx] >= 128) otherBodyChanged++;
      }
    }
    return { changed, rightChanged, outsideSkinChanged, eyeChanged, featureChanged, otherBodyChanged, featureSamples: eyes.size, additionalFeatureSamples: features.size };
  }, { before, after });
}
async function setMask(kind, mode) {
  await page.evaluate(({ kind, mode }) => {
    const canvas = document.querySelector(`[data-testid="${kind}-canvas"]`), ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (mode === 'alpha1') {
      const data = ctx.createImageData(canvas.width, canvas.height);
      for (let i = 0; i < data.data.length; i += 4) { data.data[i] = 255; data.data[i + 3] = 1; }
      ctx.putImageData(data, 0, 0);
    } else if (mode === 'left' || mode === 'feather') {
      ctx.fillStyle = mode === 'feather' ? 'rgba(0,255,0,0.5)' : 'rgb(0,255,0)'; ctx.fillRect(0, 0, canvas.width / 2, canvas.height);
    }
  }, { kind, mode });
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const portraits = await fixture('tests/fixtures/mediapipe-portrait.jpg');
  const poses = await fixture('tests/fixtures/mediapipe-pose.jpg');
  await importFixture(portraits, 'two-local-faces.png');
  await page.getByRole('button', { name: '识别人像', exact: true }).click(); await settled(); await person(2).waitFor();
  const faceDetection = await evidence('face'); assert.equal(faceDetection.faces, 2);

  await check('人像精修入口与五分类完整，肤色美白和去黄改变选中面部', async () => {
    for (const name of ['一键自然精修','肤色调整','面部塑形','身体塑形','细节修饰']) assert.equal(await tab(name).count(), 1);
    await person(1).click(); await zero(); await tab('肤色调整').click();
    for (const [name, value] of [['美白提亮',70],['肤色去黄',80]]) {
      await slider(name).fill(String(value)); await apply(); await capture(name);
      const pixels = await difference('original', name); assert.ok(pixels.changed > 1000, JSON.stringify(pixels));
      assert.equal(pixels.rightChanged, 0); assert.equal(pixels.outsideSkinChanged, 0); assert.equal(pixels.eyeChanged, 0);
      checks.push({ name: `${name}像素证据`, passed: true, ...pixels });
      await zero(); await apply();
    }
    await tab('细节修饰').click();
    for (const label of ['减淡黑眼圈','牙齿提亮','眼白提亮','唇色增强']) assert.equal(await slider(label).isEnabled(), true);
  });

  await check('瘦脸、下颌与下巴真实变形，眼眉口鼻保持且其他人不变，同参不叠加、归零恢复', async () => {
    await tab('面部塑形').click();
    for (const [name, value] of [['瘦脸',85],['下颌收窄',85],['下巴长短',-80]]) {
      await zero(); await slider(name).fill(String(value)); await apply(); await capture(name);
      const pixels = await difference('original', name); assert.ok(pixels.changed > 100, `${name}: ${JSON.stringify(pixels)}`);
      assert.equal(pixels.eyeChanged, 0); assert.equal(pixels.featureChanged, 0); assert.equal(pixels.rightChanged, 0);
      await apply(); await capture('repeat'); assert.equal((await difference(name, 'repeat')).changed, 0);
      await zero(); await apply(); await capture('zero'); assert.equal((await difference('original', 'zero')).changed, 0);
      checks.push({ name: `${name}变形像素证据`, passed: true, ...pixels });
    }
    await slider('瘦脸').fill('65'); await slider('下巴长短').fill('-45'); await apply();
    await page.screenshot({ path: path.join(outputDir, 'face-shape.png'), fullPage: true });
  });

  await check('绿色范围与半透明羽化固定，alpha 为 1 的红色保护仍保留全部像素', async () => {
    await zero(); await apply(); await page.getByRole('button', { name: '所有人', exact: true }).click(); await zero();
    await slider('瘦脸').fill('80'); await setMask('mask', 'feather'); await apply(); await capture('feather');
    const pixels = await difference('original', 'feather'); assert.ok(pixels.changed > 100); assert.equal(pixels.rightChanged, 0);
    await apply(); await capture('feather-repeat'); assert.equal((await difference('feather', 'feather-repeat')).changed, 0);
    await setMask('mask', 'clear'); await setMask('protection', 'alpha1');
    await slider('瘦脸').fill('95'); await apply(); await capture('red');
    assert.equal((await difference('feather', 'red')).changed, 0);
    await setMask('protection', 'clear');
    checks.push({ name: '绿色羽化范围像素证据', passed: true, ...pixels });
  });

  await check('body-only 双人真实定位，四项身体塑形生效且另一人不变，可重复应用与归零', async () => {
    await importFixture(poses, 'two-local-poses.png'); await tab('身体塑形').click();
    await page.getByRole('button', { name: '识别人像与身体', exact: true }).click(); await settled(); await person(2).waitFor();
    const detected = await evidence('body'); assert.equal(detected.bodies, 2); assert.equal(detected.faces, 0);
    await person(1).click(); await zero();
    for (const [name, value] of [['瘦腰',90],['瘦手臂',90],['瘦腿',90],['肩宽微调',-90]]) {
      assert.equal(await slider(name).isEnabled(), true); await slider(name).fill(String(value)); await apply(); await capture(name);
      const pixels = await difference('original', name); assert.ok(pixels.changed > 100, `${name}: ${JSON.stringify(pixels)}`);
      assert.equal(pixels.rightChanged, 0); assert.equal(pixels.otherBodyChanged, 0);
      await apply(); await capture('body-repeat'); assert.equal((await difference(name, 'body-repeat')).changed, 0);
      await zero(); await apply(); await capture('body-zero'); assert.equal((await difference('original', 'body-zero')).changed, 0);
      checks.push({ name: `${name}身体像素证据`, passed: true, ...pixels });
    }
    await slider('瘦腰').fill('80'); await slider('瘦手臂').fill('70'); await apply();
    await page.screenshot({ path: path.join(outputDir, 'body-two-people.png'), fullPage: true });
  });

  await check('半身人物不启用不可见腿部，局部身体塑形支持红保护与绿色范围', async () => {
    await importFixture(portraits, 'two-half-body-portraits.png'); await tab('身体塑形').click();
    await page.getByRole('button', { name: '识别人像与身体', exact: true }).click(); await settled();
    await person(1).click(); await zero(); assert.equal(await slider('瘦腿').isDisabled(), true);
    await importFixture(poses, 'pose-masks.png'); await tab('身体塑形').click();
    await page.getByRole('button', { name: '识别人像与身体', exact: true }).click(); await settled(); await evidence('body');
    await zero(); await slider('瘦腰').fill('95'); await setMask('mask', 'left'); await apply(); await capture('body-green');
    const pixels = await difference('original', 'body-green'); assert.ok(pixels.changed > 100); assert.equal(pixels.rightChanged, 0);
    await setMask('mask', 'clear'); await setMask('protection', 'alpha1'); await slider('瘦腰').fill('20'); await apply(); await capture('body-red');
    assert.equal((await difference('body-green', 'body-red')).changed, 0); await setMask('protection', 'clear');
  });

  await check('扩展预设保存负向参数、身体与面部塑形，刷新可套用并兼容旧五项预设', async () => {
    await importFixture(portraits, 'preset-half-body-portraits.png'); await tab('身体塑形').click();
    await page.getByRole('button', { name: '识别人像与身体', exact: true }).click(); await settled(); await person(1).waitFor();
    await person(1).click(); await zero(); await slider('肩宽微调').fill('-35'); await slider('瘦腰').fill('55');
    await tab('面部塑形').click(); await slider('下巴长短').fill('-40'); await slider('瘦脸').fill('30');
    await tab('肤色调整').click(); await slider('肤色冷暖').fill('-25'); await slider('美白提亮').fill('42');
    await page.getByLabel('预设名称', { exact: true }).fill('自然精修与轻塑形'); await page.getByRole('button', { name: '保存为个人预设', exact: true }).click();
    const stored = await page.evaluate(() => localStorage.getItem('luma-natural-presets-v1'));
    assert.doesNotMatch(stored, /data:image|landmarks|thumbnail|apiKey/);
    const profile = JSON.parse(stored)[0]; assert.equal(profile.settings.shoulderWidth, -35); assert.equal(profile.settings.chinLength, -40); assert.equal(profile.settings.warmth, -25);
    await page.evaluate(() => {
      const key = 'luma-natural-presets-v1', values = JSON.parse(localStorage.getItem(key));
      values.push({ id: 'legacy-five', name: '旧版五项预设', settings: { smoothing: 27, blemish: 18, evenness: 21, brightening: 13, shine: 22 } }); localStorage.setItem(key, JSON.stringify(values));
    });
    await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('button', { name: '应用预设 自然精修与轻塑形', exact: true }).click();
    await tab('肤色调整').click(); assert.equal(await slider('肤色冷暖').inputValue(), '-25'); assert.equal(await slider('美白提亮').inputValue(), '42');
    await tab('面部塑形').click(); assert.equal(await slider('下巴长短').inputValue(), '-40'); assert.equal(await slider('瘦脸').inputValue(), '30');
    await tab('身体塑形').click(); assert.equal(await slider('肩宽微调').inputValue(), '-35'); assert.equal(await slider('瘦腰').inputValue(), '55');
    await page.getByRole('button', { name: '应用预设 旧版五项预设', exact: true }).click();
    assert.equal(await slider('瘦腰').inputValue(), '0'); assert.equal(await slider('肩宽微调').inputValue(), '0');
    await tab('一键自然精修').click(); assert.equal(await slider('轻磨皮').inputValue(), '27'); assert.equal(await slider('肤色提亮').inputValue(), '13');
  });

  await check('取消人像处理后照片不变，不留下半成品', async () => {
    await importFixture(portraits, 'cancel-local-portrait.png'); await tab('面部塑形').click(); await slider('瘦脸').fill('80');
    // Hold real worker messages briefly so a fast workstation can exercise the
    // same cancel control available on slower phones; no generated result stub.
    await page.evaluate(() => {
      window.__studioWorker = window.Worker;
      window.Worker = class extends window.Worker { postMessage(message, ...args) { setTimeout(() => super.postMessage(message, ...args), 600); } };
    });
    await run(); await page.getByRole('button', { name: '取消本次处理', exact: true }).click(); await settled(); await capture('cancelled');
    await evidence('face'); assert.equal((await difference('original', 'cancelled')).changed, 0);
    await page.evaluate(() => { window.Worker = window.__studioWorker; });
  });

  await check('390 px 五个分类与全部调节项可访问，无页面横向溢出', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [name, label] of [['一键自然精修','肤色提亮'],['肤色调整','美白提亮'],['面部塑形','下巴长短'],['身体塑形','肩宽微调'],['细节修饰','唇色增强']]) {
      await tab(name).scrollIntoViewIfNeeded(); await tab(name).click(); await slider(label).scrollIntoViewIfNeeded(); assert.equal(await slider(label).isVisible(), true);
    }
    await tab('面部塑形').click(); await page.screenshot({ path: path.join(outputDir, 'android-390-studio.png'), fullPage: true });
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(sizes.page <= sizes.viewport && sizes.body <= sizes.viewport, JSON.stringify(sizes));
  });

  assert.equal(modelCalls, 0); assert.deepEqual(externalRequests, []); assert.deepEqual(rendererErrors, []);
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: true, modelCalls, externalRequests, rendererErrors, checks }, null, 2));
  process.stdout.write(`人像精修工作台验收通过；报告：${outputDir}\n`);
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: false, modelCalls, externalRequests, rendererErrors, checks, failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
