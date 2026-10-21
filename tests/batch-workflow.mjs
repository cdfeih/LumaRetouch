/** Local-only batch review, preset sharing and bounded multi-ZIP workflow acceptance. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const output = path.resolve('artifacts/batch-workflow'); await mkdir(output, { recursive: true });
const executablePath = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage(); page.setDefaultTimeout(45000);
const checks = [], errors = [], external = [], downloads = [];
let modelCalls = 0;
page.on('pageerror', error => errors.push(error.message));
page.on('download', download => downloads.push(download));
await context.routeWebSocket('**/*', socket => socket.close());
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.includes('/__native/request')) { modelCalls++; return route.abort(); }
  // A small controlled cap exercises exactly the production splitting path with tiny valid images.
  // Real exportArchive still validates and downloads each ZIP. The platform's real 64 MiB guard is unchanged.
  if (url.startsWith(`${baseUrl}/src/platform.ts`) && !url.includes('batch-qa-real')) return route.fulfill({ contentType: 'application/javascript', body: `
    export * from '/src/platform.ts?batch-qa-real=1';
    import {exportArchive as save} from '/src/platform.ts?batch-qa-real=1';
    export const MAX_ARCHIVE_BYTES=2500;
    export async function exportArchive(bytes,name){
      const calls=window.__archiveCalls ||= [];calls.push({name,size:bytes.length});
      if(window.__cancelPart===calls.length)return {saved:false,message:'QA:已取消保存'};
      return save(bytes,name);
    }` });
  if (url.startsWith(baseUrl) || /^(data:|blob:)/.test(url)) return route.continue();
  external.push(url); return route.abort();
});
const batch = page.getByTestId('batch-studio'), rows = () => batch.locator('.batch-row');
const idle = () => batch.getByTestId('batch-cancel').waitFor({ state: 'hidden' });
const records = () => page.evaluate(async () => (await (await import('/src/batch/storage.ts')).listBatchResults()).map(record => ({ id: record.id, name: record.name, review: record.review, starred: record.starred })));
async function check(name, action) { const start = Date.now(); const evidence = await action(); checks.push({ name, elapsedMs: Date.now() - start, ...evidence }); console.log(`PASS ${name}`); }
async function clearRows() { await batch.getByRole('button', { name: '清空列表与本地结果', exact: true }).click(); await idle(); await rows().waitFor({ state: 'hidden' }); }
async function open() { await page.getByTestId('open-batch').click(); await page.waitForFunction(() => !document.querySelector('.batch-studio')?.textContent.includes('正在恢复本地结果记录')); }
function entries(bytes) {
  const found = []; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let p = 0; view.getUint32(p, true) === 0x04034b50;) {
    const length = view.getUint16(p + 26, true); found.push(bytes.subarray(p + 30, p + 30 + length).toString('utf8'));
    p += 30 + length + view.getUint16(p + 28, true) + view.getUint32(p + 18, true);
  }
  return found;
}
try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' }); await open();
  const portrait = { name: 'review-portrait.jpg', mimeType: 'image/jpeg', buffer: await readFile('tests/fixtures/mediapipe-portrait.jpg') };
  let firstRecord;
  await check('批量100%原像素、并排对照与同步滚动，星标和复核可保存', async () => {
    await batch.getByTestId('batch-file-input').setInputFiles(portrait);
    await batch.getByTestId('batch-trial').click(); await idle();
    await batch.getByTestId('batch-preview-image').waitFor();
    await batch.getByTestId('batch-compare').click();
    await batch.getByTestId('batch-actual-size').click();
    const sizes = await batch.locator('.batch-preview-image img').evaluateAll(images => images.map(image => ({ rendered: image.getBoundingClientRect().width, natural: image.naturalWidth })));
    assert.equal(sizes.length, 2); assert.ok(sizes.every(size => size.rendered === size.natural));
    await batch.getByTestId('batch-preview-pane').first().evaluate(pane => { pane.scrollLeft = 80; pane.scrollTop = 120; });
    await page.waitForFunction(() => { const p = document.querySelectorAll('[data-testid="batch-preview-pane"]'); return p.length === 2 && Math.abs(p[0].scrollTop - p[1].scrollTop) <= 1 && p[0].scrollTop > 100; });
    await batch.getByRole('button', { name: '添加星标 review-portrait.jpg', exact: true }).click(); await idle();
    await batch.getByLabel('当前成片复核状态', { exact: true }).selectOption('approved'); await idle();
    firstRecord = (await records())[0]; assert.equal(firstRecord.review, 'approved'); assert.equal(firstRecord.starred, true);
    await page.screenshot({ path: path.join(output, 'desktop-compare.png'), fullPage: true });
    return { renderedSizes: sizes, metadata: firstRecord };
  });
  await check('预设JSON导入、同名不覆盖、导出无照片密钥，跳过保留已复核成片', async () => {
    const text = await page.evaluate(async () => { const { ZERO_PORTRAIT_SETTINGS } = await import('/src/portrait/settings.ts'); return JSON.stringify({ format: 'luma-portrait-presets', version: 1, presets: [{ name: '零参数分享', settings: ZERO_PORTRAIT_SETTINGS }] }); });
    await batch.locator('.batch-preset-transfer summary').click();
    await batch.getByTestId('batch-preset-file').setInputFiles({ name: 'presets.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await page.waitForFunction(() => document.querySelector('[data-testid="batch-preset"]').selectedOptions[0]?.textContent === '零参数分享');
    await batch.getByTestId('batch-run').click(); await idle();
    assert.equal(await rows().first().getAttribute('data-status'), 'skipped');
    assert.deepEqual(await records(), [firstRecord]); assert.equal(await batch.getByTestId('batch-download-one').isDisabled(), false);
    const downloadEvent = page.waitForEvent('download'); await batch.getByRole('button', { name: '导出当前参数', exact: true }).click();
    const download = await downloadEvent, target = path.join(output, 'exported-presets.json'); await download.saveAs(target);
    const exported = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual(Object.keys(exported).sort(), ['format','presets','version']);
    assert.deepEqual(Object.keys(exported.presets[0]).sort(), ['name','settings']);
    assert.equal(exported.presets[0].name, '零参数分享');
    await batch.getByTestId('batch-preset-file').setInputFiles({ name: 'presets-again.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await page.waitForFunction(() => document.querySelector('[data-testid="batch-preset"]').selectedOptions[0]?.textContent === '零参数分享 (2)');
    return { savedResultRetained: firstRecord.id, importedDuplicateName: '零参数分享 (2)' };
  });
  await check('刷新恢复星标与复核，筛选不隐含选中，缺原图不伪装可对照', async () => {
    await page.reload({ waitUntil: 'networkidle' }); await open();
    await batch.getByTestId('batch-preview-image').waitFor();
    assert.deepEqual(await records(), [firstRecord]);
    assert.equal(await batch.getByTestId('batch-compare').isDisabled(), true);
    await batch.getByLabel('筛选批量照片', { exact: true }).selectOption('approved');
    assert.equal(await rows().count(), 1); assert.equal(await rows().locator('input[type="checkbox"]').isChecked(), false);
    await batch.getByLabel('筛选批量照片', { exact: true }).selectOption('redo'); assert.equal(await rows().count(), 0);
    await batch.getByLabel('筛选批量照片', { exact: true }).selectOption('starred'); assert.equal(await rows().count(), 1);
    await batch.getByLabel('筛选批量照片', { exact: true }).selectOption('all'); await clearRows();
  });
  const tinyPng = await page.evaluate(() => { const c = document.createElement('canvas'); c.width=80;c.height=60;const ctx=c.getContext('2d');ctx.fillStyle='#829573';ctx.fillRect(0,0,80,60);return c.toDataURL().split(',')[1]; });
  await check('30张原图按25张分页、星标筛选可访问，手机无页面横向溢出', async () => {
    const file = { mimeType: 'image/png', buffer: Buffer.from(tinyPng, 'base64') };
    await batch.getByTestId('batch-file-input').setInputFiles(Array.from({ length: 30 }, (_, index) => ({ ...file, name: `group-${index+1}.png` })));
    assert.equal(await rows().count(), 25);
    await batch.getByRole('button', { name: '下一页', exact: true }).click(); assert.equal(await rows().count(), 5);
    await rows().last().getByRole('button', { name: /添加星标/ }).click(); await idle();
    await batch.getByLabel('筛选批量照片', { exact: true }).selectOption('starred'); assert.equal(await rows().count(), 1);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(output, 'mobile-workflow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await batch.getByLabel('筛选批量照片', { exact: true }).selectOption('all'); await clearRows();
  });
  await page.evaluate(async data => {
    const { saveBatchResult } = await import('/src/batch/storage.ts'); const { ZERO_PORTRAIT_SETTINGS } = await import('/src/portrait/settings.ts');
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    for (let i=0;i<6;i++) await saveBatchResult({ id:`zip-${i}`,name:'同名照片.png',blob,width:80,height:60,createdAt:i,settings:ZERO_PORTRAIT_SETTINGS,faceCount:0,bodyCount:0,warnings:[] });
  }, tinyPng);
  await page.reload({ waitUntil: 'networkidle' }); await open();
  await check('多ZIP逐包真实下载，所有选中照片均出现且全局序号不重名', async () => {
    const before = downloads.length;
    await batch.getByTestId('batch-download-zip').click(); await idle();
    const calls = await page.evaluate(() => window.__archiveCalls);
    assert.ok(calls.length >= 2); assert.ok(calls.every(call => call.size <= 2500));
    const actual = downloads.slice(before); assert.equal(actual.length, calls.length);
    const files = [];
    for (const [index, download] of actual.entries()) { const target = path.join(output, `part${index+1}.zip`); await download.saveAs(target); files.push(...entries(await readFile(target))); }
    assert.equal(files.length, 6); assert.equal(new Set(files).size, 6);
    assert.ok(files.every((name,index) => name.startsWith(String(index+1).padStart(4,'0'))));
    return { controlledPartCap: 2500, parts: calls, entries: files };
  });
  await check('第二包取消停止后续交付，已完成包数量准确，六条本地成片仍保留', async () => {
    await page.evaluate(() => { window.__archiveCalls=[];window.__cancelPart=2; });
    const before = downloads.length;
    await batch.getByTestId('batch-download-zip').click(); await idle();
    assert.equal((await page.evaluate(() => window.__archiveCalls)).length, 2);
    assert.equal(downloads.length - before, 1); assert.equal((await records()).length, 6);
    assert.match(await page.locator('.toast').innerText(), /此前 1 包/);
    return { localResults: 6, deliveredParts: 1 };
  });
  assert.equal(modelCalls,0); assert.deepEqual(external,[]); assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'report.json'), JSON.stringify({ passed:true,checks,modelCalls,external,errors },null,2));
  console.log(`Batch review workflow passed: ${output}`);
} catch(error) {
  await page.screenshot({ path:path.join(output,'failure.png'),fullPage:true }).catch(()=>{});
  await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors,external},null,2));
  throw error;
} finally {await browser.close();}
