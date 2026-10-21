/** Standalone real-browser task-directory UI; no photos, credentials or paid requests. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('artifacts/specialty-tasks'); await mkdir(output, { recursive: true });
const moduleId = '\0specialty-task-harness.mjs';
const harness = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SpecialtyTasks} from '/src/components/SpecialtyTasks.tsx';
window.__taskCalls=[];
function Harness(){const [selected,setSelected]=useState(),[disabled,setDisabled]=useState(false);
window.__setTaskSelection=setSelected;window.__setTasksDisabled=setDisabled;
return React.createElement(SpecialtyTasks,{selectedTaskId:selected,disabled,onSelect(task){window.__taskCalls.push(task);setSelected(task.id);}});}
createRoot(document.getElementById('harness')).render(React.createElement(Harness));`;
const server = await createServer({
  logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{ name: 'specialty-task-browser-harness', resolveId(id) { if (id === '/__specialty-task-harness.mjs') return moduleId; }, load(id) { if (id === moduleId) return harness; },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url !== '/__specialty-tasks') return next();
      try {
        const html = await vite.transformIndexHtml(req.url, '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#172012;color:#d4e4c5;font-family:Arial,sans-serif}#harness{box-sizing:border-box;width:360px;max-width:100%;padding:18px}</style></head><body><main id="harness"></main><script type="module" src="/__specialty-task-harness.mjs"></script></body></html>');
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
      } catch (error) { next(error); }
    }); },
  }],
});
let browser;
const checks = [], errors = [], external = []; let cloudCalls = 0;
async function check(name, run) { const started = Date.now(); await run(); checks.push({ name, passed: true, elapsedMs: Date.now() - started }); console.log(`PASS ${name}`); }
try {
  await server.listen(); const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const executablePath = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', route => { const url = route.request().url(); if (url.includes('/__native/request')) { cloudCalls++; return route.abort(); } if (url.startsWith(base) || /^(data:|blob:)/.test(url)) return route.continue(); external.push(url); return route.abort(); });
  const page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/__specialty-tasks`); const tasks = page.getByTestId('specialty-tasks'); await tasks.waitFor();
  await check('目录说明云端模板边界，三类八项任务可选，初始不运行', async () => {
    assert.equal(await tasks.getByRole('button').count(), 8);
    assert.match(await tasks.innerText(), /云端局部图像编辑模板，并非专用模型/);
    assert.match(await tasks.innerText(), /选择模板不会上传照片或开始计费/);
    assert.equal(await page.getByTestId('specialty-task-guide').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__taskCalls), []);
  });
  await check('点击只派发选中任务，更新范围和复核提示，不执行网络请求', async () => {
    await page.getByTestId('specialty-task-hand-skin').click();
    const guide = page.getByTestId('specialty-task-guide'); await guide.waitFor();
    assert.match(await guide.innerText(), /指缝、指甲和手指边缘/);
    assert.match(await guide.innerText(), /效果边界/);
    const calls = await page.evaluate(() => window.__taskCalls); assert.equal(calls.length, 1); assert.equal(calls[0].id, 'hand-skin'); assert.equal(calls[0].defaultMode, 'instruction');
    assert.match(calls[0].prompt, /只修改本次局部选区/);
    assert.equal(await page.getByTestId('specialty-task-hand-skin').getAttribute('aria-pressed'), 'true');
    assert.equal(cloudCalls, 0);
  });
  await check('键盘选择另一任务替换提示，显示默认要求且不累积旧任务', async () => {
    const button = page.getByTestId('specialty-task-flyaway-hair'); await button.focus(); await page.keyboard.press('Enter');
    assert.equal(await button.getAttribute('aria-pressed'), 'true'); assert.equal(await page.getByTestId('specialty-task-hand-skin').getAttribute('aria-pressed'), 'false');
    const guide = page.getByTestId('specialty-task-guide'); assert.match(await guide.innerText(), /不要把整片头发/);
    await guide.getByText('查看此模板的默认要求', { exact: true }).click(); assert.match(await guide.innerText(), /保留原发型、发量、发际线/);
    assert.equal(await page.evaluate(() => window.__taskCalls.length), 2);
  });
  await check('处理忙碌时禁止再次选择，外部清空选中不会保留陈旧说明', async () => {
    await page.evaluate(() => window.__setTasksDisabled(true)); await page.waitForFunction(() => [...document.querySelectorAll('.specialty-options button')].every(button => button.disabled));
    await page.getByTestId('specialty-task-neck-lines').evaluate(button => button.click()); assert.equal(await page.evaluate(() => window.__taskCalls.length), 2);
    await page.evaluate(() => { window.__setTasksDisabled(false); window.__setTaskSelection('unknown-task'); });
    await page.waitForFunction(() => !document.querySelector('[data-testid="specialty-task-guide"]'));
    assert.equal(await tasks.locator('button[aria-pressed="true"]').count(), 0);
  });
  await check('手机窄屏支持任务选择和新手分流，说明不横向溢出', async () => {
    await page.setViewportSize({ width: 360, height: 860 }); await page.getByTestId('specialty-task-neck-lines').click();
    await tasks.getByText('不知道该选哪个功能？', { exact: true }).click();
    assert.match(await tasks.innerText(), /默认不改变脸型或身材/); assert.match(await tasks.innerText(), /都无需 API Key/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  });
  assert.equal(cloudCalls, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks, cloudCalls, errors, external }, null, 2));
} catch (error) {
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ passed: false, error: String(error), checks, cloudCalls, errors, external }, null, 2)); throw error;
} finally { if (browser) await browser.close(); await server.close(); }
