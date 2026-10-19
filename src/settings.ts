import { DEFAULT_PROVIDERS } from './ai';
import type { ProviderConfig } from './ai';

export type ProviderKind = ProviderConfig['kind'];
export type ProviderSettings = ProviderConfig & { rememberApiKey: boolean };
export type ProviderSettingsMap = Record<ProviderKind, ProviderSettings>;
export type StorageStatus = 'saved' | 'unavailable' | 'clear-failed';
type SettingsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const SETTINGS_KEY = 'luma-provider-settings';
const PROVIDER_KEY = 'luma-provider-kind';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function loadProviderSettings(storage?: SettingsStorage): ProviderSettingsMap {
  const result = Object.fromEntries(Object.entries(DEFAULT_PROVIDERS).map(([kind, value]) => [kind, { kind, baseUrl: value.baseUrl, model: value.model, apiKey: '', rememberApiKey: true }])) as ProviderSettingsMap;
  try {
    const saved: unknown = JSON.parse((storage ?? window.localStorage).getItem(SETTINGS_KEY) || '{}');
    if (!isRecord(saved)) return result;
    for (const kind of Object.keys(result) as ProviderKind[]) {
      const config = saved[kind];
      if (!isRecord(config)) continue;
      if (typeof config.baseUrl === 'string') result[kind].baseUrl = config.baseUrl;
      if (typeof config.model === 'string') result[kind].model = config.model;
      if (typeof config.rememberApiKey === 'boolean') result[kind].rememberApiKey = config.rememberApiKey;
      if (config.rememberApiKey === true && typeof config.apiKey === 'string') result[kind].apiKey = config.apiKey;
    }
  } catch { /* Restricted storage or damaged settings fall back to session defaults. */ }
  return result;
}

export function loadProviderKind(storage?: SettingsStorage): ProviderKind {
  try {
    const kind = (storage ?? window.localStorage).getItem(PROVIDER_KEY);
    if (kind && Object.hasOwn(DEFAULT_PROVIDERS, kind)) return kind as ProviderKind;
  } catch { /* Keep the default service when storage is unavailable. */ }
  return 'openai';
}

export function saveProviderSettings(configs: ProviderSettingsMap, providerKind: ProviderKind, storage?: SettingsStorage): StorageStatus {
  let target: SettingsStorage;
  try { target = storage ?? window.localStorage; }
  catch { return 'unavailable'; }
  try {
    target.setItem(SETTINGS_KEY, JSON.stringify(Object.fromEntries(Object.entries(configs).map(([kind, config]) => [kind, {
      baseUrl: config.baseUrl,
      model: config.model,
      rememberApiKey: config.rememberApiKey,
      ...(config.rememberApiKey && config.apiKey ? { apiKey: config.apiKey } : {}),
    }]))));
  } catch {
    // If a write fails, remove the old record so clearing or opting out cannot leave an old key behind.
    try { target.removeItem(SETTINGS_KEY); }
    catch { return 'clear-failed'; }
    return 'unavailable';
  }
  try { target.setItem(PROVIDER_KEY, providerKind); }
  catch { return 'unavailable'; }
  return 'saved';
}
