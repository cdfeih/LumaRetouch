import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5178', '--strictPort'], { stdio: 'inherit' });
let electron;
const stop = () => { electron?.kill(); vite.kill(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
vite.on('exit', () => { electron?.kill(); });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const response = await fetch('http://127.0.0.1:5178'); if (response.ok) { ready = true; break; } } catch { /* server starting */ }
    if (vite.exitCode !== null) throw new Error('开发服务启动失败，检查端口 5178 是否被占用');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('开发服务启动超时');
  const env = { ...process.env, LUMA_DEV_URL: 'http://127.0.0.1:5178' };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(require('electron'), ['.'], { stdio: 'inherit', env });
  electron.on('exit', (code) => { vite.kill(); process.exitCode = code || 0; });
} catch (error) { stop(); console.error(error.message); process.exitCode = 1; }
