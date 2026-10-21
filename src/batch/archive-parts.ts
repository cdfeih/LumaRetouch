import { createImageArchive, imageArchiveEntryBytes } from './export';
import type { ArchiveImage } from './export';

export type ArchivePart = { index: number; imageCount: number; firstImage: number; bytes: Uint8Array<ArrayBuffer> };
function check(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('已取消批量导出。', 'AbortError'); }

/** Encode one bounded part at a time. The caller saves each yield before more photos are encoded. */
export async function* createArchiveParts<T>(
  items: readonly T[],
  encode: (item: T, index: number) => Promise<ArchiveImage>,
  options: { maxBytes: number; signal?: AbortSignal; onEncode?(index: number, total: number): void },
): AsyncGenerator<ArchivePart> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 100 || options.maxBytes >= 0xffffffff) throw new Error('分包大小无效。');
  if (!items.length) throw new Error('请先选择要导出的照片。');
  let files: ArchiveImage[] = [], size = 22, partIndex = 1, firstImage = 0;
  for (let index = 0; index < items.length; index++) {
    check(options.signal); options.onEncode?.(index, items.length);
    const encoded = await encode(items[index], index); check(options.signal);
    // A stable global sequence avoids collisions when multiple parts are extracted together.
    const file = { ...encoded, name: `${String(index + 1).padStart(4, '0')}_${encoded.name.replace(/\\/g, '/').split('/').at(-1) || '照片'}` };
    const entryBytes = imageArchiveEntryBytes(file);
    if (entryBytes + 22 > options.maxBytes) throw new Error(`第 ${index + 1} 张照片单独超过分包上限，请改用 JPEG 或单张导出。`);
    if (files.length && size + entryBytes > options.maxBytes) {
      const imageCount = files.length, bytes = await createImageArchive(files, options.signal);
      files = []; size = 22;
      yield { index: partIndex++, imageCount, firstImage, bytes };
      check(options.signal); firstImage = index;
    }
    files.push(file); size += entryBytes;
  }
  if (files.length) {
    check(options.signal);
    const imageCount = files.length, bytes = await createImageArchive(files, options.signal);
    files = [];
    yield { index: partIndex, imageCount, firstImage, bytes };
    check(options.signal);
  }
}
