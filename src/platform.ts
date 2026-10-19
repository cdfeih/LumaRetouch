import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { HttpRequest, HttpResponse, HttpTransport } from './ai/types';
import { validateImageArchive } from '../electron/archive.mjs';

export { MAX_ARCHIVE_BYTES } from '../electron/archive.mjs';

declare global {
  interface Window {
    lumaNative?: {
      request(req: HttpRequest, id: string): Promise<HttpResponse>;
      cancel(id: string): void;
      exportImage(input: { base64: string; mimeType: string; suggestedName: string }): Promise<{ saved: boolean; message: string }>;
    };
  }
}

const NativeHttp = registerPlugin<{
  request(input: { request: HttpRequest; id: string }): Promise<HttpResponse>;
  cancel(input: { id: string }): Promise<void>;
}>('LumaHttp');

export const platformName = window.lumaNative ? 'Windows' : Capacitor.isNativePlatform() ? 'Android' : '浏览器';

function validateUrl(raw: string): void {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('请输入完整的模型服务地址'); }
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('服务地址须使用 HTTPS，本机服务可使用 HTTP；地址不能包含账号密码');
  }
}

const withoutPrefix = (base64: string) => base64.replace(/^data:[^;,]+;base64,/, '');

async function browserRequest(req: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = window.setTimeout(abort, 240000);
  try {
    if (import.meta.env.DEV) {
      const response = await fetch('/__native/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '本地代理请求失败');
      return result as HttpResponse;
    }
    let body: string | FormData | undefined = req.body;
    const headers = new Headers(req.headers);
    if (req.multipart) {
      const form = new FormData();
      Object.entries(req.multipart.fields).forEach(([key, value]) => form.append(key, value));
      for (const file of req.multipart.files) {
        const raw = atob(withoutPrefix(file.base64));
        const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
        form.append(file.field, new Blob([bytes], { type: file.mimeType }), file.name);
      }
      headers.delete('Content-Type');
      body = form;
    }
    const response = await fetch(req.url, { method: req.method, headers, body, signal: controller.signal, redirect: 'error', credentials: 'omit' });
    if (Number(response.headers.get('content-length')) > 128 * 1024 * 1024) throw new Error('服务返回的图片过大');
    let result: string;
    if (req.responseType === 'base64') {
      const blob = await response.blob();
      if (blob.size > 128 * 1024 * 1024) throw new Error('服务返回的图片过大');
      result = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(withoutPrefix(String(reader.result)));
        reader.onerror = () => reject(new Error('图片读取失败'));
        reader.readAsDataURL(blob);
      });
    } else result = await response.text();
    return { status: response.status, body: result, contentType: response.headers.get('content-type') || undefined };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(signal?.aborted ? '请求已取消' : '模型服务请求超时');
    if (error instanceof TypeError) throw new Error('模型连接失败；浏览器受跨域限制，请使用 Windows 或 Android 安装版');
    throw error;
  } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

export const request: HttpTransport = async (req, signal) => {
  validateUrl(req.url);
  if (signal?.aborted) throw new Error('请求已取消');
  const id = crypto.randomUUID();
  const desktop = window.lumaNative;
  if (!desktop && !Capacitor.isNativePlatform()) return browserRequest(req, signal);
  const abort = () => { if (desktop) desktop.cancel(id); else void NativeHttp.cancel({ id }).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await (desktop ? desktop.request(req, id) : NativeHttp.request({ request: req, id }));
    if (signal?.aborted) throw new Error('请求已取消');
    return result;
  } finally { signal?.removeEventListener('abort', abort); }
};

export async function exportImage(base64: string, mimeType: string, suggestedName: string): Promise<{ saved: boolean; message: string }> {
  const clean = withoutPrefix(base64);
  if (window.lumaNative) return window.lumaNative.exportImage({ base64: clean, mimeType, suggestedName });
  const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[mimeType];
  if (!extension) throw new Error('不支持的导出格式');
  const name = suggestedName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.(png|jpe?g|webp)$/i, '').slice(0, 100) || '光修作品';
  if (Capacitor.isNativePlatform()) {
    const path = `exports/${Date.now()}-${name}.${extension}`;
    const file = await Filesystem.writeFile({ path, data: clean, directory: Directory.Cache, recursive: true });
    try {
      await Share.share({ title: '导出精修照片', files: [file.uri], dialogTitle: '保存或分享照片' });
      return { saved: true, message: '照片已交给系统分享，请在分享窗口选择保存位置' };
    } catch { return { saved: false, message: '已取消分享，照片仍保留在应用临时缓存' }; }
  }
  const raw = atob(clean);
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url; link.download = `${name}.${extension}`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { saved: true, message: '已开始下载照片' };
}

function archiveBase64(bytes: Uint8Array): string {
  // Every full chunk is divisible by 3, so concatenated Base64 has no interior
  // padding. A small per-chunk string avoids spreading a large array on stack.
  const chunkSize = 24 * 1024;
  let encoded = '';
  for (let start = 0; start < bytes.length; start += chunkSize) {
    let binary = '';
    const end = Math.min(bytes.length, start + chunkSize);
    for (let index = start; index < end; index++) binary += String.fromCharCode(bytes[index]);
    encoded += btoa(binary);
  }
  return encoded;
}

/** Save an app-generated image ZIP through the existing explicit save/share UI. */
export async function exportArchive(bytes: Uint8Array<ArrayBuffer>, suggestedName: string): Promise<{ saved: boolean; message: string }> {
  validateImageArchive(bytes);
  const name = suggestedName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.zip$/i, '').slice(0, 100).replace(/[. ]+$/g, '') || '光修照片合集';
  if (window.lumaNative) return window.lumaNative.exportImage({ base64: archiveBase64(bytes), mimeType: 'application/zip', suggestedName: `${name}.zip` });
  if (Capacitor.isNativePlatform()) {
    let file: { uri: string };
    try { file = await Filesystem.writeFile({ path: `exports/${Date.now()}-${name}.zip`, data: archiveBase64(bytes), directory: Directory.Cache, recursive: true }); }
    catch { throw new Error('压缩包写入手机缓存失败，请检查存储空间后重试。'); }
    try {
      await Share.share({ title: '导出照片压缩包', files: [file.uri], dialogTitle: '保存或分享照片压缩包' });
      return { saved: true, message: '照片压缩包已交给系统分享，请在分享窗口选择保存位置' };
    } catch (error) {
      if (error instanceof Error && /cancel|取消/i.test(error.message)) return { saved: false, message: '已取消分享，压缩包仍保留在应用临时缓存' };
      throw new Error('压缩包分享失败，请重试或更换保存方式。');
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url; link.download = `${name}.zip`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { saved: true, message: '已开始下载照片压缩包' };
}
