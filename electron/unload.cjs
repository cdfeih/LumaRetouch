/** Electron blocks renderer beforeunload silently unless the main process handles it. */
function installUnloadConfirmation(window, { dialog, onLeave = () => {} }) {
  window.webContents.on('will-prevent-unload', event => {
    if (window.isDestroyed()) return;
    let choice = 0;
    try {
      choice = dialog.showMessageBoxSync(window, {
        type: 'question', title: '离开当前工作台？',
        message: '当前还有未导出修改或正在处理的任务。',
        detail: '请先确认工程已自动保存，并导出需要交付的照片。离开会取消正在进行的任务。',
        buttons: ['继续编辑', '确认离开'], defaultId: 0, cancelId: 0, noLink: true,
      });
    } catch { return; } // A failed dialog must not silently discard the current work.
    if (choice === 1) {
      onLeave();
      // This event has inverse semantics: preventDefault allows the renderer to unload.
      event.preventDefault();
    }
  });
}
module.exports = { installUnloadConfirmation };
