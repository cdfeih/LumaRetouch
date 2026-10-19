import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS } from './ai';
import { loadProviderKind, loadProviderSettings, saveProviderSettings } from './settings';

function storageWith(values: Record<string, string> = {}) {
  const data = new Map(Object.entries(values));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

describe('模型设置的本地保存', () => {
  it('旧版设置保留地址和型号，首次默认记住但不恢复没有明确许可标志的密钥', () => {
    const storage = storageWith({ 'luma-provider-settings': JSON.stringify({ ark: { baseUrl: 'https://example.test/api/v3', model: 'my-endpoint', apiKey: 'unexpected-legacy-key' } }) });
    expect(loadProviderSettings(storage).ark).toMatchObject({ baseUrl: 'https://example.test/api/v3', model: 'my-endpoint', rememberApiKey: true, apiKey: '' });
  });

  it('重新加载分别恢复各服务的密钥、记忆选项及上次服务，不串用密钥', () => {
    const storage = storageWith();
    const configs = loadProviderSettings(storage);
    configs.ark.apiKey = 'fake-ark-key';
    configs.gemini.apiKey = 'fake-gemini-key';
    configs.openai.apiKey = 'fake-session-key';
    configs.openai.rememberApiKey = false;
    expect(saveProviderSettings(configs, 'ark', storage)).toBe('saved');
    const reloaded = loadProviderSettings(storage);
    expect(reloaded.ark.apiKey).toBe('fake-ark-key');
    expect(reloaded.gemini.apiKey).toBe('fake-gemini-key');
    expect(reloaded.openai).toMatchObject({ apiKey: '', rememberApiKey: false });
    expect(storage.getItem('luma-provider-settings')).not.toContain('fake-session-key');
    expect(loadProviderKind(storage)).toBe('ark');
  });

  it.each(['null', '[]', '123', '"text"', '{broken'])('损坏或非对象的设置 %s 不阻止启动', value => {
    const configs = loadProviderSettings(storageWith({ 'luma-provider-settings': value }));
    expect(configs.ark).toMatchObject({ kind: 'ark', baseUrl: DEFAULT_PROVIDERS.ark.baseUrl, model: DEFAULT_PROVIDERS.ark.model, apiKey: '', rememberApiKey: true });
  });

  it('忽略无效字段及未知服务，明确关闭记忆时不恢复残留密钥', () => {
    const storage = storageWith({
      'luma-provider-settings': JSON.stringify({ ark: { apiKey: 'stale-key', rememberApiKey: false, baseUrl: null, model: 123 }, gemini: [] }),
      'luma-provider-kind': '__proto__',
    });
    expect(loadProviderSettings(storage).ark).toMatchObject({ apiKey: '', rememberApiKey: false, baseUrl: DEFAULT_PROVIDERS.ark.baseUrl, model: DEFAULT_PROVIDERS.ark.model });
    expect(loadProviderKind(storage)).toBe('openai');
  });

  it.each(['opt-out', 'clear'])('%s 遇到存储写入失败时仍删除旧密钥，不显示已保存', action => {
    const storage = storageWith();
    const configs = loadProviderSettings(storage);
    configs.ark.apiKey = 'fake-saved-key';
    saveProviderSettings(configs, 'ark', storage);
    if (action === 'opt-out') configs.ark.rememberApiKey = false;
    else configs.ark.apiKey = '';
    storage.setItem = () => { throw new Error('QuotaExceededError'); };
    expect(saveProviderSettings(configs, 'ark', storage)).toBe('unavailable');
    expect(storage.getItem('luma-provider-settings')).toBeNull();
    expect(loadProviderSettings(storage).ark.apiKey).toBe('');
    expect(configs.ark.apiKey).toBe(action === 'opt-out' ? 'fake-saved-key' : '');
  });

  it('读写和清除都被浏览器禁止时安全降级，并明确报告无法清除', () => {
    const fail = () => { throw new Error('SecurityError'); };
    const storage = { getItem: fail, setItem: fail, removeItem: fail };
    const configs = loadProviderSettings(storage);
    expect(configs.ark.apiKey).toBe('');
    expect(loadProviderKind(storage)).toBe('openai');
    expect(saveProviderSettings(configs, 'ark', storage)).toBe('clear-failed');
  });
});
