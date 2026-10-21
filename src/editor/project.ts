import type { EditorDocument } from './history';
import type { PortraitSessionSnapshot } from '../portrait/PortraitPanel';

export interface SavedMasks { selection: string; protection: string }
export interface ProjectDraft {
  version: 1;
  activeId: string;
  documents: EditorDocument[];
  sessions: Record<string, PortraitSessionSnapshot>;
  masks: Record<string, SavedMasks>;
  savedAt: number;
}
interface PackedDraft { version: 1; tree: unknown; assets: Blob[] }
const DATABASE = 'luma-project-draft-v1';
const MAX_BYTES = 256 * 1024 * 1024;
let database: Promise<IDBDatabase> | undefined;

/** Deduplicate full-size images shared by history and portrait baselines. No API settings are stored. */
export function packProjectDraft(draft: ProjectDraft): PackedDraft {
  const assets: Blob[] = [], ids = new Map<string, number>();
  let bytes = 0;
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string' && /^data:image\/(?:jpeg|png|webp);base64,/.test(value)) {
      let id = ids.get(value);
      if (id === undefined) {
        const [header, body] = value.split(',');
        const decoded = atob(body), buffer = new Uint8Array(decoded.length);
        bytes += buffer.length;
        if (bytes > MAX_BYTES) throw new Error('工程草稿超过 256 MB，请先导出并关闭部分照片。上次保存的草稿仍保留。');
        for (let i = 0; i < decoded.length; i++) buffer[i] = decoded.charCodeAt(i);
        id = assets.length;
        if (id >= 250) throw new Error('工程中的独立图片版本过多，请先导出并关闭部分照片。上次草稿仍保留。');
        assets.push(new Blob([buffer], { type: header.slice(5, -7) })); ids.set(value, id);
      }
      return { imageAsset: id };
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  return { version: 1, tree: walk(draft), assets };
}

export async function unpackProjectDraft(packed: PackedDraft): Promise<ProjectDraft> {
  if (!packed || packed.version !== 1 || !Array.isArray(packed.assets) || packed.assets.length > 250 || packed.assets.reduce((sum, item) => sum + (item instanceof Blob ? item.size : Infinity), 0) > MAX_BYTES) throw new Error('本地草稿格式不兼容或图片过大。');
  const images: string[] = [];
  for (const blob of packed.assets) {
    if (!/^image\/(png|jpeg|webp)$/.test(blob.type)) throw new Error('本地草稿包含不支持的图片。');
    images.push(await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('无法读取本地草稿图片。')); reader.readAsDataURL(blob);
    }));
  }
  const walk = (value: unknown): unknown => {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'imageAsset' in value) {
      const id = (value as { imageAsset: number }).imageAsset;
      if (!Number.isInteger(id) || !images[id]) throw new Error('本地草稿缺少图片，请保留原片重新导入。');
      return images[id];
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  const draft = walk(packed.tree) as ProjectDraft;
  if (!draft || draft.version !== 1 || !Array.isArray(draft.documents) || draft.documents.length > 10 || !draft.sessions || !draft.masks || draft.documents.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string' || !item.original?.startsWith('data:image/') || !item.current?.startsWith('data:image/') || !(item.width > 0 && item.height > 0 && item.width * item.height <= 40_000_000) || !Array.isArray(item.history) || !Array.isArray(item.future) || item.history.length > 5 || item.future.length > 5)) throw new Error('本地草稿记录不完整，请保留原片重新导入。');
  return draft;
}

function open(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('当前环境无法自动保存工程，请及时导出照片。')); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); database = undefined; }; resolve(db); };
    request.onerror = () => reject(new Error('无法打开本地工程库，请检查站点存储权限。'));
    request.onblocked = () => reject(new Error('本地工程库被旧窗口占用，请关闭旧窗口后重试。'));
  }).catch(error => { database = undefined; throw error; });
  return database;
}
async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction('drafts', mode), request = action(transaction.objectStore('drafts'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(new Error(transaction.error?.name === 'QuotaExceededError' ? '本地空间不足，自动保存失败；上次草稿仍保留，请先导出照片。' : '工程自动保存失败，请及时导出照片。上次成功草稿仍保留。'));
  });
}
export async function loadProjectDraft(): Promise<ProjectDraft | null> {
  const packed = await transact<PackedDraft | undefined>('readonly', store => store.get('current'));
  return packed ? unpackProjectDraft(packed) : null;
}
export async function saveProjectDraft(draft: ProjectDraft): Promise<void> {
  const packed = packProjectDraft(draft);
  await transact('readwrite', store => store.put(packed, 'current'));
}
