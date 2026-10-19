import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDERS, editImage } from './index';
import type { EditImageInput, HttpTransport, ProviderConfig } from './types';

const ORIGINAL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8j0AAAAASUVORK5CYII=';
const REFERENCE = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2Q==';
const GUIDE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const input = (kind: ProviderConfig['kind']): EditImageInput => ({
  provider: { kind, ...DEFAULT_PROVIDERS[kind], apiKey: 'qa-key', ...(kind === 'compatible' ? { baseUrl: 'https://qa.example/v1', model: 'qa-image-editor' } : {}) },
  imageBase64: ORIGINAL, mimeType: 'image/png', prompt: '只编辑原图，将参考图色调用于涂抹选区。',
  referenceImage: { base64: REFERENCE, mimeType: 'image/jpeg' }, maskBase64: GUIDE, maskGuideBase64: GUIDE,
});
const standardResponse = () => ({ status: 200, body: JSON.stringify({ data: [{ b64_json: ORIGINAL }] }) });

describe('参考图和选区角色合同', () => {
  it.each(['openai', 'compatible'] as const)('%s: 原图与风格参考以 image[] 上传，透明 mask 只作用第一张', async kind => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(standardResponse());
    await editImage(input(kind), transport);
    const multipart = transport.mock.calls[0][0].multipart;
    expect(multipart?.files).toEqual([
      { field: 'image[]', name: 'photo.png', mimeType: 'image/png', base64: ORIGINAL },
      { field: 'image[]', name: 'reference.jpg', mimeType: 'image/jpeg', base64: REFERENCE },
      { field: 'mask', name: 'mask.png', mimeType: 'image/png', base64: GUIDE },
    ]);
    expect(multipart?.fields.prompt).toContain('第 2 张图仅为风格/色调参考');
    expect(multipart?.fields.prompt).toContain('mask 中透明的区域');
    expect(multipart?.fields.prompt).not.toContain('第 2 张图仅是同尺寸选区参考图');
    await editImage({ ...input(kind), referenceImage: undefined }, transport);
    expect(transport.mock.calls[1][0].multipart?.files[0].field).toBe('image');
  });

  it('Gemini: 三张 inlineData 顺序固定，遮罩角色编号从第二张动态变第三张', async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue({ status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: ORIGINAL, mimeType: 'image/png' } }] } }] }) });
    await editImage(input('gemini'), transport);
    const body = JSON.parse(transport.mock.calls[0][0].body!);
    const parts = body.contents[0].parts;
    expect(parts.filter((part: Record<string, unknown>) => part.inlineData).map((part: { inlineData: unknown }) => part.inlineData)).toEqual([
      { mimeType: 'image/png', data: ORIGINAL }, { mimeType: 'image/jpeg', data: REFERENCE }, { mimeType: 'image/png', data: GUIDE },
    ]);
    const prompt = parts.map((part: { text?: string }) => part.text || '').join('\n');
    expect(prompt).toContain('第 2 张图仅为风格/色调参考');
    expect(prompt).toContain('第 3 张图仅是同尺寸选区参考图');
    expect(prompt).not.toContain('第 2 张图仅是同尺寸选区参考图');
    await editImage({ ...input('gemini'), referenceImage: undefined }, transport);
    expect(JSON.parse(transport.mock.calls[1][0].body!).contents[0].parts[2].text).toContain('第 2 张图仅是同尺寸选区参考图');
  });

  it('方舟: image 数组为原图、参考图、选区，追色参考不会被误当遮罩', async () => {
    const transport = vi.fn<HttpTransport>().mockResolvedValue(standardResponse());
    await editImage(input('ark'), transport);
    const body = JSON.parse(transport.mock.calls[0][0].body!);
    expect(body.image).toEqual([`data:image/png;base64,${ORIGINAL}`, `data:image/jpeg;base64,${REFERENCE}`, `data:image/png;base64,${GUIDE}`]);
    expect(body.prompt).toContain('第 2 张图仅为风格/色调参考');
    expect(body.prompt).toContain('第 3 张图仅是同尺寸选区参考图');
    expect(body.prompt).not.toContain('第 2 张图仅是同尺寸选区参考图');
    await editImage({ ...input('ark'), referenceImage: undefined }, transport);
    expect(JSON.parse(transport.mock.calls[1][0].body!).prompt).toContain('第 2 张图仅是同尺寸选区参考图');
  });

  it.each(['openai', 'compatible', 'gemini', 'ark'] as const)('%s: 无选区的追色只提交原图和风格参考，结果正常返回', async kind => {
    const response = kind === 'gemini'
      ? { status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: ORIGINAL } }] } }] }) }
      : standardResponse();
    const transport = vi.fn<HttpTransport>().mockResolvedValue(response);
    await expect(editImage({ ...input(kind), maskBase64: undefined, maskGuideBase64: undefined }, transport)).resolves.toMatchObject({ imageBase64: ORIGINAL });
    const request = transport.mock.calls[0][0];
    if (request.multipart) expect(request.multipart.files.map(file => file.field)).toEqual(['image[]', 'image[]']);
    else if (kind === 'gemini') expect(JSON.parse(request.body!).contents[0].parts.filter((part: Record<string, unknown>) => part.inlineData)).toHaveLength(2);
    else expect(JSON.parse(request.body!).image).toHaveLength(2);
  });

  it('错误参考图格式与无效 Base64 在上传前拒绝', async () => {
    const transport = vi.fn<HttpTransport>();
    await expect(editImage({ ...input('openai'), referenceImage: { mimeType: 'text/html', base64: REFERENCE } }, transport)).rejects.toMatchObject({ code: 'INPUT' });
    await expect(editImage({ ...input('gemini'), referenceImage: { mimeType: 'image/jpeg', base64: '!!not-a-photo!!' } }, transport)).rejects.toMatchObject({ code: 'INPUT' });
    expect(transport).not.toHaveBeenCalled();
  });
});
