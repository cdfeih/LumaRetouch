import { createRequire } from 'node:module';
import type { Plugin } from 'vite';
import type { HttpRequest, HttpResponse } from '../src/ai/types.ts';

const require = createRequire(import.meta.url);
const { nativeRequest, MAX_REQUEST } = require('../electron/http.cjs') as {
  nativeRequest: (req: HttpRequest, signal?: AbortSignal) => Promise<HttpResponse>;
  MAX_REQUEST: number;
};

/** 开发期原生 HTTP 代理，仅接受同源、回环地址的开发请求。 */
export function nativeDevProxy(): Plugin {
  return {
    name: 'luma-native-development-proxy',
    configureServer(server) {
      server.middlewares.use('/__native/request', async (req, res) => {
        const host = req.headers.host || '';
        const origin = req.headers.origin;
        const remote = req.socket.remoteAddress || '';
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host) || (origin && origin !== `http://${host}`) || req.method !== 'POST') {
          res.writeHead(403).end('Forbidden'); return;
        }
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > MAX_REQUEST * 1.5) throw new Error('请求图片过大');
            chunks.push(bytes);
          }
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HttpRequest;
          const result = await nativeRequest(payload, controller.signal);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(result));
        } catch (error) {
          if (res.destroyed) return;
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : '服务请求失败' }));
        }
      });
    },
  };
}
