/**
 * 接口合同（2026-10-19 核对；不依赖聊天接口冒充修图）：
 * https://developers.openai.com/api/reference/resources/images/methods/edit
 * https://ai.google.dev/gemini-api/docs/generate-content/image-generation
 * https://console.volcengine.com/ark/region:cn-beijing/docs/image-generation-api
 */
import type { EditImageInput, EditedImage, HttpRequest, HttpResponse, HttpTransport, ProviderConfig } from './types';
import { RetouchError } from './errors';

export type { EditImageInput, EditedImage, HttpRequest, HttpResponse, HttpTransport, ProviderConfig, RetouchTool } from './types';
export { RetouchError } from './errors';
export type { RetouchErrorCode } from './errors';
export { STYLE_PRESETS, SKY_PRESETS, buildCreativePrompt, buildRetouchPrompt } from './creative';
export type { StylePreset, SkyPreset, CreativePromptInput } from './creative';

/** 已核对官方图像编辑合同；型号仍由用户按实际账号权限配置。 */
export const DEFAULT_PROVIDERS: Record<ProviderConfig['kind'], { label: string; baseUrl: string; model: string }> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2' },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1', model: 'gemini-3.1-flash-image' },
  ark: { label: '火山方舟 · 豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-4-0-250828' },
  compatible: { label: '兼容图像编辑接口', baseUrl: '', model: '' },
};

type JsonObject = Record<string, unknown>;
const SUPPORTED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function abortError(): Error {
  const error = new Error('已取消修图请求。');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** 即使某平台的底层请求不支持取消，也不再等待或接纳它的过期结果。 */
async function request(transport: HttpTransport, input: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
  throwIfAborted(signal);
  try {
    const result = await new Promise<HttpResponse>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(() => {
        throwIfAborted(signal);
        return transport(input, signal);
      }).then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
    });
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError();
    // 平台原始异常可能包含完整 URL、Authorization 或图片正文，不能直接展示。
    throw new RetouchError('NETWORK', '无法连接图像服务，请检查网络、服务地址及该服务的访问条件。');
  }
}

function safeMessage(message: string, apiKey: string): string {
  let safe = message;
  for (const secret of [apiKey.trim(), encodeURIComponent(apiKey.trim())]) {
    if (secret) safe = safe.split(secret).join('[已隐藏]');
  }
  safe = safe.replace(/Bearer\s+[^\s,"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk-|AIza)[A-Za-z0-9_-]{8,}/g, '[已隐藏]')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+/gi, '[图片已隐藏]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[服务链接已隐藏]')
    .replace(/[\u0000-\u001f]/g, ' ');
  const summary = safe.slice(0, 240);
  // 请求编号常位于长错误末尾；仅从已脱敏的内容提取，便于向服务商反馈。
  const requestId = /\brequest[\s_-]*id\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9_-]{0,127})\b/i.exec(safe)?.[1];
  return requestId && !summary.includes(requestId) ? `${summary} Request id: ${requestId}` : summary;
}

/** 方舟把版权与内容检查也返回为 HTTP 400，优先读取具体原因。 */
function contentFilterMessage(code: string, detail = ''): string | undefined {
  if (/^OutputImageSensitiveContentDetected\.PolicyViolation$/i.test(code) || /copyright\s+restrictions?/i.test(detail)) {
    const subject = /^Output/i.test(code) || /output\s+image/i.test(detail) ? '生成图片' : '请求内容';
    return `图像服务认为${subject}可能涉及版权限制，已拦截此次请求。请检查修图描述或素材；如认为误判，可凭请求编号向服务商反馈。`;
  }
  if (/content_policy|safety|moderation|content_filter|SensitiveContentDetected|(?:Input|Output)(?:Text|Image|Video|Audio)RiskDetection/i.test(code)) {
    return '请求触发了图像服务的内容检查，未返回可用图片。请检查照片或修图要求；如认为误判，可凭请求编号向服务商反馈。';
  }
  return undefined;
}

