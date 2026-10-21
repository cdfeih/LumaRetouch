import { describe, expect, it } from 'vitest';
import { createArchiveParts } from './archive-parts';
import { imageArchiveEntryBytes } from './export';
const image = (name: string, size = 100) => ({ name, base64: Buffer.alloc(size, 97).toString('base64'), mimeType: 'image/png' });
const names = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), found: string[] = [];
  for (let p = 0; view.getUint32(p, true) === 0x04034b50;) {
    const length = view.getUint16(p + 26, true); found.push(new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + length)));
    p += 30 + length + view.getUint16(p + 28, true) + view.getUint32(p + 18, true);
  }
  return found;
};
describe('bounded automatic image ZIP parts', () => {
  it('creates legal bounded parts with every photo exactly once and globally unique filenames', async () => {
    const source = [image('相片.png'), image('相片.png'), image('相片.png')];
    const maxBytes = 22 + imageArchiveEntryBytes({ ...source[0], name: '0001_相片.png' }) * 2;
    const parts = [];
    for await (const part of createArchiveParts(source, async item => item, { maxBytes })) parts.push(part);
    expect(parts.map(part => part.imageCount)).toEqual([2, 1]);
    expect(parts.every(part => part.bytes.length <= maxBytes)).toBe(true);
    expect(parts.flatMap(part => names(part.bytes))).toEqual(['0001_相片.png', '0002_相片.png', '0003_相片.png']);
    expect(parts.map(part => part.firstImage)).toEqual([0, 2]);
  });
  it('waits for the consumer before encoding another group and releases the old encoded array', async () => {
    const encoded: number[] = [];
    const iterator = createArchiveParts([0,1,2,3], async index => { encoded.push(index); return image(`${index}.png`); }, { maxBytes: 230 });
    expect((await iterator.next()).value?.imageCount).toBe(1);
    expect(encoded).toEqual([0,1]); // One lookahead is needed to determine a boundary.
    await iterator.return(undefined);
    expect(encoded).toEqual([0,1]);
  });
  it('rejects a single oversized image without returning a truncated part', async () => {
    const iterator = createArchiveParts([image('large.png', 400)], async item => item, { maxBytes: 300 });
    await expect(iterator.next()).rejects.toThrow('单独超过');
  });
  it('stops after a saved part when cancelled and never accepts late encoded photos', async () => {
    const controller = new AbortController();
    const iterator = createArchiveParts([0,1,2], async index => image(`${index}.png`), { maxBytes: 230, signal: controller.signal });
    await iterator.next(); controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
