import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { disableVisionTelemetry, localVision } from './local-vision.ts';

const directory = dirname(createRequire(import.meta.url).resolve('@mediapipe/tasks-vision'));
const source = readFileSync(join(directory, 'vision_bundle.mjs'), 'utf8');
const id = join(directory, 'vision_bundle.mjs');
const initializer = 'function(t,e){e=e.runningMode??"";var r=t.h.Ta();t.o=new $h(t.D(),e,r)}(t,n),';

test('the installed mjs and cjs entries lose exactly their single usage logger initializer', () => {
  for (const name of ['vision_bundle.mjs', 'vision_bundle.cjs']) {
    const filename = join(directory, name), before = readFileSync(filename, 'utf8');
    const output = disableVisionTelemetry(before, filename, '1.1.1');
    assert.ok(output);
    assert.equal(before.split(initializer).length - 1, 1);
    assert.equal(output.length, before.length - initializer.length);
    assert.equal(output.includes('t.o=new $h(t.D(),e,r)'), false);
    // Graph creation still directly reaches normal task option initialization.
    assert.ok(output.includes('await t.A(n),t}'));
    const offset = before.indexOf(initializer);
    assert.equal(output.slice(0, offset), before.slice(0, offset));
    assert.equal(output.slice(offset), before.slice(offset + initializer.length));
  }
});

test('unsupported SDK versions and missing or duplicate initializers are refused', () => {
  assert.throws(() => disableVisionTelemetry(source, id, '1.1.2'), /仅验证过/);
  assert.throws(() => disableVisionTelemetry(source.replace(initializer, ''), id, '1.1.1'), /恰好一个/);
  assert.throws(() => disableVisionTelemetry(source + initializer, id, '1.1.1'), /恰好一个/);
});

test('Windows paths and Vite query suffixes select the SDK while unrelated modules stay untouched', () => {
  assert.ok(disableVisionTelemetry(source, 'C:\\app\\node_modules\\@mediapipe\\tasks-vision\\vision_bundle.mjs?v=123', '1.1.1'));
  for (const other of ['/src/detection.ts', '/src/vision_bundle.mjs', '/node_modules/unrelated/vision_bundle.mjs', '/models/vision_wasm_nosimd_internal.js']) {
    assert.equal(disableVisionTelemetry(source, other, 'future-version'), null);
  }
});

test('the build adapter runs before bundling and refuses a build where its transform was bypassed', async () => {
  const plugin = localVision();
  assert.equal(plugin.enforce, 'pre');
  const start = plugin.buildStart;
  assert.equal(typeof start, 'function');
  await (start as (...args: unknown[]) => unknown).call({}, {});
  const generate = plugin.generateBundle;
  const context = { error: (message: string) => { throw new Error(message); } };
  assert.throws(() => (generate as (...args: unknown[]) => unknown).call(context), /未应用到最终模块/);
  const transform = plugin.transform;
  const patched = await (transform as (...args: unknown[]) => unknown).call({}, source, id);
  assert.ok(patched);
  assert.doesNotThrow(() => (generate as (...args: unknown[]) => unknown).call(context));
});
