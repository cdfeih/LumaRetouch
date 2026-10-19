import { describe, expect, it } from 'vitest';
import { runSequentialBatch, type BatchQueueSnapshot } from './queue';

const photos = () => [{ id: '1', name: '第一张.jpg', settings: { amount: 20 } }, { id: '2', name: '第二张.jpg', settings: { amount: 30 } }, { id: '3', name: '第三张.jpg', settings: { amount: 40 } }];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('serial photo queue', () => {
  it('runs exactly one photo at a time, in input order, and publishes immutable status snapshots', async () => {
    let active = 0, maximum = 0;
    const order: string[] = [], snapshots: BatchQueueSnapshot<ReturnType<typeof photos>[number], string>[] = [];
    const result = await runSequentialBatch(photos(), async item => {
      active++; maximum = Math.max(maximum, active); order.push(item.id);
      await tick(); active--; return `${item.id}-result`;
    }, { onUpdate: snapshot => snapshots.push(snapshot) });
    expect(maximum).toBe(1);
    expect(order).toEqual(['1','2','3']);
    expect(result).toMatchObject({ total: 3, completed: 3, succeeded: 3, failed: 0, pending: 0, running: 0, wasCancelled: false });
    expect(snapshots[0].entries.map(item => item.status)).toEqual(['pending','pending','pending']);
    expect(snapshots[1].entries.map(item => item.status)).toEqual(['running','pending','pending']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries)).toBe(true);
    expect(Object.isFrozen(result.entries[0])).toBe(true);
  });
  it('takes a deep input snapshot before the first run and protects nested settings', async () => {
    const input = photos(), seen: number[] = [];
    const promise = runSequentialBatch(input, async item => { seen.push(item.settings.amount); return item.name; });
    input[0].settings.amount = 100; input[1].name = '已改变.jpg'; input.push({ id: '4', name: '新增.jpg', settings: { amount: 99 } });
    const result = await promise;
    expect(seen).toEqual([20,30,40]);
    expect(result.entries[1].item.name).toBe('第二张.jpg');
    expect(Object.isFrozen(result.entries[0].item.settings)).toBe(true);
    expect(input[0].settings.amount).toBe(100);
  });
  it('retains Blob/File contents and their native arrayBuffer method in a snapshot', async () => {
    const blob = new Blob(['photo bytes'], { type: 'image/jpeg' });
    const result = await runSequentialBatch([{ id: '1', name: '照片.jpg', file: blob }], async item => {
      expect(item.file).not.toBe(blob);
      expect(item.file.type).toBe('image/jpeg');
      return new TextDecoder().decode(await item.file.arrayBuffer());
    });
    expect(result.entries[0].result).toBe('photo bytes');
  });
  it('records a single-photo failure, continues later photos, and never retries', async () => {
    const calls: string[] = [];
    const result = await runSequentialBatch(photos(), async item => {
      calls.push(item.id);
      if (item.id === '2') throw new Error('该图识别失败');
      return item.id;
    });
    expect(calls).toEqual(['1','2','3']);
    expect(result.entries.map(item => item.status)).toEqual(['succeeded','failed','succeeded']);
    expect(result.entries[1].error).toBe('该图识别失败');
    expect(result).toMatchObject({ completed: 3, succeeded: 2, failed: 1 });
  });
  it('supports preflight skips and changed:false result skips without losing their preview result', async () => {
    const calls: string[] = [];
    const result = await runSequentialBatch(photos(), async item => {
      calls.push(item.id); return { changed: item.id === '3', image: `${item.id}-preview` };
    }, {
      shouldSkip: item => item.id === '1' ? '参数全部为零' : undefined,
      resultSkipReason: value => !value.changed ? '未发现可处理的人像' : undefined,
    });
    expect(calls).toEqual(['2','3']);
    expect(result.entries.map(item => item.status)).toEqual(['skipped','skipped','succeeded']);
    expect(result.entries[0].reason).toBe('参数全部为零');
    expect(result.entries[1].reason).toBe('未发现可处理的人像');
    expect(result.entries[1].result).toEqual({ changed: false, image: '2-preview' });
    expect(result).toMatchObject({ completed: 3, skipped: 2, succeeded: 1 });
  });
  it('cancels immediately even if a running operation ignores its signal, ignores late success, and preserves completed items', async () => {
    const controller = new AbortController(), calls: string[] = [];
    let lateResolve: (value: string) => void = () => {};
    let updates = 0;
    const processing = runSequentialBatch(photos(), async (item, signal) => {
      calls.push(item.id);
      if (item.id === '1') return 'already done';
      expect(signal.aborted).toBe(false);
      return new Promise<string>(resolve => { lateResolve = resolve; });
    }, { signal: controller.signal, onUpdate: () => updates++ });
    while (calls.length < 2) await tick();
    controller.abort();
    const result = await processing, finalUpdates = updates;
    expect(result.entries.map(item => item.status)).toEqual(['succeeded','cancelled','cancelled']);
    expect(result.entries[0].result).toBe('already done');
    expect(result).toMatchObject({ completed: 3, succeeded: 1, cancelled: 2, wasCancelled: true });
    lateResolve('too late'); await tick();
    expect(updates).toBe(finalUpdates);
    expect(result.entries[1].result).toBeUndefined();
    expect(calls).toEqual(['1','2']);
  });
  it('handles a late rejection after cancellation without accepting or retrying it', async () => {
    const controller = new AbortController();
    let lateReject: (reason: Error) => void = () => {};
    const processing = runSequentialBatch(photos(), () => new Promise<string>((_, reject) => { lateReject = reject; }), { signal: controller.signal });
    await tick(); controller.abort();
    const result = await processing;
    lateReject(new Error('late failure')); await tick();
    expect(result.cancelled).toBe(3);
    expect(result.failed).toBe(0);
  });
  it('does not start any work for a pre-cancelled queue or cancellation from a running-status update', async () => {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    const result = await runSequentialBatch(photos(), async () => ++calls, { signal: controller.signal });
    expect(calls).toBe(0); expect(result.cancelled).toBe(3);
    const next = new AbortController();
    const other = await runSequentialBatch(photos(), async () => ++calls, { signal: next.signal, onUpdate: value => { if (value.running) next.abort(); } });
    expect(calls).toBe(0); expect(other.cancelled).toBe(3);
  });
  it('rejects duplicate identifiers before any work, and supports an empty queue', async () => {
    await expect(runSequentialBatch([photos()[0],photos()[0]], async () => '')).rejects.toThrow('编号');
    expect(await runSequentialBatch([], async () => '')).toMatchObject({ total: 0, completed: 0, succeeded: 0 });
  });
});
