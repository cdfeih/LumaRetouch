const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { nativeRequest, validateUrl } = require('./http.cjs');

let server;
let base;
before(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url === '/slow') { setTimeout(() => res.end('done'), 2000); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/image' }).end(); return; }
    if (req.url.startsWith('/cross/')) { res.writeHead(302, { location: `http://127.0.0.1:${req.url.split('/')[2]}/target` }).end(); return; }
    if (req.url === '/image') { res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.from([137, 80, 78, 71])); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });

test('URL只接受HTTPS及回环HTTP，拒绝嵌入凭证', () => {
  for (const value of ['file:///etc/passwd', 'http://example.org', 'https://secret@example.org']) assert.throws(() => validateUrl(value));
  assert.equal(validateUrl('https://example.org/v1').hostname, 'example.org');
  assert.equal(validateUrl(`${base}/v1`).protocol, 'http:');
});
test('multipart真实传输字段和图片二进制，不保留错误的Content-Type', async () => {
  const response = await nativeRequest({ url: base, method: 'POST', headers: { 'Content-Type': 'application/json' }, multipart: { fields: { prompt: '祛痘' }, files: [{ field: 'image', name: 'source.png', mimeType: 'image/png', base64: Buffer.from('photo-bytes').toString('base64') }] } });
  const payload = JSON.parse(response.body);
  assert.match(payload.contentType, /multipart\/form-data; boundary=/);
  assert.match(payload.body, /name="prompt"\r\n\r\n祛痘/);
  assert.match(payload.body, /filename="source.png"/);
  assert.match(payload.body, /photo-bytes/);
});
test('下载支持安全GET重定向和base64结果', async () => {
  const response = await nativeRequest({ url: `${base}/redirect`, method: 'GET', responseType: 'base64' });
  assert.equal(response.body, 'iVBORw==');
  assert.equal(response.contentType, 'image/png');
});
test('拒绝POST重定向，避免重新发送图片和密钥', async () => {
  await assert.rejects(nativeRequest({ url: `${base}/redirect`, method: 'POST', body: '{}' }), /重定向/);
});
test('跨源GET重定向移除所有自定义密钥头', async () => {
  const receiver = http.createServer((req, res) => res.end(JSON.stringify(req.headers)));
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  try {
    const result = await nativeRequest({ url: `${base}/cross/${receiver.address().port}`, method: 'GET', headers: { Authorization: 'Bearer secret', 'x-goog-api-key': 'google-secret', 'api-key': 'other-secret' } });
    const headers = JSON.parse(result.body);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers['x-goog-api-key'], undefined);
    assert.equal(headers['api-key'], undefined);
  } finally { receiver.closeAllConnections(); await new Promise((resolve) => receiver.close(resolve)); }
});
test('取消会终止进行中的HTTP请求', async () => {
  const controller = new AbortController();
  const response = nativeRequest({ url: `${base}/slow`, method: 'GET' }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(response, /已取消/);
});
test('拒绝原始Cookie和头部注入', async () => {
  await assert.rejects(nativeRequest({ url: base, method: 'GET', headers: { Cookie: 'session=x' } }), /不允许/);
  await assert.rejects(nativeRequest({ url: base, method: 'GET', headers: { Authorization: 'secret\r\ninjected: 1' } }), /格式无效/);
});
