const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { writeFile } = require('node:fs/promises');
const { nativeRequest, decodeBase64 } = require('./http.cjs');

let mainWindow;
const active = new Map();
const devUrl = process.env.LUMA_DEV_URL;
const indexUrl = pathToFileURL(path.join(__dirname, '../dist/index.html')).href;

function trusted(event) {
  const frame = event.senderFrame;
  return !!frame && event.sender === mainWindow?.webContents && frame === mainWindow.webContents.mainFrame &&
    (devUrl ? new URL(frame.url).origin === new URL(devUrl).origin : frame.url.split('#')[0] === indexUrl);
}

function installHandlers() {
  ipcMain.handle('luma:request', async (event, req, id) => {
    if (!trusted(event) || typeof id !== 'string' || id.length > 100 || active.has(id) || active.size >= 4) throw new Error('请求不可用');
    const controller = new AbortController();
    active.set(id, controller);
    try { return await nativeRequest(req, controller.signal); }
    finally { active.delete(id); }
  });
  ipcMain.on('luma:cancel', (event, id) => { if (trusted(event)) active.get(id)?.abort(); });
  ipcMain.handle('luma:save-image', async (event, input) => {
    if (!trusted(event)) throw new Error('请求不可用');
    const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
    const extension = extensions[input?.mimeType];
    if (!extension) throw new Error('只支持导出 PNG、JPEG 或 WebP');
    const bytes = decodeBase64(input.base64);
    if (bytes.length > 64 * 1024 * 1024) throw new Error('导出图片超过 64 MB 限制');
    const valid = extension === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
      extension === 'jpg' ? bytes[0] === 255 && bytes[1] === 216 : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) throw new Error('图片内容与导出格式不一致');
    const safeName = String(input.suggestedName || '光修作品').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120).replace(/\.(png|jpe?g|webp)$/i, '');
    const selection = await dialog.showSaveDialog(mainWindow, { title: '导出精修照片', defaultPath: `${safeName}.${extension}`, filters: [{ name: '照片', extensions: [extension] }] });
    if (selection.canceled || !selection.filePath) return { saved: false, message: '已取消导出' };
    try { await writeFile(selection.filePath, bytes); }
    catch { throw new Error('图片保存失败，请检查保存位置是否可写'); }
    return { saved: true, message: '照片已保存' };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 960, minWidth: 980, minHeight: 680, title: '光修 AI', backgroundColor: '#111217', autoHideMenuBar: true, show: process.env.LUMA_TEST_HEADLESS !== '1',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !app.isPackaged } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!(devUrl ? new URL(url).origin === new URL(devUrl).origin : url.split('#')[0] === indexUrl)) event.preventDefault();
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.on('closed', () => { for (const controller of active.values()) controller.abort(); active.clear(); mainWindow = undefined; });
  if (devUrl) mainWindow.loadURL(devUrl); else mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
}

app.whenReady().then(() => { installHandlers(); createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
