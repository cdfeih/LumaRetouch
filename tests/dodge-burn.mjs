/** Neutral-gray retouch acceptance: real local models/Workers, synthetic texture fixtures, no cloud. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const outputDir = path.resolve('artifacts/dodge-burn');
const executablePath = [process.env.LUMA_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(60000);
const checks = [], externalRequests = [], rendererErrors = [], localModels = new Set();
let modelCalls = 0;
await mkdir(outputDir, { recursive: true });
page.on('pageerror', error => rendererErrors.push(error.message));
page.on('dialog', dialog => dialog.accept());
await context.routeWebSocket('**/*', socket => socket.close());
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.includes('/__native/request')) { modelCalls++; return route.abort('blockedbyclient'); }
  if (new URL(url).origin === new URL(baseUrl).origin || /^(data:|blob:)/.test(url)) {
    if (/\.(?:task|wasm)(?:\?|$)/.test(url)) localModels.add(url);
    return route.continue();
  }
  externalRequests.push(url); return route.abort('blockedbyclient');
});
const legacy = { smoothing: 0, blemish: 0, evenness: 0, brightening: 0, shine: 0,
  warmth: -22, deYellow: 0, deRedness: 0, rosiness: 0,
  faceSlim: 17, jawSlim: 0, chinLength: 0, waistSlim: 23, armSlim: 0, legSlim: 0, shoulderWidth: 0,
  darkCircles: 0, teethWhitening: 40, eyeWhitening: 0, lipColor: 0 };
await context.addInitScript(settings => {
  if (!localStorage.getItem('luma-natural-presets-v1')) localStorage.setItem('luma-natural-presets-v1', JSON.stringify([{ id: 'legacy-twenty', name: '旧版20项', settings }]));
}, legacy);

