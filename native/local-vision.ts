import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

const SUPPORTED_VERSION = '1.1.1';
// Exact upstream initializer: constructing $h starts the periodic usage logger.
// The task's normal processing methods already guard the optional logger.
const TELEMETRY_INITIALIZER = 'function(t,e){e=e.runningMode??"";var r=t.h.Ta();t.o=new $h(t.D(),e,r)}(t,n),';
const BUNDLE_PATH = /(?:^|\/)@mediapipe\/tasks-vision\/vision_bundle\.(?:mjs|cjs)$/;
const modulePath = (id: string) => id.split(/[?#]/, 1)[0].replaceAll('\\', '/');

/** Only adapt the pinned SDK entry; unsupported upstream changes fail closed. */
export function disableVisionTelemetry(code: string, id: string, version: string): string | null {
  if (!BUNDLE_PATH.test(modulePath(id))) return null;
  if (version !== SUPPORTED_VERSION) throw new Error(`本地视觉运行时仅验证过 @mediapipe/tasks-vision ${SUPPORTED_VERSION}，当前为 ${version}。请重新审查遥测适配后再升级。`);
  const first = code.indexOf(TELEMETRY_INITIALIZER);
  if (first < 0 || code.indexOf(TELEMETRY_INITIALIZER, first + TELEMETRY_INITIALIZER.length) >= 0) {
    throw new Error('MediaPipe 本地遥测适配失败：预期恰好一个已验证的日志初始化入口；上游代码已变化，已阻止继续构建。');
  }
  return code.slice(0, first) + code.slice(first + TELEMETRY_INITIALIZER.length);
}

export function localVision(): Plugin {
  const entry = createRequire(import.meta.url).resolve('@mediapipe/tasks-vision');
  const directory = dirname(entry);
  let version = '', transformed = false;
  return {
    name: 'luma-local-vision',
    enforce: 'pre',
    buildStart() {
      transformed = false;
      version = (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version: string }).version;
      // Validate both installed entries before dev serving or production build.
      // This never writes into node_modules or the original JS/WASM assets.
      for (const file of ['vision_bundle.mjs', 'vision_bundle.cjs']) {
        const filename = join(directory, file);
        disableVisionTelemetry(readFileSync(filename, 'utf8'), filename, version);
      }
    },
    transform(code, id) {
      const result = disableVisionTelemetry(code, id, version);
      if (result === null) return null;
      transformed = true;
      return { code: result, map: null };
    },
    generateBundle() {
      if (!transformed) this.error('MediaPipe 本地遥测适配未应用到最终模块；已阻止输出，请检查 SDK 入口和依赖预打包配置。');
    },
  };
}
