import type { PortraitSettings } from '../portrait/settings';
import type { BatchAutomaticSummary } from './automatic-types';

export type BatchReviewState = 'pending' | 'approved' | 'redo';
export interface BatchReviewMetadata { starred: boolean; review: BatchReviewState }
export interface StoredBatchResult {
  id: string; name: string; blob: Blob; width: number; height: number; createdAt: number;
  settings: PortraitSettings; faceCount: number; bodyCount: number; warnings: string[];
  starred?: boolean; review?: BatchReviewState;
  automatic?: BatchAutomaticSummary;
}
const DATABASE = 'luma-batch-results-v1';
let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('当前浏览器不支持本地结果保存，请更换浏览器或使用安装版。')); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('results', { keyPath: 'id' });
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(new Error('无法打开本地结果库，请检查浏览器的站点存储权限。'));
    request.onblocked = () => reject(new Error('本地结果库正在被另一个窗口更新，请关闭旧窗口后重试。'));
  }).catch(error => { database = undefined; throw error; });
  return database;
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction('results', mode);
    const request = operation(tx.objectStore('results'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(new Error(tx.error?.name === 'QuotaExceededError'
      ? '本地存储空间不足。请先导出并删除已完成结果，再处理剩余照片。'
      : '本地结果保存失败，已完成的其他照片仍可导出。请检查站点存储权限。'));
  });
}

export async function listBatchResults(): Promise<StoredBatchResult[]> {
  const records = await transaction<StoredBatchResult[]>('readonly', store => store.getAll());
  return records.filter(record => record && typeof record.id === 'string' && record.blob instanceof Blob)
    .sort((a, b) => a.createdAt - b.createdAt);
}
export const saveBatchResult = (record: StoredBatchResult) => transaction('readwrite', store => store.put(record));
export const getBatchResult = (id: string) => transaction<StoredBatchResult | undefined>('readonly', store => store.get(id));
export const deleteBatchResult = (id: string) => transaction('readwrite', store => store.delete(id));

/** Update review flags in the same transaction as its read; never resurrect a deleted result. */
export async function updateBatchReview(id: string, update: Partial<BatchReviewMetadata>): Promise<boolean> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('results', 'readwrite'), store = tx.objectStore('results');
    let found = false;
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result as StoredBatchResult | undefined;
      if (!record) return;
      found = true;
      store.put({ ...record, ...update });
    };
    tx.oncomplete = () => resolve(found);
    tx.onerror = tx.onabort = () => reject(new Error('复核状态未能保存，请检查本地存储后重试。'));
  });
}

export function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取待导出的照片，请重试。'));
    reader.readAsDataURL(blob);
  });
}
