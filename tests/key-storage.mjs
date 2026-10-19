/** API Key 本机保存验收：node tests/key-storage.mjs。独立浏览器上下文、仅假 Key、外网全部拒绝。 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const outputDir = path.resolve('artifacts/key-storage');
const executablePath = [process.env.LUMA_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const checks = [], externalRequests = [], rendererErrors = [];
let modelCalls = 0;
const keys = { openai: 'qa-remember-openai-fake-key', gemini: 'qa-remember-gemini-fake-key', ark: 'qa-remember-ark-fake-key' };
await mkdir(outputDir, { recursive: true });
page.on('pageerror', error => rendererErrors.push(error.message));
await context.route('**/*', async route => {
  const url = route.request().url();
  if (new URL(url).origin === new URL(baseUrl).origin || /^(data:|blob:)/.test(url)) return route.continue();
  externalRequests.push(url); return route.abort('blockedbyclient');
});
await page.route('**/__native/request', async route => {
  modelCalls++;
  await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '密钥保存验收禁止调用模型' }) });
});

const keyInput = () => page.locator('.secret-input input');
const remember = () => page.getByRole('checkbox', { name: /记住 API Key/ });
const providerButton = kind => page.getByRole('button', { name: ({ openai: 'OpenAI', gemini: 'Google Gemini', ark: '火山方舟 · 豆包', compatible: '兼容图像编辑接口' })[kind], exact: true });
async function openSettings() { await page.locator('.settings-top').click(); await page.getByRole('dialog', { name: '连接你的 AI 模型' }).waitFor(); }
async function reloadSettings() { await page.reload({ waitUntil: 'networkidle' }); await openSettings(); }
async function settings() { return page.evaluate(() => JSON.parse(localStorage.getItem('luma-provider-settings') || '{}')); }
async function waitSaved(kind, apiKey) {
  await page.waitForFunction(({ kind, apiKey }) => {
    const config = JSON.parse(localStorage.getItem('luma-provider-settings') || '{}')[kind];
    return config && (apiKey === null ? !Object.hasOwn(config, 'apiKey') : config.apiKey === apiKey);
  }, { kind, apiKey: apiKey ?? null });
}
async function check(name, action) {
  const started = Date.now(); await action();
  checks.push({ name, passed: true, elapsedMs: Date.now() - started });
  process.stdout.write(`PASS ${name}\n`);
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await openSettings();
  await check('默认勾选记住 API Key，填写后保存到当前服务配置', async () => {
    assert.equal(await remember().isChecked(), true);
    await keyInput().fill(keys.openai); await waitSaved('openai', keys.openai);
    const saved = await settings(); assert.equal(saved.openai.rememberApiKey, true);
    assert.equal(saved.openai.apiKey, keys.openai);
    assert.equal(await keyInput().getAttribute('type'), 'password');
  });

  await check('刷新恢复已保存 Key 与记住状态', async () => {
    await reloadSettings();
    assert.equal(await keyInput().inputValue(), keys.openai);
    assert.equal(await remember().isChecked(), true);
  });

  await check('每家服务独立保存，刷新恢复上次选择的服务', async () => {
    await providerButton('gemini').click(); assert.equal(await keyInput().inputValue(), '');
    assert.equal(await remember().isChecked(), true);
    await keyInput().fill(keys.gemini); await waitSaved('gemini', keys.gemini);
    await providerButton('ark').click(); assert.equal(await keyInput().inputValue(), '');
    await keyInput().fill(keys.ark); await waitSaved('ark', keys.ark);
    assert.equal(await page.evaluate(() => localStorage.getItem('luma-provider-kind')), 'ark');
    await reloadSettings();
    assert.equal(await page.locator('.provider-grid button.selected').innerText(), '火山方舟 · 豆包');
    assert.equal(await keyInput().inputValue(), keys.ark);
    await providerButton('openai').click(); assert.equal(await keyInput().inputValue(), keys.openai);
    await providerButton('gemini').click(); assert.equal(await keyInput().inputValue(), keys.gemini);
  });

  await check('取消记住立即移除持久 Key，本次会话输入仍保留且不影响其他服务', async () => {
    await remember().uncheck(); await waitSaved('gemini');
    assert.equal(await keyInput().inputValue(), keys.gemini);
    assert.equal((await settings()).gemini.rememberApiKey, false);
    await page.getByRole('button', { name: '关闭模型设置', exact: true }).click(); await openSettings();
    assert.equal(await keyInput().inputValue(), keys.gemini);
    const saved = await settings(); assert.equal(saved.openai.apiKey, keys.openai); assert.equal(saved.ark.apiKey, keys.ark);
    await remember().check(); await waitSaved('gemini', keys.gemini);
    await remember().uncheck(); await waitSaved('gemini');
  });

  await check('取消保存后刷新当前 Key 清空，其他服务已保存 Key 仍可恢复', async () => {
    await reloadSettings();
    assert.equal(await page.locator('.provider-grid button.selected').innerText(), 'Google Gemini');
    assert.equal(await keyInput().inputValue(), ''); assert.equal(await remember().isChecked(), false);
    await providerButton('ark').click(); assert.equal(await keyInput().inputValue(), keys.ark);
    await providerButton('openai').click(); assert.equal(await keyInput().inputValue(), keys.openai);
  });

  await check('清除密钥同时清空输入和持久值，刷新不会复活', async () => {
    await page.getByRole('button', { name: '清除密钥', exact: true }).click();
    assert.equal(await keyInput().inputValue(), ''); await waitSaved('openai');
    assert.equal((await settings()).ark.apiKey, keys.ark);
    await reloadSettings(); assert.equal(await keyInput().inputValue(), '');
    assert.equal(await page.locator('.provider-grid button.selected').innerText(), 'OpenAI');
  });

  await check('损坏 JSON 与未知服务安全回退默认配置，不出现运行时错误', async () => {
    await page.evaluate(() => {
      localStorage.setItem('luma-provider-settings', '{broken-json');
      localStorage.setItem('luma-provider-kind', 'unknown-provider');
    });
    await reloadSettings();
    assert.equal(await page.locator('.provider-grid button.selected').innerText(), 'OpenAI');
    assert.equal(await keyInput().inputValue(), ''); assert.equal(await remember().isChecked(), true);
    assert.equal(await page.getByLabel('API 地址', { exact: true }).inputValue(), 'https://api.openai.com/v1');
  });

  await check('旧版仅地址与模型的配置兼容迁移，空服务记录不导致崩溃', async () => {
    await page.evaluate(() => {
      localStorage.setItem('luma-provider-settings', JSON.stringify({ openai: { baseUrl: 'https://legacy.example.test/v1', model: 'gpt-image-2' }, gemini: null }));
      localStorage.setItem('luma-provider-kind', 'openai');
    });
    await reloadSettings();
    assert.equal(await page.getByLabel('API 地址', { exact: true }).inputValue(), 'https://legacy.example.test/v1');
    assert.equal(await remember().isChecked(), true); assert.equal(await keyInput().inputValue(), '');
    await providerButton('gemini').click();
    assert.equal(await page.getByLabel('API 地址', { exact: true }).inputValue(), 'https://generativelanguage.googleapis.com/v1');
    assert.equal(await keyInput().inputValue(), '');
  });

  await check('明确不记住的旧持久 Key 不载入，异常字段不作为有效 Key', async () => {
    await page.evaluate(() => {
      localStorage.setItem('luma-provider-settings', JSON.stringify({ openai: { rememberApiKey: false, apiKey: 'qa-stale-should-not-return' }, ark: { rememberApiKey: true, apiKey: 12345 } }));
      localStorage.setItem('luma-provider-kind', 'openai');
    });
    await reloadSettings(); assert.equal(await keyInput().inputValue(), '');
    assert.equal(await remember().isChecked(), false); await waitSaved('openai');
    await providerButton('ark').click(); assert.equal(await keyInput().inputValue(), '');
    await page.screenshot({ path: path.join(outputDir, 'remember-api-key.png'), fullPage: true });
  });

  await check('同一浏览器双页同步清除、重新保存与取消记住，不从旧配置复活 Key', async () => {
    await providerButton('ark').click();
    await remember().check();
    await keyInput().fill(keys.ark); await waitSaved('ark', keys.ark);
    const other = await context.newPage();
    other.on('pageerror', error => rendererErrors.push(error.message));
    await other.route('**/__native/request', async route => {
      modelCalls++;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '双页设置验收禁止调用模型' }) });
    });
    const otherKey = other.locator('.secret-input input');
    const otherRemember = other.getByRole('checkbox', { name: /记住 API Key/ });
    const otherArk = () => other.getByRole('button', { name: '火山方舟 · 豆包', exact: true }).click();
    try {
      await other.goto(baseUrl, { waitUntil: 'networkidle' });
      await other.locator('.settings-top').click();
      assert.equal(await otherKey.inputValue(), keys.ark);
      assert.equal(await otherRemember.isChecked(), true);

      await page.getByRole('button', { name: '清除密钥', exact: true }).click();
      await waitSaved('ark');
      await other.waitForFunction(() => document.querySelector('.secret-input input')?.value === '');
      assert.equal(await otherRemember.isChecked(), true);
      await other.getByLabel('模型名称／接入点 ID', { exact: true }).fill('doubao-seedream-4-5-251128');
      await other.getByRole('button', { name: 'Google Gemini', exact: true }).click();
      await otherArk();
      assert.equal(await otherKey.inputValue(), '');
      await waitSaved('ark');
      assert.equal(await keyInput().inputValue(), '');
      assert.equal((await settings()).ark.model, 'doubao-seedream-4-5-251128');

      const replacement = 'qa-remember-ark-new-fake-key';
      await keyInput().fill(replacement); await waitSaved('ark', replacement);
      await other.waitForFunction(expected => document.querySelector('.secret-input input')?.value === expected, replacement);
      assert.equal(await otherRemember.isChecked(), true);

      await remember().uncheck(); await waitSaved('ark');
      await other.waitForFunction(() => document.querySelector('input[type="checkbox"]')?.checked === false);
      assert.equal(await otherKey.inputValue(), replacement, '远端取消记住仍可保留当前页会话 Key');
      await other.getByLabel(/^API 地址/).fill('https://ark.cn-beijing.volces.com/api/v3/');
      await other.getByRole('button', { name: 'OpenAI', exact: true }).click();
      await otherArk();
      assert.equal(await otherRemember.isChecked(), false);
      assert.equal(await otherKey.inputValue(), replacement);
      await waitSaved('ark');
      assert.equal((await settings()).ark.rememberApiKey, false);
      assert.equal(Object.hasOwn((await settings()).ark, 'apiKey'), false);
      assert.equal(await keyInput().inputValue(), replacement);
      assert.equal(modelCalls, 0);
    } finally { await other.close(); }
  });

  await check('390 px 手机模型设置可滚动访问记住选项与完成按钮，无横向溢出', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await remember().scrollIntoViewIfNeeded();
    assert.equal(await remember().isVisible(), true);
    const complete = page.getByRole('button', { name: '完成设置', exact: true });
    await complete.scrollIntoViewIfNeeded();
    const bounds = await complete.boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 844);
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(sizes.page <= sizes.viewport && sizes.body <= sizes.viewport, JSON.stringify(sizes));
    await page.screenshot({ path: path.join(outputDir, 'android-390-remember-api-key.png'), fullPage: true });
    await complete.click();
    assert.equal(await page.getByRole('dialog', { name: '连接你的 AI 模型' }).count(), 0);
  });

  assert.equal(modelCalls, 0); assert.deepEqual(externalRequests, []); assert.deepEqual(rendererErrors, []);
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: true, modelCalls, externalRequests, rendererErrors, checks }, null, 2));
  process.stdout.write(`API Key 本机保存验收通过；报告：${outputDir}\n`);
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ passed: false, modelCalls, externalRequests, rendererErrors, checks, failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
