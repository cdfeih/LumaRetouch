import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createImageArchive } from './export';

const image = (name: string, bytes: Uint8Array = Uint8Array.from([0,1,2,255,128,10])) => ({ name, base64: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' });
const unpackScript = [
  'import sys, io, zipfile, json, base64',
  'with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:',
  ' print(json.dumps({"badCRC": z.testzip(), "files": [{"name": i.filename, "flags": i.flag_bits, "method": i.compress_type, "crc": i.CRC, "size": i.file_size, "data": base64.b64encode(z.read(i)).decode()} for i in z.infolist()]}, ensure_ascii=False))',
].join('\n');
function unpack(bytes: Uint8Array): { badCRC: string | null; files: Array<{ name: string; flags: number; method: number; crc: number; size: number; data: string }> } {
  const candidates = process.platform === 'win32' ? [{ executable: 'py', prefix: ['-3.14'] }, { executable: 'python', prefix: [] }] : [{ executable: 'python3', prefix: [] }, { executable: 'python', prefix: [] }];
  const python = candidates.find(candidate => spawnSync(candidate.executable, [...candidate.prefix,'--version'], { windowsHide: true }).status === 0);
  if (!python) throw new Error('ZIP 验收需要独立 Python 标准库 zipfile，请安装 Python 后重试。');
  return JSON.parse(execFileSync(python.executable, [...python.prefix,'-c',unpackScript], { input: Buffer.from(bytes), encoding: 'utf8', windowsHide: true }));
}

describe('image ZIP archive', () => {
  it('is independently readable with correct UTF-8 names, stored bytes, sizes, and CRC32', async () => {
    const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const files = [image('照片一.png', allBytes), { name: '猫咪🙂.jpg', base64: '/9j/AAEC', mimeType: 'image/jpeg' }];
    const archive = await createImageArchive(files), decoded = unpack(archive);
    expect(decoded.badCRC).toBeNull();
    expect(decoded.files.map(file => file.name)).toEqual(['照片一.png','猫咪🙂.jpg']);
    expect(decoded.files.map(file => file.data)).toEqual(files.map(file => file.base64));
    expect(decoded.files[0].size).toBe(256);
    expect(decoded.files.every(file => file.flags & 0x0800 && file.method === 0)).toBe(true);
  });
  it('cleans traversal, Windows paths and reserved names and keeps all duplicate files', async () => {
    const files = [image('../../照片.png'), image('C:\\folder\\照片.png'), image('照片 (2).png'), image('PRN.jpg'), image('../..'), image('unsafe<name>.png')];
    const decoded = unpack(await createImageArchive(files));
    expect(decoded.files.map(file => file.name)).toEqual(['照片.png','照片 (2).png','照片 (2) (2).png','_PRN.png','照片_5.png','unsafe_name_.png']);
    expect(decoded.files.every(file => !file.name.includes('/') && !file.name.includes('\\') && file.name !== '..')).toBe(true);
    expect(decoded.badCRC).toBeNull();
  });
  it('deduplicates case-insensitive and Unicode-normalized names and fixes file extensions', async () => {
    const decoded = unpack(await createImageArchive([image('A.jpeg'),image('a.png'),image('e\u0301.png'),image('é.png')]));
    expect(decoded.files.map(file => file.name)).toEqual(['A.png','a (2).png','é.png','é (2).png']);
  });
  it('accepts data URLs, whitespace and unpadded standard Base64 without changing bytes', async () => {
    const decoded = unpack(await createImageArchive([{ name: 'test.png', base64: 'data:image/png;base64, AQI\n=', mimeType: 'image/png' }, { name: 'next.webp', base64: 'AwQ', mimeType: 'image/webp' }]));
    expect(decoded.files.map(file => file.data)).toEqual(['AQI=','AwQ=']);
    expect(decoded.files.map(file => file.size)).toEqual([2,2]);
  });
  it('rejects unsupported types, damaged Base64 and mismatched data URL metadata', async () => {
    await expect(createImageArchive([{ ...image('x.png'), mimeType: 'application/zip' }])).rejects.toThrow('只支持');
    for (const base64 of ['', 'abcde', 'AA===', '@@==', 'A=AA', 'AAA==']) await expect(createImageArchive([{ ...image('x.png'), base64 }])).rejects.toThrow('Base64');
    await expect(createImageArchive([{ ...image('x.png'), base64: 'data:image/jpeg;base64,AA==' }])).rejects.toThrow('格式不一致');
  });
  it('validates empty archives, ZIP32 entry count, and encoded filename length before allocation', async () => {
    await expect(createImageArchive([])).rejects.toThrow('先选择');
    await expect(createImageArchive(Array.from({ length: 65535 }, () => image('a.png')))).rejects.toThrow('数量超过');
    await expect(createImageArchive([image('中'.repeat(22000) + '.png')])).rejects.toThrow('文件名过长');
  });
  it('cancels before work or between chunks without returning an incomplete archive', async () => {
    const early = new AbortController(); early.abort();
    await expect(createImageArchive([image('a.png')], early.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const controller = new AbortController();
    const cancel = setTimeout(() => controller.abort(), 0);
    try { await expect(createImageArchive([image('big.png', new Uint8Array(2 * 1024 * 1024)),image('next.png')], controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); }
    finally { clearTimeout(cancel); }
  });
  it('produces deterministic legal headers for the same inputs', async () => {
    const one = await createImageArchive([image('a.png')]), two = await createImageArchive([image('a.png')]);
    expect(one).toEqual(two);
    expect(new DataView(one.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(new DataView(one.buffer).getUint32(one.length - 22, true)).toBe(0x06054b50);
  });
});
