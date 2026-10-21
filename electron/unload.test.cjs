const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installUnloadConfirmation } = require('./unload.cjs');

function fixture(response, destroyed = false) {
  const window = { webContents: new EventEmitter(), isDestroyed: () => destroyed };
  let prompts = 0, departures = 0, prevented = 0;
  installUnloadConfirmation(window, { dialog: { showMessageBoxSync: (owner, options) => {
    prompts++; assert.equal(owner, window); assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
    assert.deepEqual(options.buttons, ['继续编辑', '确认离开']);
    if (response instanceof Error) throw response;
    return response;
  } }, onLeave: () => departures++ });
  window.webContents.emit('will-prevent-unload', { preventDefault: () => prevented++ });
  return { prompts, departures, prevented };
}
test('default or canceled confirmation keeps the current work and request', () => {
  assert.deepEqual(fixture(0), { prompts: 1, departures: 0, prevented: 0 });
});
test('explicit leave allows reload/close and cancels pending requests', () => {
  assert.deepEqual(fixture(1), { prompts: 1, departures: 1, prevented: 1 });
});
test('dialog failures retain current work rather than discard it', () => {
  assert.deepEqual(fixture(new Error('dialog unavailable')), { prompts: 1, departures: 0, prevented: 0 });
});
test('destroyed windows do not create new confirmation dialogs', () => {
  assert.deepEqual(fixture(1, true), { prompts: 0, departures: 0, prevented: 0 });
});
