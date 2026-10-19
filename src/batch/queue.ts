export type BatchQueueStatus = 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed' | 'cancelled';
export type BatchQueueItem = { id: string; name: string };
export type BatchQueueEntry<T extends BatchQueueItem, R> = Readonly<{
  id: string;
  name: string;
  item: Readonly<T>;
  status: BatchQueueStatus;
  result?: R;
  error?: string;
  reason?: string;
}>;
export type BatchQueueSnapshot<T extends BatchQueueItem, R> = Readonly<{
  entries: readonly BatchQueueEntry<T, R>[];
  total: number;
  completed: number;
  pending: number;
  running: number;
  succeeded: number;
  skipped: number;
  failed: number;
  cancelled: number;
  wasCancelled: boolean;
}>;
export type BatchQueueOptions<T extends BatchQueueItem, R> = {
  signal?: AbortSignal;
  shouldSkip?: (item: Readonly<T>) => string | undefined;
  resultSkipReason?: (result: R, item: Readonly<T>) => string | undefined;
  onUpdate?: (snapshot: BatchQueueSnapshot<T, R>) => void;
};

function immutableSnapshot<T>(item: T): Readonly<T> {
  const clone: T = structuredClone(item);
  const seen = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    // File/Blob retain their native prototype and arrayBuffer()/stream() methods.
    // Only plain objects and arrays need recursive freezing; typed-array elements
    // cannot be frozen by Object.freeze and are not edited by the queue.
    if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(clone);
  return clone;
}

function cancellation(): DOMException {
  return new DOMException('已取消批量处理。', 'AbortError');
}

function abortableRun<R>(operation: () => Promise<R>, signal: AbortSignal): Promise<R> {
  if (signal.aborted) return Promise.reject(cancellation());
  return new Promise<R>((resolve, reject) => {
    const abort = () => reject(cancellation());
    signal.addEventListener('abort', abort, { once: true });
    // Attach both handlers before starting so rejected or ignored late jobs never
    // become unhandled rejections after the caller has already cancelled.
    Promise.resolve().then(() => {
      if (signal.aborted) throw cancellation();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Fixed concurrency of one; every call takes independent immutable input snapshots. */
export async function runSequentialBatch<T extends BatchQueueItem, R>(
  items: readonly T[],
  run: (item: Readonly<T>, signal: AbortSignal) => Promise<R>,
  options: BatchQueueOptions<T, R> = {},
): Promise<BatchQueueSnapshot<T, R>> {
  const ids = new Set<string>();
  const entries: Array<{ id: string; name: string; item: Readonly<T>; status: BatchQueueStatus; result?: R; error?: string; reason?: string }> = items.map(item => {
    if (typeof item.id !== 'string' || !item.id.trim() || typeof item.name !== 'string' || ids.has(item.id)) throw new Error('批量照片的编号不能为空或重复。');
    ids.add(item.id);
    return { id: item.id, name: item.name, item: immutableSnapshot(item), status: 'pending' };
  });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const snapshot = (): BatchQueueSnapshot<T, R> => {
    const counts = { pending: 0, running: 0, succeeded: 0, skipped: 0, failed: 0, cancelled: 0 };
    for (const entry of entries) counts[entry.status]++;
    return Object.freeze({
      entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))), total: entries.length,
      completed: counts.succeeded + counts.skipped + counts.failed + counts.cancelled,
      ...counts, wasCancelled: controller.signal.aborted,
    });
  };
  const publish = () => { const value = snapshot(); options.onUpdate?.(value); return value; };
  try {
    publish();
    for (const entry of entries) {
      if (controller.signal.aborted) break;
      try {
        const reason = options.shouldSkip?.(entry.item);
        if (controller.signal.aborted) break;
        if (reason) { entry.status = 'skipped'; entry.reason = reason; publish(); continue; }
        entry.status = 'running'; publish();
        const result = await abortableRun(() => run(entry.item, controller.signal), controller.signal);
        if (controller.signal.aborted) break;
        const skipReason = options.resultSkipReason?.(result, entry.item);
        if (controller.signal.aborted) break;
        entry.result = result;
        entry.status = skipReason ? 'skipped' : 'succeeded';
        if (skipReason) entry.reason = skipReason;
      } catch (error) {
        if (controller.signal.aborted) break;
        entry.status = 'failed';
        entry.error = error instanceof Error ? error.message : '该照片处理失败。';
      }
      publish();
    }
    if (controller.signal.aborted) {
      for (const entry of entries) if (entry.status === 'pending' || entry.status === 'running') {
        entry.status = 'cancelled'; entry.reason = '已取消，未接纳新的处理结果。';
      }
      return publish();
    }
    return snapshot();
  } finally { options.signal?.removeEventListener('abort', cancel); }
}
