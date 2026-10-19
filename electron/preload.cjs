const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lumaNative', {
  request: (req, id) => ipcRenderer.invoke('luma:request', req, id),
  cancel: (id) => ipcRenderer.send('luma:cancel', id),
  exportImage: (input) => ipcRenderer.invoke('luma:save-image', input),
});