function parseResponse(response: HttpResponse, apiKey: string): JsonObject {
  let parsed: JsonObject | undefined;
  try { parsed = asObject(JSON.parse(response.body)); } catch { /* HTML 代理错误不可直接显示。 */ }
  const failure = asObject(parsed?.error);
  if (response.status < 200 || response.status >= 300 || failure) {
    const status = response.status;
    const reasons: Record<number, string> = {
      400: '请求参数不被服务支持，请检查图像编辑模型、图片及选区。',
      401: 'API Key 无效或已过期。',
      403: '账号没有此图像模型的权限，或当前地区无法使用。',
      404: '图像接口或模型不存在，请检查 Base URL 和模型名称。',
      413: '图片过大，请缩小图片后重试。',
      429: '额度不足或请求频率过高，请检查模型账号后稍后重试。',
    };
    const detail = text(failure?.message);
    const fallback = reasons[status] ?? (status >= 500 ? `图像服务内部错误（HTTP ${status}），请稍后手动重试；持续出现时可向服务商提供请求编号。` : '图像服务拒绝了请求。');
    const code = text(failure?.code) ?? '';
    const filtered = contentFilterMessage(code, detail);
    throw new RetouchError(filtered ? 'CONTENT_FILTER' : 'HTTP', `${filtered ?? fallback}${detail ? ` 服务提示：${safeMessage(detail, apiKey)}` : ''}`, status);
  }
  if (!parsed) throw new RetouchError('INVALID_RESPONSE', '服务没有返回有效的图像 API JSON，请确认地址指向图像编辑接口。');
  return parsed;
}

function checkedUrl(raw: string, purpose: 'service' | 'image'): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new RetouchError('CONFIG', '请输入完整的图像服务 URL。'); }
  if (url.username || url.password || (purpose === 'service' && (url.search || url.hash))) {
    throw new RetouchError('CONFIG', '服务 URL 不能内嵌凭据、查询参数或片段；请在 API Key 栏填写密钥。');
  }
  if (url.protocol !== 'https:' && !(purpose === 'service' && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new RetouchError('CONFIG', '远程图像服务和结果下载必须使用 HTTPS；仅本机服务可使用 HTTP。');
  }
  return url;
}

function cleanBase64(value: string, label: string): string {
  const encoded = value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s/g, '');
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new RetouchError('INPUT', `${label}不是有效的 Base64 图片。`);
  }
  return encoded;
}

function inferredMime(base64: string, fallback?: string): string {
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return fallback && SUPPORTED_MIMES.has(fallback) ? fallback : 'image/png';
}

function imageResult(data: string, fallbackMime?: string): EditedImage {
  const declaredMime = /^data:(image\/[^;]+);base64,/.exec(data)?.[1];
  const imageBase64 = cleanBase64(data, '服务返回的图片');
  return { imageBase64, mimeType: inferredMime(imageBase64, declaredMime ?? fallbackMime) };
}

