const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { writeFile } = require('node:fs/promises');
const { nativeRequest } = require('./http.cjs');
const { saveExport } = require('./save.cjs');
const { installUnloadConfirmation } = require('./unload.cjs');

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
    return saveExport(mainWindow, input, { dialog, writeFile });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 960, minWidth: 980, minHeight: 680, title: '光修 AI', backgroundColor: '#111217', autoHideMenuBar: true, show: process.env.LUMA_TEST_HEADLESS !== '1',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !app.isPackaged } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  installUnloadConfirmation(mainWindow, { dialog, onLeave: () => { for (const controller of active.values()) controller.abort(); } });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!(devUrl ? new URL(url).origin === new URL(devUrl).origin : url.split('#')[0] === indexUrl)) event.preventDefault();
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.on('closed', () => { for (const controller of active.values()) controller.abort(); active.clear(); mainWindow = undefined; });
  if (devUrl) mainWindow.loadURL(devUrl); else mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
}

app.whenReady().then(() => { installHandlers(); createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
