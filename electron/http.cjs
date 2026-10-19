const MAX_REQUEST = 96 * 1024 * 1024;
const MAX_RESPONSE = 128 * 1024 * 1024;
const TIMEOUT_MS = 240000;

function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('服务地址无效'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password) {
    throw new Error('服务地址须使用 HTTPS，本机服务可使用 HTTP；地址不能包含账号密码');
  }
  return url;
}

function validateHeaders(input = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('请求头格式无效');
    if (['host', 'connection', 'cookie', 'content-length', 'proxy-authorization'].includes(name.toLowerCase())) throw new Error('不允许的请求头');
    headers.set(name, value);
  }
  return headers;
}

function decodeBase64(input) {
  const raw = String(input).replace(/^data:[^;,]+;base64,/, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 === 1 || raw.length > MAX_REQUEST * 1.4) throw new Error('图片数据无效或过大');
  return Buffer.from(raw, 'base64');
}

async function nativeRequest(req, outerSignal) {
  const url = validateUrl(req.url);
  if (!['GET', 'POST'].includes(req.method)) throw new Error('请求方法不受支持');
  const headers = validateHeaders(req.headers);
  let body;
  if (req.multipart) {
    if (req.method !== 'POST') throw new Error('图片上传必须使用 POST');
    const form = new FormData();
    let size = 0;
    for (const [field, value] of Object.entries(req.multipart.fields || {})) {
      if (typeof value !== 'string') throw new Error('表单格式无效');
      size += Buffer.byteLength(value);
      form.append(field, value);
    }
    for (const file of req.multipart.files || []) {
      const data = decodeBase64(file.base64);
      size += data.length;
      if (size > MAX_REQUEST) throw new Error('上传图片超过 96 MB 限制');
      form.append(String(file.field), new Blob([data], { type: file.mimeType || 'application/octet-stream' }), String(file.name || 'image.png'));
    }
    headers.delete('content-type');
    body = form;
  } else if (req.body != null) {
    if (typeof req.body !== 'string' || Buffer.byteLength(req.body) > MAX_REQUEST) throw new Error('请求内容过大或格式无效');
    if (req.method === 'GET') throw new Error('GET 请求不能包含正文');
    body = req.body;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  outerSignal?.addEventListener('abort', cancel, { once: true });
  if (outerSignal?.aborted) controller.abort();
  const timeout = setTimeout(cancel, TIMEOUT_MS);
  try {
    let target = url;
    let response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await fetch(target, { method: req.method, headers, body, redirect: 'manual', signal: controller.signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (req.method !== 'GET' || !location || redirects === 3) throw new Error('服务发生重定向，请填写最终 API 地址');
      const next = validateUrl(new URL(location, target).toString());
      if (next.origin !== target.origin) for (const name of [...headers.keys()]) headers.delete(name);
      target = next;
    }
    if (!response) throw new Error('服务未返回响应');
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > MAX_RESPONSE) throw new Error('服务返回内容超过 128 MB 限制');
    const chunks = [];
    let size = 0;
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_RESPONSE) { controller.abort(); throw new Error('服务返回内容超过 128 MB 限制'); }
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    return { status: response.status, body: data.toString(req.responseType === 'base64' ? 'base64' : 'utf8'), contentType: response.headers.get('content-type') || undefined };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(outerSignal?.aborted ? '请求已取消' : '服务请求超时，请稍后重试');
    if (error instanceof Error && /^(服务|上传|请求|图片|表单|不允许|GET)/.test(error.message)) throw error;
    throw new Error('无法连接模型服务，请检查服务地址、网络和 API 设置');
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener('abort', cancel);
  }
}

module.exports = { nativeRequest, validateUrl, decodeBase64, MAX_REQUEST, MAX_RESPONSE };
