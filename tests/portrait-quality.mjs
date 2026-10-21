/** Local portrait-quality contracts: real Workers/models, no external requests. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const base = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const external = [], errors = [], checks = [], models = new Set();
let cloudCalls = 0;
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.includes('/__native/request')) { cloudCalls++; return route.abort(); }
  if (/\/models\/.*\.(?:tflite|task|wasm)(?:\?|$)/.test(url)) models.add(url);
  return url.startsWith(base) || /^(data:|blob:)/.test(url) ? route.continue() : (external.push(url), route.abort());
});
await context.routeWebSocket('**/*', socket => socket.close());
const page = await context.newPage(); page.setDefaultTimeout(90000);
page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
const settled = async () => { await page.locator('.busy-overlay').waitFor({ state: 'hidden' }); await page.waitForFunction(() => document.querySelector('.working-image')?.complete); };
const apply = async () => { await page.getByRole('button', { name: '开始一键自然精修', exact: true }).click(); await settled(); };
try {
  await page.goto(base);
  await page.getByTestId('photo-input').setInputFiles({ name: 'public-quality.jpg', mimeType: 'image/jpeg', buffer: await readFile('tests/fixtures/mediapipe-portrait.jpg') });
  await settled(); const original = await page.locator('.working-image').getAttribute('src');
  await page.getByTestId('tool-natural').click(); await page.getByRole('button', { name: '全部归零', exact: true }).click();
  await page.getByRole('slider', { name: '中性灰光影', exact: true }).fill('100');
  const expected = await page.evaluate(async original => {
    const { detectPortraitFaces, createFaceDodgeBurnMask } = await import('/src/portrait/detection.ts');
    const { buildDodgeBurnCorrection } = await import('/src/portrait/dodge-burn.ts');
    const { renderNaturalRetouch } = await import('/src/portrait/render.ts');
    const { renderPortraitWarp } = await import('/src/portrait/warp-render.ts');
    const { ZERO_PORTRAIT_SETTINGS } = await import('/src/portrait/settings.ts');
    const face = (await detectPortraitFaces(original))[0], image = new Image(); image.src = original; await image.decode();
    const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
    const source = ctx.getImageData(0, 0, c.width, c.height).data, mask = createFaceDodgeBurnMask(face, c.width, c.height);
    const field = buildDodgeBurnCorrection(source, c.width, c.height, mask);
    let best = 0; for (let p = 0; p < field.length; p++) if (Math.abs(field[p]) > Math.abs(field[best])) best = p;
    const red = document.querySelector('[data-testid=protection-canvas]'), rc = red.getContext('2d');
    rc.fillStyle = 'rgba(255,0,0,1)'; rc.beginPath(); rc.arc((best % c.width + .5) * red.width / c.width, (Math.floor(best / c.width) + .5) * red.height / c.height, 5, 0, Math.PI * 2); rc.fill();
    const green = document.querySelector('[data-testid=mask-canvas]'), gc = green.getContext('2d'); gc.fillStyle = 'rgba(0,255,0,0.5)'; gc.fillRect(0, 0, green.width, green.height);
    const subjects = [{ face, settings: { ...ZERO_PORTRAIT_SETTINGS, dodgeBurn: 100 } }];
    const skin = await renderNaturalRetouch(original, original, subjects, { protection: red });
    const omittedSkin = await renderNaturalRetouch(original, original, subjects);
    const warp = [{ face, settings: {}, previousSettings: {} }];
    const options = { protection: red, selection: green, blendBaseline: original };
    window.__portraitQuality = { original, face };
    return { correct: await renderPortraitWarp(skin, original, warp, options), omitted: await renderPortraitWarp(omittedSkin, original, warp, options), largestCorrection: Math.abs(field[best]) };
  }, original);
  await apply(); const actual = await page.locator('.working-image').getAttribute('src');
  const first = await page.evaluate(async ({ actual, expected }) => {
    const decode = async s => { const im = new Image(); im.src = s; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
    const a = await decode(actual), b = await decode(expected.correct), o = await decode(expected.omitted);
    let mismatch = 0, omittedDifference = 0; for (let i = 0; i < a.length; i += 4) { if ([0,1,2,3].some(k => a[i+k] !== b[i+k])) mismatch++; if ([0,1,2,3].some(k => o[i+k] !== b[i+k])) omittedDifference++; }
    return { mismatch, omittedDifference, largestCorrection: expected.largestCorrection };
  }, { actual, expected });
  assert.equal(first.mismatch, 0, 'Panel must forward red to analysis and apply green exactly once');
  assert.ok(first.omittedDifference > 5, `Fixture must detect the old missing-protection regression: ${JSON.stringify(first)}`);
  checks.push({ name: '主入口红保护进入分析，半透明绿色只混合一次', ...first });

  const semantic = await page.evaluate(async () => {
    const { original, face } = window.__portraitQuality;
    const { segmentFaceSkin, semanticCoverage } = await import('/src/portrait/semantic-skin.ts');
    const { planFaceWorkRegion, faceInRegion } = await import('/src/portrait/regions.ts');
    const { createFaceSkinMask } = await import('/src/portrait/detection.ts');
    const { renderNaturalRetouch } = await import('/src/portrait/render.ts');
    const { ZERO_PORTRAIT_SETTINGS } = await import('/src/portrait/settings.ts');
    const image = new Image(); image.src = original; await image.decode(); const width = image.width, height = image.height;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); const before = ctx.getImageData(0, 0, width, height).data;
    // Compare semantic gates in lossless pixels, excluding Chromium's JPEG
    // accelerated/software draw-path rounding from the algorithm contract.
    const lossless = canvas.toDataURL(); image.src = lossless; await image.decode();
    const r = planFaceWorkRegion(face, width, height), work = document.createElement('canvas'); work.width = r.workWidth; work.height = r.workHeight;
    work.getContext('2d').drawImage(image, r.x, r.y, r.width, r.height, 0, 0, work.width, work.height);
    const semantic = await segmentFaceSkin(work), mask = createFaceSkinMask(face, width, height);
    const subjects = [{ face, settings: { ...ZERO_PORTRAIT_SETTINGS, warmth: 100 } }];
    const output = new Image(); output.src = await renderNaturalRetouch(lossless, lossless, subjects); await output.decode(); ctx.drawImage(output, 0, 0); const after = ctx.getImageData(0, 0, width, height).data;
    const geometry = new Image(); geometry.src = await renderNaturalRetouch(lossless, lossless, subjects, { skinProtection: 'geometry' }); await geometry.decode(); ctx.drawImage(geometry, 0, 0); const without = ctx.getImageData(0, 0, width, height).data;
    let excluded = 0, excludedChanged = 0, preventedGeometryChanges = 0, acceptedChanged = 0;
    for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) {
      const p = y * width + x, i = p * 4; if (!mask[p]) continue;
      const changed = [0,1,2,3].some(k => before[i+k] !== after[i+k]);
      if (!semanticCoverage(semantic, x-r.x, y-r.y, r.width, r.height)) { excluded++; if (changed) excludedChanged++; if ([0,1,2].some(k => before[i+k] !== without[i+k])) preventedGeometryChanges++; }
      else if (changed) acceptedChanged++;
    }
    return { excluded, excludedChanged, preventedGeometryChanges, acceptedChanged, modelMask: [semantic.width, semantic.height], workSize: [work.width, work.height], localFaceWidth: faceInRegion(face, width, height, r).bounds.width * work.width };
  });
  assert.ok(semantic.excluded > 10, JSON.stringify(semantic)); assert.equal(semantic.excludedChanged, 0); assert.ok(semantic.preventedGeometryChanges > 10, JSON.stringify(semantic)); assert.ok(semantic.acceptedChanged > 100, JSON.stringify(semantic));
  assert.ok([...models].some(url => url.includes('selfie_multiclass_256x256.tflite')), 'real bundled segmentation weights must be loaded');
  checks.push({ name: '真实六类语义模型排除非面部皮肤与不确定区，合法皮肤仍有修饰', ...semantic });

  const roi = await page.evaluate(async () => {
    const { original, face } = window.__portraitQuality;
    const { renderNaturalRetouch } = await import('/src/portrait/render.ts');
    const { planFaceWorkRegion } = await import('/src/portrait/regions.ts');
    const { ZERO_PORTRAIT_SETTINGS } = await import('/src/portrait/settings.ts');
    const image = new Image(); image.src = original; await image.decode();
    const fixture = async (extraWidth, extraHeight, x, y) => {
      const c = document.createElement('canvas'); c.width = image.width + extraWidth; c.height = image.height + extraHeight; const ctx = c.getContext('2d'); ctx.fillStyle = '#263c30'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(image, x, y);
      const photo = c.toDataURL(), localFace = { ...face, bounds: { x: (face.bounds.x * image.width + x) / c.width, y: (face.bounds.y * image.height + y) / c.height, width: face.bounds.width * image.width / c.width, height: face.bounds.height * image.height / c.height }, landmarks: face.landmarks.map(p => ({ x: (p.x * image.width + x) / c.width, y: (p.y * image.height + y) / c.height })) };
      const output = new Image(); output.src = await renderNaturalRetouch(photo, photo, [{ face: localFace, settings: { ...ZERO_PORTRAIT_SETTINGS, warmth: 45, dodgeBurn: 35 } }]); await output.decode();
      const before = ctx.getImageData(x, y, image.width, image.height).data; ctx.drawImage(output, 0, 0); const after = ctx.getImageData(x, y, image.width, image.height).data;
      const outside = ctx.getImageData(0, 0, 1, 1).data;
      return { before: [...before], after: [...after], outside: [...outside], dimensions: [output.width, output.height], region: planFaceWorkRegion(localFace, c.width, c.height) };
    };
    const small = await fixture(400, 400, 200, 200), large = await fixture(1800, 800, 1000, 600);
    let mismatch = 0, changed = 0; for (let i = 0; i < small.after.length; i += 4) { if ([0,1,2,3].some(k => small.after[i+k] !== large.after[i+k])) mismatch++; if ([0,1,2].some(k => small.after[i+k] !== small.before[i+k])) changed++; }
    return { mismatch, changed, smallDimensions: small.dimensions, largeDimensions: large.dimensions, smallRegion: small.region, largeRegion: large.region, outside: large.outside };
  });
  assert.equal(roi.mismatch, 0, 'same native face must not change treatment with photo framing'); assert.ok(roi.changed > 100); assert.deepEqual(roi.outside, [38,60,48,255]);
  assert.equal(roi.smallRegion.workWidth, roi.largeRegion.workWidth); assert.equal(roi.smallRegion.workHeight, roi.largeRegion.workHeight);
  checks.push({ name: '相同原像素脸移入大画布，ROI修饰逐像素一致且背景不变', ...roi });

  const failedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let blockSemantic = true, blockedModels = 0;
  await failedContext.routeWebSocket('**/*', socket => socket.close());
  await failedContext.route('**/*', route => {
    const url = route.request().url();
    if (url.includes('/__native/request')) { cloudCalls++; return route.abort(); }
    if (blockSemantic && url.includes('/models/selfie_multiclass_256x256.tflite')) { blockedModels++; return route.abort(); }
    return url.startsWith(base) || /^(data:|blob:)/.test(url) ? route.continue() : (external.push(url), route.abort());
  });
  const failedPage = await failedContext.newPage(); failedPage.setDefaultTimeout(90000); failedPage.on('pageerror', error => errors.push(error.message)); failedPage.on('dialog', dialog => dialog.accept());
  await failedPage.goto(base);
  await failedPage.getByTestId('photo-input').setInputFiles({ name: 'model-failure-public.jpg', mimeType: 'image/jpeg', buffer: await readFile('tests/fixtures/mediapipe-portrait.jpg') });
  await failedPage.locator('.busy-overlay').waitFor({ state: 'hidden' });
  const beforeFailure = await failedPage.locator('.working-image').getAttribute('src');
  await failedPage.getByTestId('tool-natural').click(); await failedPage.getByRole('button', { name: '全部归零', exact: true }).click();
  await failedPage.getByRole('slider', { name: '肤色提亮', exact: true }).fill('100');
  await failedPage.getByRole('button', { name: '开始一键自然精修', exact: true }).click(); await failedPage.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.equal(await failedPage.locator('.working-image').getAttribute('src'), beforeFailure, 'missing semantic model must preserve the image');
  assert.ok(blockedModels > 0); await failedPage.getByText(/本地皮肤分割模型加载失败/).waitFor();
  blockSemantic = false;
  await failedPage.getByRole('button', { name: '开始一键自然精修', exact: true }).click(); await failedPage.locator('.busy-overlay').waitFor({ state: 'hidden' });
  assert.notEqual(await failedPage.locator('.working-image').getAttribute('src'), beforeFailure, 'a failed model load can be retried');
  checks.push({ name: '语义模型缺失时保留原照并明确报错，资源恢复后可重试', blockedModels });
  await failedContext.close();
  assert.equal(cloudCalls, 0); assert.deepEqual(external, []); assert.deepEqual(errors, []);
  await mkdir('artifacts/portrait-quality', { recursive: true });
  await writeFile('artifacts/portrait-quality/report.json', JSON.stringify({ passed: true, checks, models: [...models], cloudCalls, external, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, cloudCalls, external, errors }, null, 2));
} finally { await browser.close(); }
