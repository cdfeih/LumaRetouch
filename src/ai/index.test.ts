import { describe, expect, it, vi } from 'vitest';
import { buildRetouchPrompt, DEFAULT_PROVIDERS, editImage, RetouchError } from './index';
import type { EditImageInput, HttpResponse, HttpTransport, ProviderConfig } from './types';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8j0AAAAASUVORK5CYII=';
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2Q==';
const config = (kind: ProviderConfig['kind']): ProviderConfig => ({ kind, apiKey: 'secret-client-key', ...DEFAULT_PROVIDERS[kind] });
const input = (kind: ProviderConfig['kind'] = 'openai'): EditImageInput => ({ provider: config(kind), imageBase64: PNG, mimeType: 'image/png', prompt: '自然修复照片' });
const response = (body: unknown, status = 200): HttpResponse => ({ status, body: JSON.stringify(body) });
const imageResponse = () => response({ data: [{ b64_json: PNG }] });

describe('真实图像接口合同', () => {
  it.each([
    'https://ark.cn-beijing.volces.com/api/v3',
    'https://ark.cn-beijing.volces.com/api/v3/',
    'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    'https://ark.cn-beijing.volces.com/api/v3/images/generations/',
  ])('Seedream 5.0 Flash 将基础地址或完整端点 %s 归一为一次调用', async baseUrl => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(imageResponse());
    const edit = input('ark');
    edit.provider = { ...edit.provider, baseUrl, model: 'doubao-seedream-5-0-flash-260915' };
    await editImage(edit, transport);
    expect(transport).toHaveBeenCalledOnce();
    const http = transport.mock.calls[0][0];
    expect(http.url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
    expect(JSON.parse(http.body!)).toMatchObject({ model: 'doubao-seedream-5-0-flash-260915', response_format: 'b64_json', size: '2K', image: `data:image/png;base64,${PNG}` });
  });

  it('方舟自定义部署前缀和无效查询参数不会被归一化误改', async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(imageResponse());
    const edit = input('ark');
    edit.provider.baseUrl = 'https://ark.example.test/custom/api/v3/images/generations';
    await editImage(edit, transport);
    expect(transport.mock.calls[0][0].url).toBe('https://ark.example.test/custom/api/v3/images/generations');
    edit.provider.baseUrl += '?key=not-a-real-key';
    await expect(editImage(edit, transport)).rejects.toMatchObject({ code: 'CONFIG' });
    expect(transport).toHaveBeenCalledOnce();
  });
  it('OpenAI 上传原图和透明选区，不传聊天字段或 GPT Image 不支持的 response_format', async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(imageResponse());
    await expect(editImage({ ...input(), maskBase64: PNG }, transport)).resolves.toEqual({ imageBase64: PNG, mimeType: 'image/png' });
    const [http] = transport.mock.calls[0];
    expect(http.url).toBe('https://api.openai.com/v1/images/edits');
    expect(http.headers).toEqual({ Authorization: 'Bearer secret-client-key' });
    expect(http.headers).not.toHaveProperty('Content-Type');
    expect(http.multipart?.fields).toMatchObject({ model: 'gpt-image-2', n: '1', output_format: 'png' });
    expect(http.multipart?.fields).not.toHaveProperty('response_format');
    expect(http.multipart?.fields.prompt).toContain('透明');
    expect(http.multipart?.files).toEqual([
      { field: 'image', name: 'photo.png', mimeType: 'image/png', base64: PNG },
      { field: 'mask', name: 'mask.png', mimeType: 'image/png', base64: PNG },
    ]);
  });

  it('Gemini 原图与黑白选区以多 part 提交，跳过文字和思考图返回最终图片', async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(response({ candidates: [{ content: { parts: [
      { text: 'Done' }, { thought: true, inlineData: { mimeType: 'image/png', data: PNG } },
      { inlineData: { mimeType: 'image/jpeg', data: JPEG } },
    ] }, finishReason: 'STOP' }] }));
    const result = await editImage({ ...input('gemini'), maskBase64: PNG, maskGuideBase64: PNG }, transport);
    expect(result).toEqual({ imageBase64: JPEG, mimeType: 'image/jpeg' });
    const [http] = transport.mock.calls[0];
    expect(http.url).toBe('https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-image:generateContent');
    expect(http.headers).toMatchObject({ 'x-goog-api-key': 'secret-client-key' });
    expect(http.url).not.toContain('secret-client-key');
    const body = JSON.parse(http.body!);
    expect(body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(body.contents[0].parts.filter((part: Record<string, unknown>) => part.inlineData)).toHaveLength(2);
    expect(body.contents[0].parts[2].text).toContain('白色区域允许编辑');
  });

  it('Gemini 支持 REST snake_case 返回数据，并且不把内容过滤当作成功', async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValueOnce(response({ candidates: [{ content: { parts: [
      { inline_data: { mime_type: 'image/png', data: PNG } },
    ] } }] })).mockResolvedValueOnce(response({ promptFeedback: { blockReason: 'SAFETY' } }));
    await expect(editImage(input('gemini'), transport)).resolves.toMatchObject({ imageBase64: PNG });
    await expect(editImage(input('gemini'), transport)).rejects.toMatchObject({ code: 'CONTENT_FILTER' });
  });

  it('方舟使用原生图生图 JSON 合同，将 maskGuide 作为第二张参考图', async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(imageResponse());
    await editImage({ ...input('ark'), maskBase64: PNG, maskGuideBase64: PNG }, transport);
    const [http] = transport.mock.calls[0];
    expect(http.url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
    expect(http.headers?.Authorization).toBe('Bearer secret-client-key');
    expect(JSON.parse(http.body!)).toMatchObject({
      model: 'doubao-seedream-4-0-250828', response_format: 'b64_json', size: '2K', watermark: true,
      image: [`data:image/png;base64,${PNG}`, `data:image/png;base64,${PNG}`],
    });
    expect(JSON.parse(http.body!).prompt).toContain('黑色区域必须保护');
  });

  it('兼容接口允许独立图像模型名称，下载结果不把 Key 发给 CDN', async () => {
    const transport = vi.fn<HttpTransport>()
      .mockResolvedValueOnce(response({ data: [{ url: 'https://images.example.test/result.jpg?signature=temp' }] }))
      .mockResolvedValueOnce({ status: 200, body: JPEG, contentType: 'image/jpeg' });
    const data = input('compatible');
    data.provider = { ...data.provider, baseUrl: 'https://custom.example.test/v1/', model: 'qwen-image-edit' };
    await expect(editImage(data, transport)).resolves.toEqual({ imageBase64: JPEG, mimeType: 'image/jpeg' });
    expect(transport.mock.calls[0][0].url).toBe('https://custom.example.test/v1/images/edits');
    expect(transport.mock.calls[0][0].multipart?.fields).not.toHaveProperty('output_format');
    expect(transport.mock.calls[1][0]).toEqual({ url: 'https://images.example.test/result.jpg?signature=temp', method: 'GET', responseType: 'base64' });
  });
});

