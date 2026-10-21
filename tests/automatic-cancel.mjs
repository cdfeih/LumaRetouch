/** Controlled local-model delays exercise cancellation and stale App results.
 * Uses a public portrait, an isolated context and an owned ephemeral port. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const output = 'artifacts/automatic-cancel';
await mkdir(output, { recursive: true });
let server, browser, page, failure, activeGate;
const report = { passed: false, checks: [] }, external = [], errors = [];
let cloudCalls = 0;
const controls = new Set();
function gate(asset) {
  let enter, release;
  const result = { asset, entered: new Promise(resolve => { enter = resolve; }), released: new Promise(resolve => { release = resolve; }), enter, release };
  result.enter = enter; result.release = release; controls.add(result); return result;
}
async function entered(control) {
  let timeout;
  try { await Promise.race([control.entered, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`No delayed model request for ${control.asset}`)), 45000); })]); }
  finally { clearTimeout(timeout); }
}
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, clearScreen: false });
  await server.listen();
  const address = server.httpServer.address(); assert.ok(address && typeof address === 'object' && address.port !== 5178);
  const base = `http://127.0.0.1:${address.port}`; report.port = address.port;
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('/__native/request')) { cloudCalls++; return route.abort(); }
    if (!url.startsWith(base) && !/^(data:|blob:)/.test(url)) { external.push(url); return route.abort(); }
    const control = activeGate;
    if (control && url.includes(`/models/${control.asset}`)) { activeGate = undefined; control.enter(); await control.released; }
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
  await page.goto(base); await page.locator('.project-loading-overlay').waitFor({ state: 'hidden' });
  await page.getByTestId('photo-input').setInputFiles({ name: 'automatic-cancel-public.jpg', mimeType: 'image/jpeg', buffer: await readFile('tests/fixtures/mediapipe-portrait.jpg') });
  const idle = async () => { await page.locator('.busy-overlay').waitFor({ state: 'hidden' }); await page.waitForFunction(() => { const im = document.querySelector('.working-image'); return im instanceof HTMLImageElement && im.complete && im.naturalWidth > 0; }); };
  const image = async () => { await idle(); return page.locator('.working-image').getAttribute('src'); };
  const parameters = () => page.locator('.portrait-settings input[type="range"]').evaluateAll(inputs => Object.fromEntries(inputs.map(input => [input.getAttribute('aria-label'), input.value])));
  const savedState = async () => {
    await page.waitForFunction(() => document.querySelector('.project-status')?.classList.contains('saved'));
    return page.evaluate(async () => {
      const saved = await (await import('/src/editor/project.ts')).loadProjectDraft();
      const doc = saved.documents.find(item => item.id === saved.activeId), session = saved.sessions[doc.id];
      return { current: doc.current, history: doc.history.map(item => item.image), future: doc.future.map(item => item.image), edits: doc.edits,
        automatic: doc.automatic ?? null, parameters: session?.parameters ?? {}, common: session?.common ?? null,
        baseline: session?.baseline, knownSources: session?.knownSources, scanned: session?.scanned, people: session?.people.map(person => person.id) ?? [] };
    });
  };
  await idle(); const original = await image(), beforeParameters = await parameters(), before = await savedState();
  const first = gate('face_landmarker.task'); activeGate = first;
  await page.getByTestId('automatic-run').click(); await entered(first);
  await page.getByRole('button', { name: '第一次使用？查看修图步骤与画笔说明', exact: true }).click();
  const guide = page.getByRole('dialog', { name: '4 步修出自然照片' }); await guide.waitFor();
  assert.equal(await guide.getByRole('button', { name: '去批量修图', exact: true }).isDisabled(), true);
  assert.equal(await guide.getByRole('button', { name: '先修一张', exact: true }).isDisabled(), true);
  assert.equal(await page.getByTestId('batch-studio').isVisible(), false);
  report.checks.push({ name: '智能任务忙碌期间指南两个操作入口禁用，不能开启批量绕过互斥', passed: true });
  await guide.getByRole('button', { name: '关闭新手指南', exact: true }).click();
  await page.getByRole('button', { name: '取消本次处理', exact: true }).click();
  first.release(); await idle();
  assert.equal(await image(), original); assert.deepEqual(await parameters(), beforeParameters);
  const cancelled = await savedState(); assert.deepEqual(cancelled, before);
  assert.match(await page.locator('.toast').innerText(), /已取消/);
  report.checks.push({ name: '延迟模型加载中取消，解除延迟后原图、历史、参数和基准全部保持', passed: true, history: cancelled.history.length, unchangedImage: true, unchangedSession: true });

  const second = gate('selfie_multiclass_256x256.tflite'); activeGate = second;
  await page.getByTestId('automatic-run').click(); await entered(second);
  // Simulate an external document revision while the old analysis is pending.
  // Ordinary UI actions are locked. Dispatch through the existing App useState
  // queue strictly in the test, without introducing a production mutation hook.
  const externalRevision = await page.evaluate(async () => {
    const root = document.querySelector('.app-shell'), key = Object.keys(root).find(name => name.startsWith('__reactFiber$'));
    let fiber = root[key];
    while (fiber && (typeof fiber.type !== 'function' || fiber.type.name !== 'App')) fiber = fiber.return;
    if (!fiber) throw new Error('Cannot locate App state for controlled stale-revision test');
    let state = fiber.memoizedState;
    while (state && (!Array.isArray(state.memoizedState) || !state.memoizedState.some(item => item && typeof item.current === 'string' && Array.isArray(item.history)))) state = state.next;
    if (!state?.queue?.dispatch) throw new Error('Cannot locate document state queue');
    const doc = state.memoizedState[0], im = new Image(); im.src = doc.current; await im.decode();
    const canvas = document.createElement('canvas'); canvas.width = im.naturalWidth; canvas.height = im.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(im, 0, 0); ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 2, 2);
    const changed = canvas.toDataURL('image/png'); canvas.width = canvas.height = 1;
    state.queue.dispatch(state.memoizedState.map(item => item.id === doc.id ? { ...item, current: changed, edits: item.edits + 1 } : item));
    return changed;
  });
  await page.waitForFunction(expected => document.querySelector('.working-image')?.getAttribute('src') === expected, externalRevision);
  second.release(); await idle(); assert.equal(await image(), externalRevision);
  assert.match(await page.locator('.toast').innerText(), /照片已切换或更新.*丢弃本次结果/);
  const afterStale = await savedState(); assert.equal(afterStale.current, externalRevision); assert.equal(afterStale.automatic, null);
  assert.deepEqual(afterStale.history, before.history); assert.deepEqual(afterStale.future, before.future); assert.equal(afterStale.edits, before.edits + 1);
  assert.deepEqual(await parameters(), beforeParameters);
  assert.deepEqual(afterStale.parameters, before.parameters);
  report.checks.push({ name: '分析期间外部修订当前图，迟到智能结果丢弃，不覆写新图或智能参数', passed: true, history: afterStale.history.length, externalEdits: afterStale.edits });
  assert.equal(cloudCalls, 0); assert.deepEqual(external, []); assert.deepEqual(errors, []); report.passed = true;
} catch (error) {
  failure = error; report.failure = { message: error.message, stack: error.stack };
  await page?.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
} finally {
  for (const control of controls) control.release(); await browser?.close(); await server?.close();
  Object.assign(report, { serverClosed: !server?.httpServer?.listening, cloudCalls, external, errors });
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
if (failure) throw failure;
