/** 可序列化的 HTTP 合同，由浏览器、Android 或 Windows 原生层执行。 */
export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  multipart?: {
    fields: Record<string, string>;
    files: Array<{ field: string; name: string; mimeType: string; base64: string }>;
  };
  responseType?: 'text' | 'base64';
}

export interface HttpResponse {
  status: number;
  body: string;
  contentType?: string;
}

export type HttpTransport = (request: HttpRequest, signal?: AbortSignal) => Promise<HttpResponse>;

export interface ProviderConfig {
  kind: 'openai' | 'gemini' | 'compatible' | 'ark';
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type RetouchTool = 'smooth' | 'blemish' | 'remove' | 'sky' | 'people' | 'add' | 'style' | 'match' | 'point';

export interface EditImageInput {
  provider: ProviderConfig;
  imageBase64: string;
  mimeType: string;
  prompt: string;
  /** 仅作为视觉风格或色调参考；原始待修照片始终是第 1 张图。 */
  referenceImage?: { base64: string; mimeType: string };
  /** PNG，与原图同尺寸，alpha=0 的区域可以修改。 */
  maskBase64?: string;
  /** PNG，与原图同尺寸，白色可改、黑色保护；用于多模态模型的参考图。 */
  maskGuideBase64?: string;
  signal?: AbortSignal;
}

export interface EditedImage {
  imageBase64: string;
  mimeType: string;
}
