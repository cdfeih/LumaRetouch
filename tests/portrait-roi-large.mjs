/** Desktop-only large-photo acceptance; does not certify mobile memory limits. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const base = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const context = await browser.newContext(), external = [], errors = [];
let cloudCalls = 0;
await context.routeWebSocket('**/*', socket => socket.close());
await context.route('**/*', route => { const url = route.request().url(); if (url.includes('/__native/request')) { cloudCalls++; return route.abort(); } return url.startsWith(base) || /^(data:|blob:)/.test(url) ? route.continue() : (external.push(url), route.abort()); });
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(base);
  const fixture = `data:image/jpeg;base64,${(await readFile('tests/fixtures/mediapipe-portrait.jpg')).toString('base64')}`;
  const report = await page.evaluate(async fixture => {
    const { detectPortraitFaces } = await import('/src/portrait/detection.ts');
    const { renderNaturalRetouch } = await import('/src/portrait/render.ts');
    const { planFaceWorkRegion } = await import('/src/portrait/regions.ts');
    const { ZERO_PORTRAIT_SETTINGS } = await import('/src/portrait/settings.ts');
    const template = (await detectPortraitFaces(fixture))[0], image = new Image(); image.src = fixture; await image.decode();
    const run = async (width, height, x, y) => {
      const c = document.createElement('canvas'); c.width = width; c.height = height;
      const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#263c30'; ctx.fillRect(0, 0, width, height); ctx.drawImage(image, x, y);
      const source = c.toDataURL(), face = { ...template, bounds: { x: (template.bounds.x * image.width + x) / width, y: (template.bounds.y * image.height + y) / height, width: template.bounds.width * image.width / width, height: template.bounds.height * image.height / height }, landmarks: template.landmarks.map(p => ({ x: (p.x * image.width + x) / width, y: (p.y * image.height + y) / height })) };
      const started = performance.now();
      const result = await renderNaturalRetouch(source, source, [{ face, settings: { ...ZERO_PORTRAIT_SETTINGS, warmth: 45, dodgeBurn: 35 } }]);
      const output = new Image(); output.src = result; await output.decode(); ctx.drawImage(output, 0, 0);
      const pixels = ctx.getImageData(x, y, image.width, image.height).data;
      const sentinels = [[0,0],[width-1,0],[0,height-1],[width-1,height-1],[width>>1,10]].map(([xx,yy]) => [...ctx.getImageData(xx,yy,1,1).data]);
      const evidence = { pixels, width: output.width, height: output.height, region: planFaceWorkRegion(face, width, height), elapsedMs: Math.round(performance.now() - started), sentinels };
      output.src = ''; c.width = c.height = 1; return evidence;
    };
    const small = await run(image.width + 400, image.height + 400, 200, 200), large = await run(6000, 4000, 3000, 1700);
    let faceDifference = 0; for (let i = 0; i < small.pixels.length; i++) if (small.pixels[i] !== large.pixels[i]) faceDifference++;
    return { faceDifference, dimensions: [large.width, large.height], region: large.region, smallRegion: small.region, elapsedMs: large.elapsedMs, sampledBackground: large.sentinels, scope: 'Desktop Chrome, public portrait on synthetic 24MP canvas; mobile memory not certified' };
  }, fixture);
  assert.deepEqual(report.dimensions, [6000,4000]); assert.equal(report.faceDifference, 0);
  assert.equal(report.region.workWidth, report.smallRegion.workWidth); assert.equal(report.region.workHeight, report.smallRegion.workHeight);
  for (const pixel of report.sampledBackground) assert.deepEqual(pixel, [38,60,48,255]);
  assert.equal(cloudCalls, 0); assert.deepEqual(external, []); assert.deepEqual(errors, []);
  await mkdir('artifacts/portrait-roi-large', { recursive: true });
  await writeFile('artifacts/portrait-roi-large/report.json', JSON.stringify({ passed: true, ...report, cloudCalls, external, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, ...report, cloudCalls, external, errors }, null, 2));
} finally { await browser.close(); }
