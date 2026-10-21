export type ArchiveImage = { name: string; base64: string; mimeType: string };

const ZIP32_MAX = 0xffffffff;
const UTF8 = 0x0800;
const encoder = new TextEncoder();
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已取消批量导出。', 'AbortError');
}

function imageContent(file: ArchiveImage): { encoded: string; size: number; extension: string } {
  const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as Record<string, string>)[file.mimeType];
  if (!extension) throw new Error('批量导出只支持 JPEG、PNG 和 WebP 图片。');
  const prefix = /^data:([^;,]+);base64,/i.exec(file.base64);
  if (prefix && prefix[1].toLowerCase() !== file.mimeType) throw new Error('图片内容与声明格式不一致，请重新导出。');
  const encoded = (prefix ? file.base64.slice(prefix[0].length) : file.base64).replace(/\s/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1 || (encoded.includes('=') && encoded.length % 4 !== 0)) throw new Error('图片 Base64 数据无效，无法生成压缩包。');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const size = Math.floor(encoded.length * 3 / 4) - padding;
  if (size <= 0 || size >= ZIP32_MAX) throw new Error('单张图片超过 ZIP 支持的大小，请缩小后导出。');
  return { encoded, size, extension };
}

function safeName(name: string, extension: string, index: number, used: Set<string>): string {
  let leaf = name.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || '';
  leaf = leaf.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/g, '').trim();
  let stem = leaf.replace(/\.[^.]*$/, '').replace(/[. ]+$/g, '') || `照片_${index + 1}`;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
  let candidate = `${stem}.${extension}`, duplicate = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${stem} (${duplicate++}).${extension}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Exact single-entry size, including its UTF-8 filename and both ZIP headers. */
export function imageArchiveEntryBytes(file: ArchiveImage): number {
  const content = imageContent(file);
  const name = encoder.encode(safeName(file.name, content.extension, 0, new Set()));
  if (name.length > 0xffff) throw new Error('照片文件名过长，请缩短后导出。');
  return content.size + name.length * 2 + 76;
}

/** A standard UTF-8 ZIP with stored entries; no external package or compression worker. */
export async function createImageArchive(files: readonly ArchiveImage[], signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  checkAbort(signal);
  if (!files.length) throw new Error('请先选择要导出的照片。');
  // 0xffff is the ZIP64 sentinel, which this small ZIP32 writer does not emit.
  if (files.length >= 0xffff) throw new Error('照片数量超过 ZIP32 上限，请分批导出。');
  const used = new Set<string>();
  const entries = files.map((file, index) => {
    checkAbort(signal);
    const content = imageContent(file);
    const name = encoder.encode(safeName(file.name, content.extension, index, used));
    if (name.length > 0xffff) throw new Error('照片文件名过长，请缩短后导出。');
    return { ...content, name, offset: 0, crc: 0 };
  });
  const length = entries.reduce((total, entry) => total + entry.size + entry.name.length * 2 + 76, 22);
  if (!Number.isSafeInteger(length) || length >= ZIP32_MAX) throw new Error('压缩包超过 ZIP32 上限，请减少照片数量后导出。');
  let output: Uint8Array<ArrayBuffer>;
  try { output = new Uint8Array(length); }
  catch { throw new Error('设备可用内存不足，请减少照片数量后分批导出。'); }
  const view = new DataView(output.buffer);
  let position = 0, bytesSinceYield = 0;
  for (const entry of entries) {
    checkAbort(signal);
    entry.offset = position;
    view.setUint32(position, 0x04034b50, true);
    view.setUint16(position + 4, 20, true);
    view.setUint16(position + 6, UTF8, true);
    view.setUint16(position + 12, 0x21, true); // 1980-01-01; deterministic and valid DOS date.
    view.setUint32(position + 18, entry.size, true);
    view.setUint32(position + 22, entry.size, true);
    view.setUint16(position + 26, entry.name.length, true);
    output.set(entry.name, position + 30);
    position += 30 + entry.name.length;
    let crc = ZIP32_MAX;
    for (let start = 0; start < entry.encoded.length; start += 65536) {
      checkAbort(signal);
      let binary: string;
      try { binary = atob(entry.encoded.slice(start, start + 65536)); }
      catch { throw new Error('图片 Base64 数据损坏，无法生成压缩包。'); }
      for (let index = 0; index < binary.length; index++) {
        const byte = binary.charCodeAt(index);
        output[position++] = byte;
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      }
      bytesSinceYield += binary.length;
      if (bytesSinceYield >= 1024 * 1024) {
        bytesSinceYield = 0;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    entry.crc = (crc ^ ZIP32_MAX) >>> 0;
    view.setUint32(entry.offset + 14, entry.crc, true);
    // Yield between images, so even a set of small entries can be cancelled.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  checkAbort(signal);
  const directoryOffset = position;
  for (const entry of entries) {
    view.setUint32(position, 0x02014b50, true);
    view.setUint16(position + 4, 20, true);
    view.setUint16(position + 6, 20, true);
    view.setUint16(position + 8, UTF8, true);
    view.setUint16(position + 14, 0x21, true);
    view.setUint32(position + 16, entry.crc, true);
    view.setUint32(position + 20, entry.size, true);
    view.setUint32(position + 24, entry.size, true);
    view.setUint16(position + 28, entry.name.length, true);
    view.setUint32(position + 42, entry.offset, true);
    output.set(entry.name, position + 46);
    position += 46 + entry.name.length;
  }
  const directorySize = position - directoryOffset;
  view.setUint32(position, 0x06054b50, true);
  view.setUint16(position + 8, entries.length, true);
  view.setUint16(position + 10, entries.length, true);
  view.setUint32(position + 12, directorySize, true);
  view.setUint32(position + 16, directoryOffset, true);
  return output;
}
