/** 批量本地精修验收：真实公开肖像、本地空白图与损坏fixture；不发送模型请求。 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const outputDir = path.resolve('artifacts/batch');
const executablePath = [process.env.LUMA_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage(); page.setDefaultTimeout(30000);
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
const dialog = page.getByTestId('batch-studio');
const rows = () => dialog.locator('.batch-row');
async function check(name, action) {
  const started = Date.now(); const evidence = await action();
  checks.push({ name, passed: true, elapsedMs: Date.now() - started, ...evidence });
  process.stdout.write(`PASS ${name}\n`);
}
async function idle() { await dialog.getByTestId('batch-cancel').waitFor({ state: 'hidden' }); }
async function records() {
  return page.evaluate(async () => Promise.all((await (await import('/src/batch/storage.ts')).listBatchResults()).map(async record => ({
    id: record.id, name: record.name, size: record.blob.size, width: record.width, height: record.height,
    sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer()))).map(byte => byte.toString(16).padStart(2, '0')).join(''),
  }))));
}
async function clearRows() {
  await dialog.getByRole('button', { name: '清空列表与本地结果', exact: true }).click(); await idle();
  await rows().waitFor({ state: 'hidden' });
}
async function savedDownload(button) {
  const pending = page.waitForEvent('download'); await button.click(); const download = await pending;
  const target = path.join(outputDir, download.suggestedFilename()); await download.saveAs(target); await idle();
  return { name: download.suggestedFilename(), bytes: await readFile(target) };
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByTestId('open-batch').click(); await dialog.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.batch-studio')?.textContent.includes('正在恢复本地结果记录'));
  const portrait = { name: 'public-portrait.jpg', mimeType: 'image/jpeg', buffer: await readFile('tests/fixtures/mediapipe-portrait.jpg') };
  const blank = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    const context = canvas.getContext('2d'); context.fillStyle = '#829573'; context.fillRect(0, 0, 640, 480);
    return canvas.toDataURL().split(',')[1];
  });
  const empty = { name: 'no-face.png', mimeType: 'image/png', buffer: Buffer.from(blank, 'base64') };
  let firstResult;

  await check('四步入口、三套默认零塑形推荐，先试1张仅生成一个本地结果', async () => {
    assert.equal(await dialog.locator('.batch-steps li').count(), 4);
    assert.equal(await dialog.getByTestId('batch-preset').locator('optgroup').first().locator('option').count(), 3);
    await dialog.getByTestId('batch-file-input').setInputFiles([portrait, { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('invalid-local-png') }, empty]);
    assert.equal(await rows().count(), 3);
    await dialog.getByTestId('batch-trial').click(); await idle();
    assert.equal(await rows().filter({ hasText: 'public-portrait.jpg' }).getAttribute('data-status'), 'succeeded');
    assert.equal(await rows().filter({ hasText: 'no-face.png' }).getAttribute('data-status'), 'pending');
    const stored = await records(); assert.equal(stored.length, 1); firstResult = stored[0];
    assert.ok(firstResult.size > 0);
    return { resultCount: stored.length, result: firstResult };
  });

  await check('顺序处理重复原图不叠加、无人脸跳过、损坏图失败后结束并显示原因', async () => {
    await dialog.getByTestId('batch-run').click(); await idle();
    assert.equal(await rows().filter({ hasText: 'public-portrait.jpg' }).getAttribute('data-status'), 'succeeded');
    assert.equal(await rows().filter({ hasText: 'no-face.png' }).getAttribute('data-status'), 'skipped');
    assert.equal(await rows().filter({ hasText: 'broken.png' }).getAttribute('data-status'), 'failed');
    assert.match(await rows().filter({ hasText: 'no-face.png' }).textContent(), /未处理|未识别/);
    assert.match(await rows().filter({ hasText: 'broken.png' }).textContent(), /读取|解码/);
    assert.match(await dialog.locator('.batch-progress').textContent(), /已处理 3 \/ 3 张/);
    const stored = await records(); assert.equal(stored.length, 1);
    assert.equal(stored[0].sha256, firstResult.sha256);
    return { repeatedFromOriginalHash: stored[0].sha256, resultCount: stored.length };
  });

  await check('单张PNG与批量JPEG ZIP真实下载，ZIP可识别且没有漏选项', async () => {
    assert.equal(await dialog.getByTestId('batch-download-zip').isDisabled(), true);
    await dialog.getByLabel('批量导出格式', { exact: true }).selectOption('png');
    const png = await savedDownload(dialog.getByTestId('batch-download-one'));
    assert.equal(png.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await dialog.getByRole('button', { name: '仅选已有结果', exact: true }).click();
    await dialog.getByLabel('批量导出格式', { exact: true }).selectOption('jpeg');
    const zip = await savedDownload(dialog.getByTestId('batch-download-zip'));
    assert.equal(zip.bytes.readUInt32LE(0), 0x04034b50);
    assert.equal(zip.bytes.readUInt32LE(zip.bytes.length - 22), 0x06054b50);
    assert.equal(zip.bytes.readUInt16LE(zip.bytes.length - 12), 1);
    const nameLength = zip.bytes.readUInt16LE(26), extraLength = zip.bytes.readUInt16LE(28);
    assert.match(zip.bytes.subarray(30, 30 + nameLength).toString('utf8'), /\.jpg$/);
    assert.equal(zip.bytes.subarray(30 + nameLength + extraLength, 33 + nameLength + extraLength).toString('hex'), 'ffd8ff');
    return { pngBytes: png.bytes.length, zipBytes: zip.bytes.length, entries: 1 };
  });

  await check('刷新恢复本地Blob结果但不能重新处理，清空会删除本地结果', async () => {
    await page.reload({ waitUntil: 'networkidle' }); await page.getByTestId('open-batch').click();
    await page.waitForFunction(() => document.querySelectorAll('.batch-row').length === 1);
    assert.match(await rows().first().textContent(), /无原图，不可重新处理/);
    assert.equal(await dialog.getByTestId('batch-run').isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: '原图', exact: true }).isDisabled(), true);
    await dialog.getByTestId('batch-preview-image').waitFor({ state: 'visible' });
    await clearRows(); assert.deepEqual(await records(), []);
  });

  await check('取消保留先前成功结果、关闭和输入被锁，重试从原图继续', async () => {
    await dialog.getByTestId('batch-file-input').setInputFiles([portrait, { ...portrait, name: 'second-portrait.jpg' }]);
    await dialog.getByTestId('batch-trial').click(); await idle();
    const accepted = await records(); assert.equal(accepted.length, 1);
    // Delay the write transaction's completion notification. Its Blob has been
    // committed, but the queue has not yet accepted it: cancelling here must
    // remove that new record while retaining the earlier successful result.
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
      window.__batchOriginalCompletion = descriptor;
      Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(handler) {
        descriptor.set.call(this, typeof handler === 'function' && this.mode === 'readwrite'
          ? function(event) { setTimeout(() => handler.call(this, event), 1200); } : handler);
      } });
    });
    await dialog.getByTestId('batch-run').click();
    await dialog.getByTestId('batch-cancel').waitFor({ state: 'visible' });
    assert.equal(await dialog.getByRole('button', { name: '关闭批量精修', exact: true }).isDisabled(), true);
    assert.equal(await dialog.getByTestId('batch-preset').isDisabled(), true);
    await page.waitForFunction(async () => (await (await import('/src/batch/storage.ts')).listBatchResults()).length === 2);
    await dialog.getByTestId('batch-cancel').click(); await idle();
    const cancelled = await rows().evaluateAll(nodes => nodes.map(node => node.dataset.status));
    assert.ok(cancelled.includes('cancelled'));
    await page.waitForTimeout(1600);
    const after = await records(); assert.deepEqual(after.map(record => record.id), [accepted[0].id]);
    await page.evaluate(() => Object.defineProperty(IDBTransaction.prototype, 'oncomplete', window.__batchOriginalCompletion));
    await dialog.getByTestId('batch-retry').click(); await idle();
    assert.deepEqual(await rows().evaluateAll(nodes => nodes.map(node => node.dataset.status)), ['succeeded', 'succeeded']);
    const finished = await records(); assert.equal(finished.length, 2);
    assert.ok(finished.every(record => record.sha256 === accepted[0].sha256));
    return { cancelled, preservedResultId: accepted[0].id, finalResults: finished.length };
  });

  await check('个人全零预设不会伪称修图成功，超过100张明确拒绝整次导入', async () => {
    const id = await page.evaluate(async () => {
      const { savePortraitPreset, PRESET_STORAGE_KEY } = await import('/src/portrait/presets.ts');
      const { ZERO_PORTRAIT_SETTINGS } = await import('/src/portrait/settings.ts');
      const saved = savePortraitPreset('批量全零验收', ZERO_PORTRAIT_SETTINGS);
      dispatchEvent(new StorageEvent('storage', { key: PRESET_STORAGE_KEY }));
      return saved.find(value => value.name === '批量全零验收').id;
    });
    await dialog.getByTestId('batch-preset').selectOption(`personal:${id}`);
    await dialog.getByTestId('batch-trial').click(); await idle();
    assert.equal(await rows().first().getAttribute('data-status'), 'skipped');
    assert.match(await rows().first().textContent(), /未产生像素变化/);
    assert.equal((await records()).length, 1);
    await dialog.getByTestId('batch-file-input').setInputFiles(Array.from({ length: 101 }, (_, index) => ({ ...empty, name: `over-limit-${index}.png` })));
    assert.equal(await rows().count(), 2);
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('最多 100 张'));
  });

  await check('390px手机无横向溢出，预设、处理和导出都能滚动访问', async () => {
    if (await page.locator('.toast button').count()) await page.locator('.toast button').click();
    await dialog.locator('.batch-content').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: path.join(outputDir, 'batch-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByTestId('batch-preset').scrollIntoViewIfNeeded(); assert.equal(await dialog.getByTestId('batch-preset').isVisible(), true);
    await dialog.getByTestId('batch-run').scrollIntoViewIfNeeded(); assert.equal(await dialog.getByTestId('batch-run').isVisible(), true);
    await dialog.getByTestId('batch-download-zip').scrollIntoViewIfNeeded(); assert.equal(await dialog.getByTestId('batch-download-zip').isVisible(), true);
    await dialog.locator('.batch-content').evaluate(node => { node.scrollTop = 0; });
    const size = await dialog.evaluate(node => ({ width: node.clientWidth, page: node.scrollWidth, inner: node.querySelector('.batch-content').clientWidth, scroll: node.querySelector('.batch-content').scrollWidth }));
    assert.ok(size.page <= size.width && size.scroll <= size.inner, JSON.stringify(size));
    await page.screenshot({ path: path.join(outputDir, 'batch-mobile-390.png') });
    return size;
  });

  assert.equal(modelCalls, 0); assert.deepEqual(externalRequests, []); assert.deepEqual(rendererErrors, []);
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: true, modelCalls, externalRequests, rendererErrors, checks }, null, 2));
  process.stdout.write(`批量本地人像验收通过；报告：${outputDir}\n`);
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: false, modelCalls, externalRequests, rendererErrors, checks, failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
