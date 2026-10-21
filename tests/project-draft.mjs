/** Reload recovery with real local portrait processing; all external requests are blocked. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.route('**/*', route => route.request().url().startsWith(base) || /^(blob:|data:)/.test(route.request().url()) ? route.continue() : route.abort());
await context.routeWebSocket('**/*', socket => socket.close());
const page = await context.newPage(); page.setDefaultTimeout(90000);
const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
const settled = async () => { await page.locator('.busy-overlay').waitFor({ state: 'hidden' }); await page.waitForFunction(() => document.querySelector('.working-image')?.complete); };
try {
  await page.goto(base);
  await page.getByTestId('photo-input').setInputFiles({ name: 'draft-public.jpg', mimeType: 'image/jpeg', buffer: await readFile('tests/fixtures/mediapipe-portrait.jpg') });
  await settled();
  await page.getByRole('button', { name: '全部归零', exact: true }).click();
  await page.getByRole('slider', { name: '肤色提亮', exact: true }).fill('60');
  await page.getByRole('button', { name: '应用当前人像参数', exact: true }).click(); await settled();
  const retouched = await page.locator('.working-image').getAttribute('src');
  await page.getByRole('button', { name: '保护画笔', exact: true }).click();
  const box = await page.getByTestId('mask-canvas').boundingBox();
  await page.mouse.click(box.x + box.width * .1, box.y + box.height * .1);
  const protection = await page.getByTestId('protection-canvas').evaluate(canvas => canvas.toDataURL());
  await page.getByRole('button', { name: '立即保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.project-status')?.classList.contains('saved'));
  // A pending debounce from before manual save must not leave the status stuck at "saving".
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('.project-status').getAttribute('class'), 'project-status saved');
  await page.reload(); await settled();
  assert.equal(await page.locator('.working-image').getAttribute('src'), retouched);
  assert.equal(await page.getByRole('slider', { name: '肤色提亮', exact: true }).inputValue(), '60');
  await page.waitForFunction(expected => document.querySelector('[data-testid="protection-canvas"]').toDataURL() === expected, protection);
  assert.equal(await page.getByRole('button', { name: '撤销编辑', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: '基础调色', exact: false }).click();
  await page.getByRole('slider', { name: '曝光', exact: true }).fill('0.5');
  await page.getByRole('button', { name: '应用调色', exact: true }).click(); await settled();
  await page.getByRole('button', { name: '撤销编辑', exact: true }).click();
  await page.getByRole('button', { name: '应用当前人像参数', exact: true }).click(); await settled();
  // The red patch is outside the face; restoring the baseline must avoid adding another retouch pass.
  assert.equal(await page.locator('.working-image').getAttribute('src'), retouched);
  assert.deepEqual(errors, []);
  console.log('PASS draft pixels, portrait session, history, protection and repeated retouch after reload');
} finally { await browser.close(); }
