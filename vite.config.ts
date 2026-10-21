import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nativeDevProxy } from './native/dev-proxy.ts';
import { localVision } from './native/local-vision.ts';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const packageMetadata = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
let revision = 'source-archive';
try {
  const root = new URL('.', import.meta.url);
  revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) revision += '-dirty';
} catch { /* Source archives need neither a .git directory nor Git on PATH. */ }

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageMetadata.version),
    __BUILD_REVISION__: JSON.stringify(revision),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [localVision(), react(), nativeDevProxy()],
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  base: './',
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: { target: 'es2022' },
});
