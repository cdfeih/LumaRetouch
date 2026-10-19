const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, unlink, rmdir } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareExport, saveExport } = require('./save.cjs');

// A standard Python zipfile ZIP_STORED fixture containing one valid PNG.
const zip = Buffer.from('UEsDBBQAAAgAAI+tU112txdURAAAAEQAAAAKAAAA54Wn54mHLnBuZ4lQTkcNChoKAAAADUlIRFIAAAABAAAAAQgGAAAAHxXEiQAAAAtJREFUeNpj/P8fAAMDAgDvmh59AAAAAElFTkSuQmCCUEsBAhQAFAAACAAAj61TXXa3F1REAAAARAAAAAoAAAAAAAAAAAAAAIABAAAAAOeFp+eJhy5wbmdQSwUGAAAAAAEAAQA4AAAAbAAAAAAA', 'base64');
const input = () => ({ base64: zip.toString('base64'), mimeType: 'application/zip', suggestedName: '照片合集.zip' });
let directory, savedPath;
before(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'luma-save-test-')); savedPath = path.join(directory, '照片合集.zip'); });
after(async () => { if (savedPath) await unlink(savedPath).catch(() => {}); if (directory) await rmdir(directory); });

test('ZIP 保存使用独立合法容器，保留字节并仅开放 zip 文件类型', async () => {
  let options;
  const result = await saveExport({}, input(), { dialog: { showSaveDialog: async (_window, value) => { options = value; return { canceled: false, filePath: savedPath }; } }, writeFile });
  assert.deepEqual(result, { saved: true, message: '照片压缩包已保存' });
  assert.equal(options.defaultPath, '照片合集.zip');
  assert.deepEqual(options.filters, [{ name: '照片 ZIP 压缩包', extensions: ['zip'] }]);
  assert.deepEqual(await readFile(savedPath), zip);
});
test('取消 ZIP 保存不调用写文件，不误报成功', async () => {
  let writes = 0;
  for (const selection of [{ canceled: true }, { canceled: false, filePath: undefined }]) {
    const result = await saveExport({}, input(), { dialog: { showSaveDialog: async () => selection }, writeFile: async () => writes++ });
    assert.deepEqual(result, { saved: false, message: '已取消导出' });
  }
  assert.equal(writes, 0);
});
test('手工输入其他扩展名仍只写 zip；写盘失败明确报错', async () => {
  let target;
  await saveExport({}, input(), { dialog: { showSaveDialog: async () => ({ canceled: false, filePath: 'typed.exe' }) }, writeFile: async value => { target = value; } });
  assert.equal(target, 'typed.exe.zip');
  await assert.rejects(saveExport({}, input(), { dialog: { showSaveDialog: async () => ({ canceled: false, filePath: 'photo.zip' }) }, writeFile: async () => { throw new Error('disk failure'); } }), /压缩包保存失败/);
});
test('只接受三种图片及 application/zip，拒绝任意 MIME 和伪造 PK 内容', async () => {
  for (const mimeType of ['application/octet-stream','application/x-msdownload','application/x-zip-compressed','text/plain']) await assert.rejects(prepareExport({ ...input(), mimeType }), /只支持/);
  await assert.rejects(prepareExport({ ...input(), base64: Buffer.from('PK fake archive').toString('base64') }), /压缩包/);
  await assert.rejects(prepareExport({ ...input(), base64: zip.subarray(0, zip.length - 4).toString('base64') }), /压缩包/);
  await assert.rejects(prepareExport({ ...input(), base64: undefined }), /数据无效/);
});
test('ZIP 结构与图片文件名必须匹配，禁止目录穿越和非图片容器', async () => {
  for (const name of ['../bad.png','evil!!.exe']) {
    const altered = Buffer.from(zip), originalName = Buffer.from('照片.png');
    for (let start = 0; (start = altered.indexOf(originalName, start)) !== -1; start += originalName.length) altered.set(Buffer.from(name), start);
    await assert.rejects(prepareExport({ ...input(), base64: altered.toString('base64') }), /结构无效/);
  }
  const mismatched = Buffer.from(zip); mismatched[14] ^= 1;
  await assert.rejects(prepareExport({ ...input(), base64: mismatched.toString('base64') }), /结构无效/);
});
test('64 MiB 上限在 Base64 解码前生效', async () => {
  await assert.rejects(prepareExport({ ...input(), base64: 'A'.repeat(Math.ceil(64 * 1024 * 1024 / 3) * 4 + 4) }), /64 MiB/);
});
test('原 PNG、JPEG、WebP 签名验证和图片保存返回保持可用', async () => {
  const fixtures = [{ mimeType: 'image/png', bytes: Buffer.from([137,80,78,71,13,10,26,10]), extension: 'png' }, { mimeType: 'image/jpeg', bytes: Buffer.from([255,216,255,217]), extension: 'jpg' }, { mimeType: 'image/webp', bytes: Buffer.from('RIFF0000WEBP'), extension: 'webp' }];
  for (const fixture of fixtures) {
    const prepared = await prepareExport({ base64: fixture.bytes.toString('base64'), mimeType: fixture.mimeType, suggestedName: '原照片' });
    assert.equal(prepared.extension, fixture.extension); assert.equal(prepared.archive, false);
    const result = await saveExport({}, { base64: fixture.bytes.toString('base64'), mimeType: fixture.mimeType }, { dialog: { showSaveDialog: async () => ({ canceled: false, filePath: 'existing-image-path' }) }, writeFile: async (filePath, bytes) => { assert.equal(filePath, 'existing-image-path'); assert.deepEqual(bytes, fixture.bytes); } });
    assert.deepEqual(result, { saved: true, message: '照片已保存' });
  }
  await assert.rejects(prepareExport({ ...input(), mimeType: 'image/png' }), /图片内容/);
});
