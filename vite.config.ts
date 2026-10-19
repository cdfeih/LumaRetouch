import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nativeDevProxy } from './native/dev-proxy.ts';

export default defineConfig({
  plugins: [react(), nativeDevProxy()],
  base: './',
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: { target: 'es2022' },
});
