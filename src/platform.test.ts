import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createImageArchive } from './batch/export';

const native = vi.hoisted(() => ({ isNativePlatform: vi.fn(), writeFile: vi.fn(), share: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: native.isNativePlatform }, registerPlugin: () => ({}) }));
vi.mock('@capacitor/filesystem', () => ({ Filesystem: { writeFile: native.writeFile }, Directory: { Cache: 'CACHE' } }));
vi.mock('@capacitor/share', () => ({ Share: { share: native.share } }));

describe('archive platform save', () => {
  let platform: typeof import('./platform');
  let bytes: Uint8Array<ArrayBuffer>;
  let created: Mock<(value: Blob | MediaSource) => string>, click: Mock<() => void>;
  let link: { href: string; download: string; click: () => void };
  beforeAll(async () => {
    vi.stubGlobal('window', {});
    platform = await import('./platform');
    bytes = await createImageArchive([{ name: '照片.png', base64: 'AAECAw==', mimeType: 'image/png' }]);
  });
  beforeEach(() => {
    native.isNativePlatform.mockReset().mockReturnValue(false);
    native.writeFile.mockReset().mockResolvedValue({ uri: 'content://cache/photos.zip' });
    native.share.mockReset().mockResolvedValue({ activityType: 'save-provider' });
    click = vi.fn<() => void>(); link = { href: '', download: '', click };
    created = vi.fn<(value: Blob | MediaSource) => string>().mockReturnValue('blob:archive');
    vi.stubGlobal('window', { setTimeout: vi.fn() });
    vi.stubGlobal('document', { createElement: vi.fn().mockReturnValue(link) });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(created);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('downloads the real ZIP bytes with a zip extension and application/zip MIME', async () => {
    expect(await platform.exportArchive(bytes, '照片合集.zip')).toEqual({ saved: true, message: '已开始下载照片压缩包' });
    const blob = created.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/zip');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(link.download).toBe('照片合集.zip'); expect(link.href).toBe('blob:archive'); expect(click).toHaveBeenCalledTimes(1);
    expect(window.setTimeout).toHaveBeenCalledWith(expect.any(Function), 30000);
  });
  it('uses the existing desktop bridge and faithfully returns native cancellation', async () => {
    const exportImage = vi.fn().mockResolvedValue({ saved: false, message: '已取消导出' });
    window.lumaNative = { exportImage, request: vi.fn(), cancel: vi.fn() };
    expect(await platform.exportArchive(bytes, '结果')).toEqual({ saved: false, message: '已取消导出' });
    expect(exportImage).toHaveBeenCalledWith({ base64: Buffer.from(bytes).toString('base64'), mimeType: 'application/zip', suggestedName: '结果.zip' });
    expect(created).not.toHaveBeenCalled(); expect(native.writeFile).not.toHaveBeenCalled();
  });
  it('converts large archives in bounded Base64 chunks without stack-sized spreading', async () => {
    const big = await createImageArchive([{ name: 'large.png', base64: Buffer.alloc(200000, 173).toString('base64'), mimeType: 'image/png' }]);
    const exportImage = vi.fn().mockResolvedValue({ saved: true, message: 'saved' });
    window.lumaNative = { exportImage, request: vi.fn(), cancel: vi.fn() };
    await platform.exportArchive(big, 'large.zip');
    expect(Buffer.from(exportImage.mock.calls[0][0].base64, 'base64')).toEqual(Buffer.from(big));
  });
  it('writes a ZIP into Android cache and hands the URI to the system share UI', async () => {
    native.isNativePlatform.mockReturnValue(true);
    expect(await platform.exportArchive(bytes, '手机照片')).toMatchObject({ saved: true });
    expect(native.writeFile).toHaveBeenCalledWith({ path: expect.stringMatching(/^exports\/\d+-手机照片\.zip$/), data: Buffer.from(bytes).toString('base64'), directory: 'CACHE', recursive: true });
    expect(native.share).toHaveBeenCalledWith({ title: '导出照片压缩包', files: ['content://cache/photos.zip'], dialogTitle: '保存或分享照片压缩包' });
    expect(created).not.toHaveBeenCalled();
  });
  it('does not report Android sharing cancellations or storage/share failures as success', async () => {
    native.isNativePlatform.mockReturnValue(true);
    native.share.mockRejectedValueOnce(new Error('Share canceled'));
    expect(await platform.exportArchive(bytes, '合集')).toMatchObject({ saved: false, message: expect.stringContaining('已取消') });
    native.writeFile.mockRejectedValueOnce(new Error('storage full'));
    await expect(platform.exportArchive(bytes, '合集')).rejects.toThrow('写入手机缓存失败');
    native.share.mockRejectedValueOnce(new Error('permission failure'));
    await expect(platform.exportArchive(bytes, '合集')).rejects.toThrow('分享失败');
  });
  it('rejects non-ZIP bytes, malformed PK bytes and over-64MiB input before any save UI', async () => {
    const exportImage = vi.fn();
    window.lumaNative = { exportImage, request: vi.fn(), cancel: vi.fn() };
    for (const invalid of [new Uint8Array([1,2,3]), Uint8Array.from([80,75,3,4,...new Uint8Array(30)]), new Uint8Array(platform.MAX_ARCHIVE_BYTES + 1)]) await expect(platform.exportArchive(invalid, 'invalid')).rejects.toThrow(/压缩包/);
    expect(exportImage).not.toHaveBeenCalled(); expect(native.writeFile).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled();
  });
});
