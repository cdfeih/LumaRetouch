const path = require('node:path');
const { decodeBase64 } = require('./http.cjs');

const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/zip': 'zip' };

async function prepareExport(input) {
  const extension = extensions[input?.mimeType];
  if (!extension) throw new Error('只支持导出 PNG、JPEG、WebP 或照片 ZIP 压缩包');
  if (typeof input.base64 !== 'string') throw new Error('导出数据无效');
  // Reject over-limit encoded input before allocating its decoded Buffer.
  const raw = input.base64.replace(/^data:[^;,]+;base64,/, '');
  if (raw.length > Math.ceil(MAX_EXPORT_BYTES / 3) * 4) throw new Error('导出文件超过 64 MiB 限制');
  const bytes = decodeBase64(raw);
  if (bytes.length > MAX_EXPORT_BYTES) throw new Error('导出文件超过 64 MiB 限制');
  const archive = extension === 'zip';
  if (archive) {
    const { validateImageArchive } = await import('./archive.mjs');
    validateImageArchive(bytes);
  } else {
    const valid = extension === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
      extension === 'jpg' ? bytes[0] === 255 && bytes[1] === 216 : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) throw new Error('图片内容与导出格式不一致');
  }
  const fallback = archive ? '光修照片合集' : '光修作品';
  const safeName = String(input.suggestedName || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120).replace(/\.(png|jpe?g|webp|zip)$/i, '').replace(/[. ]+$/g, '') || fallback;
  return { bytes, extension, archive, safeName };
}

async function saveExport(mainWindow, input, { dialog, writeFile }) {
  const prepared = await prepareExport(input);
  const { bytes, extension, archive, safeName } = prepared;
  const selection = await dialog.showSaveDialog(mainWindow, {
    title: archive ? '导出照片压缩包' : '导出精修照片', defaultPath: `${safeName}.${extension}`,
    filters: [{ name: archive ? '照片 ZIP 压缩包' : '照片', extensions: [extension] }],
  });
  if (selection.canceled || !selection.filePath) return { saved: false, message: '已取消导出' };
  // The archive IPC cannot become an arbitrary-extension file writer even when
  // a name is typed manually into the native dialog.
  const target = archive && path.extname(selection.filePath).toLowerCase() !== '.zip' ? `${selection.filePath}.zip` : selection.filePath;
  try { await writeFile(target, bytes); }
  catch { throw new Error(`${archive ? '压缩包' : '图片'}保存失败，请检查保存位置是否可写`); }
  return { saved: true, message: archive ? '照片压缩包已保存' : '照片已保存' };
}

module.exports = { prepareExport, saveExport };
