/** Verify the emitted Worker and WASM without development transforms: HTTP and Electron file://. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, _electron } from 'playwright'

const root = path.resolve(process.env.LUMA_RAW_BUILD_DIR || 'artifacts/raw-color/build')
const output = path.resolve('artifacts/raw-built')
const fixture = path.resolve(process.env.LUMA_RAW_FIXTURE || 'artifacts/raw/Panasonic-DC-S9-24MP.RW2')
await mkdir(output, { recursive: true })
const worker = (await readdir(path.join(root, 'assets'))).find(name => /^worker-.*\.js$/.test(name))
assert.ok(worker, '先执行 Vite 生产构建，生成 RAW Worker')
const events = [], errors = []

async function decodeInPage(page, workerUrl) {
  await page.evaluate(() => { const input = document.createElement('input'); input.id = 'fixture'; input.type = 'file'; document.body.appendChild(input) })
  await page.locator('#fixture').setInputFiles(fixture)
  return page.evaluate(async url => {
    const started = performance.now(), buffer = await document.querySelector('#fixture').files[0].arrayBuffer()
    const w = new Worker(url, { type: 'module' })
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('built worker timed out')), 120_000)
        w.onerror = error => { clearTimeout(timer); reject(new Error(error.message)) }
        w.onmessage = async ({ data }) => {
          if (data.type === 'error') { clearTimeout(timer); reject(new Error(data.message)) }
          if (data.type === 'result') {
            clearTimeout(timer)
            if (!(data.blob instanceof Blob) || data.blob.size < 1000) return reject(new Error('built worker did not return PNG'))
            const image = await createImageBitmap(data.blob)
            const result = { ...data.metadata, pngBytes: data.blob.size, decodedWidth: image.width, decodedHeight: image.height,
              ms: Math.round(performance.now() - started), crossOriginIsolated }
            image.close(); resolve(result)
          }
        }
        w.postMessage({ buffer }, [buffer])
      })
    } finally { w.terminate() }
  }, workerUrl)
}

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (pathname === '/test.html') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body></body>'); return }
    const target = path.resolve(root, `.${pathname}`)
    if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return }
    const bytes = await readFile(target)
    res.setHeader('content-type', target.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
    res.end(bytes)
  } catch { res.writeHead(404).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let browser, electron
try {
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
  const page = await browser.newPage()
  await page.route('**/*', route => { const url = route.request().url(); return /^(blob:|data:)/.test(url) || new URL(url).origin === base ? route.continue() : route.abort() })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/test.html`)
  const http = await decodeInPage(page, `${base}/assets/${worker}`)
  assert.equal(http.source, 'sensor-demosaic'); assert.equal(http.crossOriginIsolated, false)
  assert.deepEqual([http.decodedWidth, http.decodedHeight], [6016, 4016])
  events.push({ check: '生产静态HTTP资源，无跨源隔离', passed: true, ...http })
  await browser.close(); browser = undefined
  const main = path.join(output, 'main.cjs'), empty = path.join(output, 'test.html')
  await writeFile(empty, '<!doctype html><body></body>')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});w.loadFile(${JSON.stringify(empty)});});app.on('window-all-closed',()=>app.quit());`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  electron = await _electron.launch({ args: [main, `--user-data-dir=${path.join(output, 'profile')}`], env })
  const window = await electron.firstWindow()
  const native = await decodeInPage(window, pathToFileURL(path.join(root, 'assets', worker)).href)
  assert.deepEqual([native.decodedWidth, native.decodedHeight], [6016, 4016])
  events.push({ check: 'Electron file资源+沙盒+webSecurity', passed: true, ...native })
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, errors, events }, null, 2))
  console.log(JSON.stringify({ passed: true, errors, events }, null, 2))
} catch (error) {
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, errors, events, error: error.message, stack: error.stack }, null, 2))
  throw error
} finally { await browser?.close(); await electron?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
