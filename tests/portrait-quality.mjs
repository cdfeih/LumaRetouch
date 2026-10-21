/** Local portrait-quality contracts: real Workers/models, no external requests. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const base = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const external = [], errors = [], checks = [];
await context.route('**/*', route => {
  const url = route.request().url();
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
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  await mkdir('artifacts/portrait-quality', { recursive: true });
  await writeFile('artifacts/portrait-quality/report.json', JSON.stringify({ passed: true, checks, external, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, external, errors }, null, 2));
} finally { await browser.close(); }