function validate(input: EditImageInput): { baseUrl: string; model: string; image: string; reference?: { base64: string; mimeType: string } } {
  throwIfAborted(input.signal);
  const { provider } = input;
  if (!provider.apiKey.trim()) throw new RetouchError('CONFIG', '请先填写所选图像服务的 API Key。');
  const serviceUrl = checkedUrl(provider.baseUrl.trim(), 'service');
  // 方舟控制台示例常提供完整端点；与基础地址等价处理，避免重复追加路径。
  if (provider.kind === 'ark') serviceUrl.pathname = serviceUrl.pathname.replace(/(?:\/images\/generations)+\/?$/, '');
  const baseUrl = serviceUrl.toString().replace(/\/+$/, '');
  const model = provider.model.trim().replace(/^models\//, '');
  if (!model || !/^[\w.-]+$/.test(model)) throw new RetouchError('CONFIG', '请填写有效的图像编辑模型名称或推理端点 ID。');
  if (provider.kind === 'openai' && !/^(gpt-image-|chatgpt-image-latest$)/.test(model)) {
    throw new RetouchError('CONFIG', 'OpenAI 需要 GPT Image 图像编辑模型，聊天模型不能用于此接口。');
  }
  if (provider.kind === 'gemini' && !/(?:image|nano-banana)/i.test(model)) {
    throw new RetouchError('CONFIG', '请选择 Gemini 原生图像生成与编辑模型，普通文字或视觉理解模型无法返回照片。');
  }
  if (provider.kind === 'ark' && !/(?:seedream|seededit)|^ep-/i.test(model)) {
    throw new RetouchError('CONFIG', '火山方舟需要 Seedream / SeedEdit 图像模型或对应的 ep- 推理端点。');
  }
  if (provider.kind === 'compatible' && /^(?:gpt-[3456](?:[.-]|$)|o[134](?:-|$)|claude-|deepseek-(?:chat|reasoner)|gemini-(?!.*image))/i.test(model)) {
    throw new RetouchError('CONFIG', '该名称看起来是聊天模型。兼容服务必须实际支持 /images/edits 图像编辑接口。');
  }
  if (!SUPPORTED_MIMES.has(input.mimeType)) throw new RetouchError('INPUT', '请使用 PNG、JPEG 或 WebP 图片。');
  if (input.referenceImage && !SUPPORTED_MIMES.has(input.referenceImage.mimeType)) throw new RetouchError('INPUT', '风格参考图请使用 PNG、JPEG 或 WebP。');
  if (!input.prompt.trim()) throw new RetouchError('INPUT', '修图提示词不能为空。');
  if (input.prompt.length > 32000) throw new RetouchError('INPUT', '修图提示词过长，请精简到 32000 字符以内。');
  if ((provider.kind === 'gemini' || provider.kind === 'ark') && input.maskBase64 && !input.maskGuideBase64) {
    throw new RetouchError('INPUT', '该服务需要白色可改、黑色保护的选区参考图。');
  }
  const reference = input.referenceImage ? { mimeType: input.referenceImage.mimeType, base64: cleanBase64(input.referenceImage.base64, '风格参考图') } : undefined;
  return { baseUrl, model, image: cleanBase64(input.imageBase64, '原图'), reference };
}

const REFERENCE_ROLE_PROMPT = '第 1 张图是唯一待修照片；第 2 张图仅为风格/色调参考，不是选区或待修画布。只按本任务允许的范围迁移其色调或视觉表现，不复制参考图中的人物、服装、物体、背景或构图。';
const maskGuidePrompt = (imageIndex: number) => `第 1 张图是待修照片，第 ${imageIndex} 张图仅是同尺寸选区参考图：白色区域允许编辑，黑色区域必须保护。只编辑第 1 张图，不输出选区参考图，不将黑白遮罩画入结果。保持原照片尺寸、构图和人物身份。`;
const NATIVE_MASK_PROMPT = '仅编辑随附 mask 中透明的区域。其他区域、画幅、构图及人物身份必须保持不变。不要在照片中显示 mask。';
const imageExtension = (mimeType: string) => mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1];

function makeRequest(input: EditImageInput): HttpRequest {
  const { baseUrl, model, image, reference } = validate(input);
  const { provider } = input;
  const imageDataUri = `data:${input.mimeType};base64,${image}`;
  if (provider.kind === 'gemini') {
    const parts: JsonObject[] = [{ text: input.prompt }, { inlineData: { mimeType: input.mimeType, data: image } }];
    if (reference) parts.push({ text: REFERENCE_ROLE_PROMPT }, { inlineData: { mimeType: reference.mimeType, data: reference.base64 } });
    if (input.maskGuideBase64) {
      parts.push({ text: maskGuidePrompt(reference ? 3 : 2) }, { inlineData: { mimeType: 'image/png', data: cleanBase64(input.maskGuideBase64, '选区参考图') } });
    }
    return {
      url: `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': provider.apiKey.trim() },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
      responseType: 'text',
    };
  }
  if (provider.kind === 'ark') {
    const images = [imageDataUri];
    if (reference) images.push(`data:${reference.mimeType};base64,${reference.base64}`);
    if (input.maskGuideBase64) images.push(`data:image/png;base64,${cleanBase64(input.maskGuideBase64, '选区参考图')}`);
    const prompt = [input.prompt, reference ? REFERENCE_ROLE_PROMPT : '', input.maskGuideBase64 ? maskGuidePrompt(reference ? 3 : 2) : ''].filter(Boolean).join('\n');
    return {
      url: `${baseUrl}/images/generations`, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey.trim()}` },
      body: JSON.stringify({ model, prompt, image: images.length > 1 ? images : images[0], response_format: 'b64_json', size: '2K', watermark: true }),
      responseType: 'text',
    };
  }
  const prompt = [input.prompt, reference ? REFERENCE_ROLE_PROMPT : '', input.maskBase64 ? NATIVE_MASK_PROMPT : ''].filter(Boolean).join('\n');
  const fields: Record<string, string> = { model, prompt, n: '1' };
  // GPT Image 固定返回 Base64，不能发送仅旧模型支持的 response_format。
  if (provider.kind === 'openai' || model.startsWith('gpt-image-')) fields.output_format = 'png';
  // 多图采用官方 image[] 合同；透明 mask 仍是独立字段，只作用于第 1 张图。
  const imageField = reference ? 'image[]' : 'image';
  const files = [{ field: imageField, name: `photo.${imageExtension(input.mimeType)}`, mimeType: input.mimeType, base64: image }];
  if (reference) files.push({ field: imageField, name: `reference.${imageExtension(reference.mimeType)}`, mimeType: reference.mimeType, base64: reference.base64 });
  if (input.maskBase64) files.push({ field: 'mask', name: 'mask.png', mimeType: 'image/png', base64: cleanBase64(input.maskBase64, '选区') });
  return { url: `${baseUrl}/images/edits`, method: 'POST', headers: { Authorization: `Bearer ${provider.apiKey.trim()}` }, multipart: { fields, files }, responseType: 'text' };
}