const tab = name => page.getByRole('tab', { name, exact: true });
const slider = name => page.getByRole('slider', { name, exact: true });
async function check(name, action) {
  const started = Date.now(), evidence = await action(); checks.push({ name, passed: true, elapsedMs: Date.now() - started, ...evidence });
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
async function apply() { await page.getByRole('button', { name: '应用当前人像参数', exact: true }).click(); await settled(); }
async function zero() { await page.getByRole('button', { name: '全部归零', exact: true }).click(); }
async function importPortrait() {
  await page.getByTestId('photo-input').setInputFiles({ name: 'public-dodge-burn-portrait.jpg', mimeType: 'image/jpeg', buffer: await readFile('tests/fixtures/mediapipe-portrait.jpg') });
  await settled(); await page.getByTestId('tool-natural').click();
}
async function difference(before, after) {
  return page.evaluate(async ({ before, after }) => {
    const decode = async source => {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const a = await decode(before), b = await decode(after);
    if (a.width !== b.width || a.height !== b.height) throw new Error('验收前后照片尺寸不一致');
    let changed = 0, chromaChanged = 0, alphaChanged = 0;
    for (let i = 0; i < a.pixels.length; i += 4) {
      const r = b.pixels[i] - a.pixels[i], g = b.pixels[i + 1] - a.pixels[i + 1], blue = b.pixels[i + 2] - a.pixels[i + 2];
      if (r || g || blue || a.pixels[i + 3] !== b.pixels[i + 3]) changed++;
      if (r !== g || r !== blue) chromaChanged++;
      if (a.pixels[i + 3] !== b.pixels[i + 3]) alphaChanged++;
    }
    return { width: a.width, height: a.height, changed, chromaChanged, alphaChanged };
  }, { before, after });
}

let original, output35, output58;
try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await importPortrait(); original = await current();

  await check('21项新字段默认关闭，旧20项预设补零，快捷方案保留塑形并清零肤色细节', async () => {
    assert.equal(await slider('中性灰光影').inputValue(), '0');
    await page.getByRole('button', { name: '应用预设 旧版20项', exact: true }).click();
    assert.equal(await slider('中性灰光影').inputValue(), '0');
    await page.getByRole('button', { name: '中性灰磨皮', exact: true }).click();
    assert.equal(await slider('中性灰光影').inputValue(), '35');
    for (const name of ['轻磨皮', '祛痘修饰', '肤色均匀', '肤色提亮', '去油光']) assert.equal(await slider(name).inputValue(), '0');
    await tab('肤色调整').click(); assert.equal(await slider('肤色冷暖').inputValue(), '0');
    await tab('细节修饰').click(); assert.equal(await slider('牙齿提亮').inputValue(), '0');
    await tab('面部塑形').click(); assert.equal(await slider('瘦脸').inputValue(), '17');
    await tab('身体塑形').click(); assert.equal(await slider('瘦腰').inputValue(), '23');
    await zero(); await tab('一键自然精修').click();
    await page.getByRole('button', { name: '中性灰磨皮', exact: true }).click();
    assert.equal(await page.locator('.portrait-panel input[type=range]').count(), 22, '21 distinct settings plus the shared brightening alias');
  });

  await check('公开人像真实本地处理只改D&B蒙版，鼻部、眼眉口、背景与色差均保持', async () => {
    await apply(); output35 = await current();
    const diff = await difference(original, output35); assert.ok(diff.changed > 100, JSON.stringify(diff));
    assert.equal(diff.chromaChanged, 0); assert.equal(diff.alphaChanged, 0);
    const regions = await page.evaluate(async ({ original, output }) => {
      const { detectPortraitFaces, createFaceSkinMask, createFaceDodgeBurnMask } = await import('/src/portrait/detection.ts');
      const faces = await detectPortraitFaces(original); if (faces.length !== 1) throw new Error(`公开肖像应有1张脸，实际${faces.length}`);
      window.__dbPublicFace = faces[0];
      const decode = async src => {
        const image = new Image(); image.src = src; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
        return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
      };
      const a = await decode(original), b = await decode(output), skin = createFaceSkinMask(faces[0], a.width, a.height), mask = createFaceDodgeBurnMask(faces[0], a.width, a.height);
      let outsideChanged = 0, noseChanged = 0, noseSamples = 0, excludedSamples = 0;
      for (let p = 0; p < mask.length; p++) {
        const i = p * 4, changed = [0, 1, 2, 3].some(c => a.data[i + c] !== b.data[i + c]);
        if (!mask[p]) { excludedSamples++; if (changed) outsideChanged++; }
        if (skin[p] && !mask[p]) { noseSamples++; if (changed) noseChanged++; }
      }
      return { outsideChanged, noseChanged, noseSamples, excludedSamples };
    }, { original, output: output35 });
    assert.equal(regions.outsideChanged, 0); assert.equal(regions.noseChanged, 0); assert.ok(regions.noseSamples > 20);
    assert.ok(localModels.size > 0); return { ...diff, ...regions };
  });

  await check('先调暖肤色再切纯中性灰时，鼻部旧调色恢复原片且结果等于直接D&B', async () => {
    await zero(); await tab('肤色调整').click(); await slider('肤色冷暖').fill('60');
    await page.getByRole('button', { name: '应用人像精修', exact: true }).click(); await settled();
    const warmed = await current();
    const noseChanges = await page.evaluate(async ({ original, warmed }) => {
      const { createFaceSkinMask, createFaceDodgeBurnMask } = await import('/src/portrait/detection.ts');
      const decode = async src => {
        const image = new Image(); image.src = src; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
        return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
      };
      const a = await decode(original), b = await decode(warmed), skin = createFaceSkinMask(window.__dbPublicFace, a.width, a.height), mask = createFaceDodgeBurnMask(window.__dbPublicFace, a.width, a.height);
      let changed = 0;
      for (let p = 0; p < skin.length; p++) if (skin[p] && !mask[p] && [0, 1, 2].some(c => a.data[p * 4 + c] !== b.data[p * 4 + c])) changed++;
      return changed;
    }, { original, warmed });
    assert.ok(noseChanges > 10, `旧暖色设置应真正改过鼻部，实际${noseChanges}`);
    await tab('一键自然精修').click(); await page.getByRole('button', { name: '中性灰磨皮', exact: true }).click(); await apply();
    assert.equal((await difference(output35, await current())).changed, 0);
    return { nosePixelsChangedByPreviousWarmth: noseChanges, directDodgeBurnDifference: 0 };
  });

  await check('同一底图重复不累加、归零恢复；红色alpha1像素硬保护D&B', async () => {
    await apply(); assert.equal((await difference(output35, await current())).changed, 0);
    await zero(); await apply(); assert.equal((await difference(original, await current())).changed, 0);
    await slider('中性灰光影').fill('95');
    await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid=protection-canvas]'), ctx = canvas.getContext('2d');
      const image = ctx.createImageData(canvas.width, canvas.height); for (let i = 3; i < image.data.length; i += 4) image.data[i] = 1;
      ctx.putImageData(image, 0, 0);
    });
    await apply(); assert.equal((await difference(original, await current())).changed, 0);
    await page.evaluate(() => { const canvas = document.querySelector('[data-testid=protection-canvas]'); canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); });
    await slider('中性灰光影').fill('35'); await apply(); assert.equal((await difference(output35, await current())).changed, 0);
  });

  await check('2400×1800合成明暗斑被减轻，1px棋盘高频对比保留且原尺寸合成', async () => {
    const evidence = await page.evaluate(async () => {
      const { createFaceSkinMask, createFaceDodgeBurnMask } = await import('/src/portrait/detection.ts');
      const { renderNaturalRetouch } = await import('/src/portrait/render.ts');
      const { ZERO_PORTRAIT_SETTINGS } = await import('/src/portrait/settings.ts');
      const width = 2400, height = 1800, template = window.__dbPublicFace;
      const bounds = { x: 0.2, y: 0.1, width: 0.6, height: 0.8 };
      const face = { ...template, bounds, landmarks: template.landmarks.map(p => ({ x: bounds.x + (p.x - template.bounds.x) / template.bounds.width * bounds.width, y: bounds.y + (p.y - template.bounds.y) / template.bounds.height * bounds.height })) };
      const mask = createFaceDodgeBurnMask(face, width, height), skin = createFaceSkinMask(face, width, height);
      const sigma = bounds.width * width * 0.018, guard = sigma * 3 + 25;
      const chooseSpot = fraction => {
        const target = { x: (bounds.x + bounds.width * fraction) * width, y: (bounds.y + bounds.height * 0.60) * height };
        let best, score = Infinity;
        for (let y = Math.round(target.y - 130); y <= target.y + 130; y += 6) for (let x = Math.round(target.x - 160); x <= target.x + 160; x += 6) {
          if (mask[y * width + x] !== 255) continue;
          let clear = true;
          for (let i = 0; i < 24; i++) { const angle = i * Math.PI / 12, xx = Math.round(x + Math.cos(angle) * guard), yy = Math.round(y + Math.sin(angle) * guard); if (mask[yy * width + xx] !== 255) { clear = false; break; } }
          const distance = (x - target.x) ** 2 + (y - target.y) ** 2;
          if (clear && distance < score) { score = distance; best = { x, y }; }
        }
        if (!best) throw new Error('合成fixture未找到足够大的内部皮肤区域'); return best;
      };
      const dark = chooseSpot(0.25), bright = chooseSpot(0.75);
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }), pixels = ctx.createImageData(width, height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = y * width + x, offset = p * 4, texture = (x + y) % 2 ? 4 : -4;
        const spot = -24 * Math.exp(-((x - dark.x) ** 2 + (y - dark.y) ** 2) / (2 * sigma * sigma)) + 24 * Math.exp(-((x - bright.x) ** 2 + (y - bright.y) ** 2) / (2 * sigma * sigma));
        const values = skin[p] ? [160, 132, 117].map(v => Math.round(v + texture + spot)) : [38, 58, 48];
        pixels.data.set([...values, 255], offset);
      }
      ctx.putImageData(pixels, 0, 0); const source = canvas.toDataURL('image/png');
      const settings = { ...ZERO_PORTRAIT_SETTINGS, dodgeBurn: 100 };
      const output = await renderNaturalRetouch(source, source, [{ face, settings }], { skinProtection: 'geometry' });
      const image = new Image(); image.src = output; await image.decode();
      const afterCanvas = document.createElement('canvas'); afterCanvas.width = width; afterCanvas.height = height;
      const afterCtx = afterCanvas.getContext('2d', { willReadFrequently: true }); afterCtx.drawImage(image, 0, 0);
      const after = afterCtx.getImageData(0, 0, width, height).data, before = pixels.data;
      const luma = (array, i) => array[i] * 0.2126 + array[i + 1] * 0.7152 + array[i + 2] * 0.0722;
      const spotEvidence = center => {
        let originalOffset = 0, resultOffset = 0, count = 0;
        const radius = sigma * 0.3;
        for (let y = Math.floor(center.y - radius); y <= center.y + radius; y++) for (let x = Math.floor(center.x - radius); x <= center.x + radius; x++) {
          if ((x - center.x) ** 2 + (y - center.y) ** 2 > radius * radius) continue;
          const i = (y * width + x) * 4, texture = (x + y) % 2 ? 4 : -4, reference = 160 * 0.2126 + 132 * 0.7152 + 117 * 0.0722 + texture;
          originalOffset += luma(before, i) - reference; resultOffset += luma(after, i) - reference; count++;
        }
        return { originalOffset: originalOffset / count, resultOffset: resultOffset / count, samples: count };
      };
      let changed = 0, outsideChanged = 0, chromaChanged = 0, pairs = 0, contrastBefore = 0, contrastAfter = 0;
      for (let p = 0; p < mask.length; p++) {
        const i = p * 4, dr = after[i] - before[i], dg = after[i + 1] - before[i + 1], db = after[i + 2] - before[i + 2];
        if (dr || dg || db) { changed++; if (!mask[p]) outsideChanged++; if (dr !== dg || dr !== db) chromaChanged++; }
        const x = p % width, y = Math.floor(p / width);
        const nearCorrectedSpot = Math.min((x - dark.x) ** 2 + (y - dark.y) ** 2, (x - bright.x) ** 2 + (y - bright.y) ** 2) <= (sigma * 1.5) ** 2;
        // Measure pores where the low-frequency blemishes are corrected. A
        // global average could hide texture loss inside these small regions.
        if (nearCorrectedSpot && mask[p] === 255 && mask[p + 1] === 255 && x < width - 1) {
          contrastBefore += Math.abs(luma(before, i + 4) - luma(before, i));
          contrastAfter += Math.abs(luma(after, i + 4) - luma(after, i)); pairs++;
        }
      }
      const repeated = await renderNaturalRetouch(source, output, [{ face, settings }], { skinProtection: 'geometry' });
      const reset = await renderNaturalRetouch(source, output, [{ face, settings: { ...ZERO_PORTRAIT_SETTINGS } }]);
      window.__dbSynthetic = { source, output, repeated, reset };
      return { width: image.naturalWidth, height: image.naturalHeight, changed, outsideChanged, chromaChanged, dark: spotEvidence(dark), bright: spotEvidence(bright), pairSamples: pairs, textureContrastBefore: contrastBefore / pairs, textureContrastAfter: contrastAfter / pairs, textureRatio: contrastAfter / contrastBefore };
    });
    assert.deepEqual([evidence.width, evidence.height], [2400, 1800]); assert.ok(evidence.changed > 1000, JSON.stringify(evidence));
    assert.equal(evidence.outsideChanged, 0); assert.equal(evidence.chromaChanged, 0);
    assert.ok(evidence.dark.resultOffset > evidence.dark.originalOffset + 0.1, JSON.stringify(evidence.dark));
    assert.ok(evidence.bright.resultOffset < evidence.bright.originalOffset - 0.1, JSON.stringify(evidence.bright));
    assert.ok(evidence.textureRatio >= 0.94 && evidence.textureRatio <= 1.06, JSON.stringify(evidence));
    const images = await page.evaluate(() => window.__dbSynthetic);
    assert.equal((await difference(images.output, images.repeated)).changed, 0); assert.equal((await difference(images.source, images.reset)).changed, 0);
    await writeFile(path.join(outputDir, 'synthetic-before.png'), Buffer.from(images.source.split(',')[1], 'base64'));
    await writeFile(path.join(outputDir, 'synthetic-after.png'), Buffer.from(images.output.split(',')[1], 'base64'));
    return evidence;
  });

  await check('个人预设保存D&B并跨刷新恢复，旧20项迁移后新字段仍为0', async () => {
    await slider('中性灰光影').fill('58'); await apply(); output58 = await current();
    await page.getByLabel('预设名称', { exact: true }).fill('中性灰测试预设');
    await page.getByRole('button', { name: '保存为个人预设', exact: true }).click();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('luma-natural-presets-v1')));
    const saved = stored.find(p => p.name === '中性灰测试预设'), upgraded = stored.find(p => p.name === '旧版20项');
    assert.equal(Object.keys(saved.settings).length, 21); assert.equal(saved.settings.dodgeBurn, 58); assert.equal(upgraded.settings.dodgeBurn, 0);
    assert.doesNotMatch(JSON.stringify(stored), /data:image|landmarks|apiKey/);
    await page.reload({ waitUntil: 'networkidle' }); await importPortrait();
    await page.getByRole('button', { name: '应用预设 中性灰测试预设', exact: true }).click();
    assert.equal(await slider('中性灰光影').inputValue(), '58'); await apply();
    assert.equal((await difference(output58, await current())).changed, 0);
    await page.screenshot({ path: path.join(outputDir, 'desktop-neutral-gray.png'), fullPage: true });
    return { savedSettings: saved.settings };
  });

  await check('批量当前参数传递58并与单张一致，第4推荐中性灰保纹理使用35', async () => {
    await page.getByTestId('open-batch').click(); const dialog = page.getByTestId('batch-studio'); await dialog.waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.batch-studio').textContent.includes('正在恢复本地结果记录'));
    const selector = dialog.getByTestId('batch-preset');
    assert.equal(await selector.locator('optgroup').first().locator('option').count(), 4);
    await selector.selectOption('current');
    await dialog.locator('.batch-parameters summary').click();
    assert.match(await dialog.locator('.batch-parameters summary').innerText(), /21/);
    assert.match(await dialog.locator('.batch-parameters').innerText(), /中性灰光影\s*58/);
    await dialog.getByTestId('batch-file-input').setInputFiles({ name: 'batch-neutral-gray.jpg', mimeType: 'image/jpeg', buffer: await readFile('tests/fixtures/mediapipe-portrait.jpg') });
    await dialog.getByTestId('batch-trial').click(); await dialog.getByTestId('batch-cancel').waitFor({ state: 'hidden' });
    assert.equal(await dialog.locator('.batch-row').first().getAttribute('data-status'), 'succeeded');
    const result = await page.evaluate(async () => {
      const { listBatchResults, blobBase64 } = await import('/src/batch/storage.ts'); const records = await listBatchResults();
      if (records.length !== 1) throw new Error('批量试修应只保存一张结果'); const record = records[0];
      return { settings: record.settings, image: `data:${record.blob.type};base64,${await blobBase64(record.blob)}` };
    });
    assert.equal(result.settings.dodgeBurn, 58); assert.equal((await difference(output58, result.image)).changed, 0);
    await selector.selectOption({ label: '中性灰保纹理' }); await dialog.getByTestId('batch-trial').click(); await dialog.getByTestId('batch-cancel').waitFor({ state: 'hidden' });
    const recommended = await page.evaluate(async () => {
      const { listBatchResults, blobBase64 } = await import('/src/batch/storage.ts'); const [record] = await listBatchResults();
      return { settings: record.settings, image: `data:${record.blob.type};base64,${await blobBase64(record.blob)}` };
    });
    assert.equal(recommended.settings.dodgeBurn, 35); assert.equal((await difference(output35, recommended.image)).changed, 0);
    assert.ok(Object.entries(recommended.settings).every(([key, value]) => key === 'dodgeBurn' || value === 0));
    await page.getByRole('button', { name: '关闭批量精修', exact: true }).click();
    return { currentDodgeBurn: result.settings.dodgeBurn, recommendedDodgeBurn: recommended.settings.dodgeBurn };
  });

  await check('390px新滑块与独立方案可访问，无页面横向溢出', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await slider('中性灰光影').scrollIntoViewIfNeeded();
    assert.equal(await slider('中性灰光影').isVisible(), true); assert.equal(await page.getByRole('button', { name: '中性灰磨皮', exact: true }).isVisible(), true);
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(sizes.page <= sizes.viewport && sizes.body <= sizes.viewport, JSON.stringify(sizes));
    await page.screenshot({ path: path.join(outputDir, 'mobile-neutral-gray.png'), fullPage: true }); return sizes;
  });

  assert.equal(modelCalls, 0); assert.deepEqual(externalRequests, []); assert.deepEqual(rendererErrors, []);
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: true, modelCalls, localModels: [...localModels], externalRequests, rendererErrors, checks }, null, 2));
  process.stdout.write(`中性灰光影验收通过；报告：${outputDir}\n`);
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: false, modelCalls, localModels: [...localModels], externalRequests, rendererErrors, checks, failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
