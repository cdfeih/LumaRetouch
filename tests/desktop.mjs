/**
 * 真实 Windows Electron 集成验收：pnpm build && node tests/desktop.mjs
 * 独立临时配置、隐藏窗口、本机 HTTP 测试服务，不调用任何付费模型。
 */
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve('.');
const executablePath = process.env.LUMA_DESKTOP_EXECUTABLE;
if (executablePath) await access(executablePath);
const outputDir = path.join(root, executablePath ? 'artifacts/packaged-desktop-integration' : 'artifacts/desktop-integration');
const mainSource = await readFile(path.join(root, 'electron/main.cjs'), 'utf8');
assert.ok(mainSource.includes("show: process.env.LUMA_TEST_HEADLESS !== '1'"), '运行前必须启用隐藏测试窗口，避免打扰用户。');
await mkdir(outputDir, { recursive: true });
const fakeKey = 'qa-desktop-local-only-key';
const checks = [];
const requests = [];
const requestBodies = [];
let fixture;
let delayResponse = false;
let onRequest;
let onCanceled;
let canceledRequests = 0;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  requestBodies.push(body);
  requests.push({ method: req.method, url: req.url, bytes: body.length, contentType: req.headers['content-type'], authorized: req.headers.authorization === `Bearer ${fakeKey}`, multipartImage: body.includes('name="image"'), model: body.includes('qa-image-editor') });
  onRequest?.(); onRequest = undefined;
  if (delayResponse) {
    res.on('close', () => {
      if (!res.writableEnded) { canceledRequests++; onCanceled?.(); onCanceled = undefined; }
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [{ b64_json: fixture }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const env = { ...process.env, LUMA_TEST_HEADLESS: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.LUMA_DEV_URL;
let app;
let page;
let originalStorage;
const rendererErrors = [];
const blockedRequests = [];

async function check(name, action) {
  const started = Date.now();
  await action();
  checks.push({ name, passed: true, elapsedMs: Date.now() - started });
  process.stdout.write(`PASS ${name}\n`);
}

async function waitForPhoto() {
  await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => {
    const img = document.querySelector('.working-image');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  });
}

async function currentImage() {
  await waitForPhoto();
  return page.locator('.working-image').getAttribute('src');
}

async function readPixel(src) {
  return page.evaluate(async source => {
    const img = new Image(); img.src = source; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
    return { width: img.width, height: img.height, rgba: [...context.getImageData(0, 0, 1, 1).data] };
  }, src);
}

const withTimeout = (promise, message) => Promise.race([
  promise,
  new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(message)), 8000); timer.unref(); }),
]);