async function extractStandardImage(response: JsonObject, input: EditImageInput, transport: HttpTransport): Promise<EditedImage> {
  const images = Array.isArray(response.data) ? response.data : [];
  for (const value of images) {
    const image = asObject(value);
    const base64 = text(image?.b64_json);
    if (base64) return imageResult(base64, text(image?.mime_type) ?? (response.output_format === 'jpeg' ? 'image/jpeg' : undefined));
    const url = text(image?.url);
    if (url?.startsWith('data:image/')) return imageResult(url);
    if (url) {
      checkedUrl(url, 'image');
      // CDN 下载不携带模型 Key，包括来自兼容服务的跨域结果。
      const downloaded = await request(transport, { url, method: 'GET', responseType: 'base64' }, input.signal);
      if (downloaded.status < 200 || downloaded.status >= 300) throw new RetouchError('HTTP', `修图已完成，但下载结果失败（HTTP ${downloaded.status}），请重试。`, downloaded.status);
      const contentType = downloaded.contentType?.split(';')[0].trim().toLowerCase();
      if (contentType && !SUPPORTED_MIMES.has(contentType) && contentType !== 'application/octet-stream') throw new RetouchError('INVALID_RESPONSE', '结果下载地址返回的不是图片。');
      return imageResult(downloaded.body, contentType);
    }
  }
  for (const value of images) {
    const imageError = asObject(asObject(value)?.error);
    const detail = text(imageError?.message);
    const filtered = contentFilterMessage(text(imageError?.code) ?? '', detail);
    if (filtered) throw new RetouchError('CONTENT_FILTER', `${filtered}${detail ? ` 服务提示：${safeMessage(detail, input.provider.apiKey)}` : ''}`);
  }
  throw new RetouchError('NO_IMAGE', '服务没有返回编辑后的图片。请确认此模型支持图像编辑，并检查账号权限或内容限制。');
}

function extractGeminiImage(response: JsonObject): EditedImage {
  const feedback = asObject(response.promptFeedback) ?? asObject(response.prompt_feedback);
  if (feedback?.blockReason || feedback?.block_reason) throw new RetouchError('CONTENT_FILTER', '服务的内容检查拦截了此次图片请求，请调整照片或修图要求。');
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  let blocked = false;
  for (const entry of candidates) {
    const candidate = asObject(entry);
    const finish = text(candidate?.finishReason) ?? text(candidate?.finish_reason) ?? '';
    if (/SAFETY|BLOCKLIST|PROHIBITED|IMAGE_SAFETY|RECITATION/i.test(finish)) { blocked = true; continue; }
    const content = asObject(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const item of parts) {
      const part = asObject(item);
      if (part?.thought === true) continue; // Gemini 3 的中间思考图不能作为最终照片。
      const inline = asObject(part?.inlineData) ?? asObject(part?.inline_data);
      const data = text(inline?.data);
      const mime = text(inline?.mimeType) ?? text(inline?.mime_type);
      if (data && mime && SUPPORTED_MIMES.has(mime)) return imageResult(data, mime);
    }
  }
  if (blocked) throw new RetouchError('CONTENT_FILTER', '服务的内容检查未返回图片，请调整照片或修图要求。');
  throw new RetouchError('NO_IMAGE', 'Gemini 只返回了文字或空结果。请选择支持原生图像输出的模型，并检查账号权限。');
}

/** 单次编辑，不自动重试付费调用。取消后忽略迟到的结果。 */
export async function editImage(input: EditImageInput, transport: HttpTransport): Promise<EditedImage> {
  const httpRequest = makeRequest(input);
  const httpResponse = await request(transport, httpRequest, input.signal);
  const response = parseResponse(httpResponse, input.provider.apiKey);
  return input.provider.kind === 'gemini' ? extractGeminiImage(response) : extractStandardImage(response, input, transport);
}
