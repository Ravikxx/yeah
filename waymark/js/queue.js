// Upload queue for street capture. Each finished 2-minute chunk is saved in
// IndexedDB first, then uploaded one at a time in the background, so a bad
// signal or a closed tab doesn't lose footage. Falls back to memory when
// IndexedDB isn't available (some private windows).

import { uploadRoute } from './api.js?v=202610252203';

const DB_NAME = 'waymark';
const STORE = 'uploads';
let dbp = null;
const memory = new Map();
let memKey = 1;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key', autoIncrement: true });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  if (!d) return fn(null);
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

// iPhone Safari can lose video saved in IndexedDB as a Blob (it keeps it as a
// separate file that can disappear), so pieces are saved as raw bytes instead.
const bodyOf = (item) => item.blob || new Blob([item.bytes], { type: item.type });

export async function enqueue(item) {
  if (item.blob) {
    const { blob, ...rest } = item;
    item = { ...rest, bytes: await blob.arrayBuffer(), type: blob.type, size: blob.size };
  }
  const d = await db();
  if (!d) { const key = memKey++; memory.set(key, { ...item, key, tries: 0 }); notify(); kick(); return key; }
  const key = await tx('readwrite', (s) => s.add({ ...item, tries: 0 }));
  notify();
  kick();
  return key;
}

export async function pending() {
  const d = await db();
  if (!d) return [...memory.values()];
  return tx('readonly', (s) => s.getAll());
}

async function update(item) {
  const d = await db();
  if (!d) { memory.set(item.key, item); return; }
  await tx('readwrite', (s) => s.put(item));
}

async function drop(key) {
  const d = await db();
  if (!d) { memory.delete(key); return; }
  await tx('readwrite', (s) => s.delete(key));
}

// ---- background uploader ----

const listeners = new Set();
export const status = { waiting: 0, uploading: false, progress: 0, lastError: null, uploaded: 0, bytesUploaded: 0 };
export function onStatus(fn) { listeners.add(fn); fn(status); return () => listeners.delete(fn); }
async function notify() {
  status.waiting = (await pending()).length;
  listeners.forEach((fn) => fn(status));
}

const doneListeners = new Set();
export function onUploaded(fn) { doneListeners.add(fn); return () => doneListeners.delete(fn); }

let running = false;
let retryTimer = null;

export function kick() {
  clearTimeout(retryTimer);
  if (!running) run();
}

async function run() {
  running = true;
  try {
    for (;;) {
      const items = (await pending()).sort((a, b) => a.key - b.key);
      status.waiting = items.length;
      if (!items.length) break;
      const item = items[0];
      status.uploading = true;
      status.progress = 0;
      notify();
      try {
        const id = await uploadRoute(
          { meta: item.meta, video: bodyOf(item), created: item.created },
          (p) => { status.progress = p; listeners.forEach((fn) => fn(status)); },
          async (created) => { item.created = created; await update(item); },
        );
        await drop(item.key);
        status.uploaded++;
        status.bytesUploaded += item.size ?? item.blob?.size ?? 0;
        status.lastError = null;
        doneListeners.forEach((fn) => fn({ id, meta: item.meta }));
      } catch (err) {
        // Rejected outright (bad track, too big): retrying won't help.
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
          await drop(item.key);
          status.lastError = `A chunk was skipped: ${err.message}`;
        } else {
          item.tries = (item.tries || 0) + 1;
          await update(item);
          status.lastError = navigator.onLine === false ? 'Offline. Uploads resume when you’re back online.' : err.message;
          const wait = Math.min(120000, 5000 * 2 ** Math.min(item.tries - 1, 5));
          retryTimer = setTimeout(kick, wait);
          break;
        }
      }
    }
  } finally {
    running = false;
    status.uploading = false;
    notify();
  }
}

addEventListener('online', kick);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