try {
  app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.', `--user-data-dir=${path.join(outputDir, 'profile')}`] }),
    cwd: root, env, timeout: 20000,
  });
  page = await app.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  // Electron 自身的 renderer 网络同样限制于本机。native HTTP 目标由下方 UI 配置。
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (/^(file:|data:|blob:)/.test(url) || url.startsWith(`http://127.0.0.1:${port}`)) return route.continue();
    blockedRequests.push(url);
    return route.abort('blockedbyclient');
  });
  await page.waitForLoadState('domcontentloaded');
  originalStorage = await page.evaluate(() => ({ ...localStorage }));
  await check('隐藏的真实 Electron 启动、sandbox preload IPC 桥可用', async () => {
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(win => win.isVisible())), false);
    assert.equal(await page.evaluate(() => typeof window.lumaNative?.request), 'function');
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
    assert.match(await page.locator('.topbar-center').innerText(), /Windows/);
  });

  const fixtures = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 480;
    const context = canvas.getContext('2d');
    context.fillStyle = '#476a9a'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#efc8a0'; context.fillRect(240, 80, 240, 340);
    const original = canvas.toDataURL('image/png').split(',')[1];
    context.fillStyle = '#4ea57a'; context.fillRect(0, 0, canvas.width, canvas.height);
    return { original, edited: canvas.toDataURL('image/png').split(',')[1] };
  });
  fixture = fixtures.edited;
  await page.getByTestId('photo-input').setInputFiles({ name: 'desktop-qa.png', mimeType: 'image/png', buffer: Buffer.from(fixtures.original, 'base64') });
  const original = await currentImage();
  let edited;

  await check('UI → preload IPC → Node multipart HTTP → 本机模型 → Canvas 全链路', async () => {
    await page.getByRole('button', { name: '模型设置', exact: true }).first().click();
    await page.getByRole('button', { name: '兼容图像编辑接口', exact: true }).click();
    await page.getByLabel('API 地址', { exact: true }).fill(`http://127.0.0.1:${port}/v1`);
    await page.getByLabel('模型名称／接入点 ID', { exact: true }).fill('qa-image-editor');
    await page.locator('.secret-input input').fill(fakeKey);
    await page.getByRole('button', { name: '完成设置', exact: true }).click();
    await page.getByRole('button', { name: '开始质感磨皮', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'AI 处理完成，可开启前后对比检查细节' }).waitFor();
    edited = await currentImage();
    assert.equal(requests.length, 1);
    assert.deepEqual({ ...requests[0], bytes: undefined, contentType: undefined }, { method: 'POST', url: '/v1/images/edits', bytes: undefined, contentType: undefined, authorized: true, multipartImage: true, model: true });
    assert.match(requests[0].contentType, /^multipart\/form-data; boundary=/);
    assert.ok(requests[0].bytes > 1000);
    assert.notEqual(edited, original);
    assert.deepEqual(await readPixel(edited), { width: 720, height: 480, rgba: [78, 165, 122, 255] });
    await page.screenshot({ path: path.join(outputDir, 'windows-edited.png'), fullPage: true });
  });

  await check('取消经 IPC 传到底层 HTTP，结果及历史不被覆盖', async () => {
    delayResponse = true;
    const requestArrived = new Promise(resolve => { onRequest = resolve; });
    const socketCanceled = new Promise(resolve => { onCanceled = resolve; });
    await page.getByRole('button', { name: '开始质感磨皮', exact: true }).click();
    await withTimeout(requestArrived, '本机 HTTP 未收到第二次请求');
    await page.getByRole('button', { name: '取消本次处理', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已取消本次处理' }).waitFor();
    await withTimeout(socketCanceled, 'IPC 取消后，本机 HTTP 连接没有终止');
    assert.equal(canceledRequests, 1);
    assert.equal(await currentImage(), edited);
    assert.equal(await page.locator('.document-tag').innerText(), '1 次编辑');
  });

  await check('Windows 原生导出 IPC 可取消，可保存并生成正确 PNG 文件', async () => {
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }); });
    await page.getByRole('button', { name: '导出照片', exact: true }).click();
    await page.locator('.format-options button').filter({ hasText: 'PNG' }).click();
    await page.getByRole('button', { name: '保存照片', exact: true }).click();
    await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('dialog', { name: '导出你的照片' }).count(), 1);
    const savedPath = path.join(outputDir, 'native-export.png');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, savedPath);
    await page.getByRole('button', { name: '保存照片', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '照片已保存' }).waitFor();
    const saved = await readFile(savedPath);
    assert.equal(saved.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true);
    assert.deepEqual(await readPixel(`data:image/png;base64,${saved.toString('base64')}`), { width: 720, height: 480, rgba: [78, 165, 122, 255] });
    assert.equal(await page.getByRole('dialog', { name: '导出你的照片' }).count(), 0);
  });

  await check('参考图追色经原生 IPC 上传两个独立 image[] 图片分段', async () => {
    delayResponse = false;
    await page.getByTestId('tool-match').click();
    const before = requests.length;
    await page.getByTestId('reference-input').setInputFiles({ name: 'native-reference.png', mimeType: 'image/png', buffer: Buffer.from(fixtures.original, 'base64') });
    await page.locator('.busy-overlay').waitFor({ state: 'hidden' });
    assert.equal(requests.length, before, '导入参考图不能触发模型请求');
    await page.getByRole('button', { name: '开始参考图追色', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'AI 处理完成，可开启前后对比检查细节' }).waitFor();
    await waitForPhoto();
    assert.equal(requests.length, before + 1);
    const raw = requestBodies.at(-1).toString('latin1');
    assert.equal((raw.match(/name="image\[\]"/g) || []).length, 2);
    assert.ok(raw.includes('filename="photo.jpg"'));
    assert.ok(raw.includes('filename="reference.jpg"'));
    assert.ok(!raw.includes('name="mask"'), '未涂选的追色不应上传选区');
    assert.equal(requests.at(-1).authorized, true);
    assert.deepEqual(await readPixel(await currentImage()), { width: 720, height: 480, rgba: [78, 165, 122, 255] });
  });

  await check('Electron storage 不保存 Key，重载会话后 Key 清空', async () => {
    assert.equal(await page.evaluate(key => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(key), fakeKey), false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '模型设置', exact: true }).first().click();
    await page.getByRole('button', { name: '兼容图像编辑接口', exact: true }).click();
    assert.equal(await page.locator('.secret-input input').inputValue(), '');
    assert.equal(await page.evaluate(key => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(key), fakeKey), false);
  });

  assert.deepEqual(rendererErrors, []);
  assert.deepEqual(blockedRequests, []);
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: true, packaged: Boolean(executablePath), executablePath, externalModelCalls: 0, requests, canceledRequests, rendererErrors, blockedRequests, checks }, null, 2));
  process.stdout.write(`真实 Electron 验收通过；报告：${outputDir}\n`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: false, packaged: Boolean(executablePath), executablePath, requests, canceledRequests, rendererErrors, blockedRequests, checks, failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2));
  throw error;
} finally {
  if (page && originalStorage) await page.evaluate(storage => {
    localStorage.clear();
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  }, originalStorage).catch(() => {});
  if (app) await app.close().catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
