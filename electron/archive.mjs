export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** Validate the canonical image-only, UTF-8/store ZIP produced by this app. */
export function validateImageArchive(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) throw new Error('照片压缩包数据无效，请重新生成后导出。');
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('照片压缩包超过 64 MiB 限制，请减少照片数量后导出。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = () => { throw new Error('照片压缩包结构无效或包含非图片文件，请重新生成后导出。'); };
  if (view.getUint32(0, true) !== 0x04034b50) fail();
  const end = bytes.byteLength - 22;
  if (view.getUint32(end, true) !== 0x06054b50 || view.getUint16(end + 20, true) !== 0) fail();
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), directoryOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || !count || count === 0xffff || view.getUint16(end + 8, true) !== count || directoryOffset + directorySize !== end) fail();
  let position = directoryOffset, expectedLocalOffset = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true }), names = new Set();
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) fail();
    const flags = view.getUint16(position + 8, true), method = view.getUint16(position + 10, true);
    const size = view.getUint32(position + 20, true), uncompressed = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true), extraLength = view.getUint16(position + 30, true), commentLength = view.getUint16(position + 32, true);
    const localOffset = view.getUint32(position + 42, true), next = position + 46 + nameLength + extraLength + commentLength;
    if (flags !== 0x0800 || method !== 0 || !size || size !== uncompressed || next > end || localOffset !== expectedLocalOffset || localOffset + 30 > directoryOffset || view.getUint16(position + 34, true) !== 0) fail();
    let name;
    try { name = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength)); }
    catch { fail(); }
    if (!name || name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || !/\.(?:png|jpe?g|webp)$/i.test(name) || names.has(name.toLowerCase())) fail();
    names.add(name.toLowerCase());
    if (view.getUint32(localOffset, true) !== 0x04034b50 || view.getUint16(localOffset + 6, true) !== flags || view.getUint16(localOffset + 8, true) !== method || view.getUint32(localOffset + 14, true) !== view.getUint32(position + 16, true) || view.getUint32(localOffset + 18, true) !== size || view.getUint32(localOffset + 22, true) !== size) fail();
    const localNameLength = view.getUint16(localOffset + 26, true), localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (localNameLength !== nameLength || dataOffset + size > directoryOffset) fail();
    for (let byte = 0; byte < nameLength; byte++) if (bytes[localOffset + 30 + byte] !== bytes[position + 46 + byte]) fail();
    expectedLocalOffset = dataOffset + size;
    position = next;
  }
  if (position !== end || expectedLocalOffset !== directoryOffset) fail();
}