describe('失败及取消', () => {
  it('服务端内部错误保留 HTTP 状态和请求编号，不自动重试计费请求', async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(response({ error: { code: 'InternalServiceError', message: 'The service encountered an unexpected internal error. Request id: qa-request-500' } }, 500));
    await expect(editImage(input('ark'), transport)).rejects.toMatchObject({ code: 'HTTP', status: 500, message: expect.stringContaining('HTTP 500') });
    expect(transport).toHaveBeenCalledOnce();
  });
  it('HTTP 错误包含可操作信息并清除响应回显的 Key 与链接', async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(response({ error: { message: 'Bad secret-client-key at https://host.test/?key=secret-client-key' } }, 401));
    try {
      await editImage(input(), transport);
      expect.fail('应拒绝错误响应');
    } catch (error) {
      expect(error).toBeInstanceOf(RetouchError);
      expect((error as RetouchError).status).toBe(401);
      expect((error as Error).message).toContain('API Key');
      expect((error as Error).message).not.toContain('secret-client-key');
      expect((error as Error).message).not.toContain('https://host.test');
    }
  });

  it('网络错误不直接传播含 Authorization 的底层异常', async () => {
    const transport = vi.fn<HttpTransport>().mockRejectedValue(new Error('Authorization: Bearer secret-client-key'));
    await expect(editImage(input(), transport)).rejects.toMatchObject({ code: 'NETWORK', message: expect.not.stringContaining('secret-client-key') });
  });

  it('区分无图、纯文字、内容过滤与无效 JSON', async () => {
    const transport = vi.fn<HttpTransport>()
      .mockResolvedValueOnce(response({ data: [] }))
      .mockResolvedValueOnce(response({ candidates: [{ content: { parts: [{ text: 'I cannot edit this.' }] } }] }))
      .mockResolvedValueOnce(response({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] }))
      .mockResolvedValueOnce({ status: 200, body: '<html>Login</html>' });
    await expect(editImage(input(), transport)).rejects.toMatchObject({ code: 'NO_IMAGE' });
    await expect(editImage(input('gemini'), transport)).rejects.toMatchObject({ code: 'NO_IMAGE' });
    await expect(editImage(input('gemini'), transport)).rejects.toMatchObject({ code: 'CONTENT_FILTER' });
    await expect(editImage(input(), transport)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('下载失败或返回 HTML 时不将其保存成照片', async () => {
    const transport = vi.fn<HttpTransport>()
      .mockResolvedValueOnce(response({ data: [{ url: 'https://cdn.example.test/result.png' }] }))
      .mockResolvedValueOnce({ status: 403, body: '' })
      .mockResolvedValueOnce(response({ data: [{ url: 'https://cdn.example.test/result.png' }] }))
      .mockResolvedValueOnce({ status: 200, body: 'PGh0bWw+', contentType: 'text/html' });
    await expect(editImage(input(), transport)).rejects.toMatchObject({ code: 'HTTP', status: 403 });
    await expect(editImage(input(), transport)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('取消已开始的请求后立即结束，即使底层网络忽略 signal', async () => {
    const controller = new AbortController();
    const transport = vi.fn<HttpTransport>().mockImplementation(() => new Promise(() => {}));
    const promise = editImage({ ...input(), signal: controller.signal }, transport);
    await Promise.resolve();
    expect(transport).toHaveBeenCalledOnce();
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('已取消的请求不连接服务', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn<HttpTransport>();
    await expect(editImage({ ...input(), signal: controller.signal }, transport)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('聊天模型、URL 内嵌密钥、缺失选区参考图均在上传前拒绝', async () => {
    const transport = vi.fn<HttpTransport>();
    const chatInput = input();
    chatInput.provider.model = 'gpt-4o';
    await expect(editImage(chatInput, transport)).rejects.toMatchObject({ code: 'CONFIG' });
    const urlInput = input();
    urlInput.provider.baseUrl += '?key=secret';
    await expect(editImage(urlInput, transport)).rejects.toMatchObject({ code: 'CONFIG' });
    await expect(editImage({ ...input('gemini'), maskBase64: PNG }, transport)).rejects.toMatchObject({ code: 'INPUT' });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('修图提示词', () => {
  it('保留身份、皮肤纹理，并让去物仅处理选区', () => {
    expect(buildRetouchPrompt('smooth', 35)).toContain('毛孔');
    expect(buildRetouchPrompt('blemish', 60)).toContain('保留正常毛孔、雀斑、痣');
    expect(buildRetouchPrompt('remove', 150, '去掉路人')).toContain('编辑力度：100/100');
    expect(buildRetouchPrompt('remove', 50)).toContain('严格保护选区外所有内容');
    expect(buildRetouchPrompt('smooth', Number.NaN)).toContain('40/100');
  });
});
