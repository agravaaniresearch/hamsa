// Large, frequently written data lives in IndexedDB, not in storage.local. Firefox sends every
// storage.local change (the old value and the new one) to every open Hacker News tab, so rewriting a
// multi-megabyte graph or a 5,000-row reading log there costs every tab. IndexedDB sends nothing.
//
// Only the background page writes here. Values are kept in memory after the first read and written
// back shortly after they change, several changes in one write.
const DB_NAME = "hamsa", STORE = "kv", WRITE_DELAY = 1500;

// The keys that live here. Everything else stays in storage.local.
export const BIG_KEYS = ["graph", "karma", "previews", "impressions", "readingLog", "cache", "topics", "digest", "opened"];

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

function tx(mode, run) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const memo = new Map();
const dirty = new Set();
let timer = null;

export async function bigGet(key, fallback = null) {
  if (memo.has(key)) return memo.get(key) ?? fallback;
  const v = await tx("readonly", (s) => s.get(key));
  if (!memo.has(key)) memo.set(key, v ?? null); // a set() made while reading wins
  return memo.get(key) ?? fallback;
}

export async function bigGetMany(keys) {
  const out = {};
  await Promise.all(keys.map(async (k) => { out[k] = await bigGet(k); }));
  return out;
}

// Changes memory at once; the write follows within WRITE_DELAY. { now: true } writes straight away.
export function bigSet(key, value, { now = false } = {}) {
  memo.set(key, value);
  dirty.add(key);
  clearTimeout(timer);
  if (now) return flush();
  timer = setTimeout(() => { flush().catch(() => {}); }, WRITE_DELAY);
  return Promise.resolve();
}

export async function flush() {
  clearTimeout(timer);
  if (!dirty.size) return;
  const keys = [...dirty];
  dirty.clear();
  await tx("readwrite", (s) => { for (const k of keys) { const v = memo.get(k); if (v == null) s.delete(k); else s.put(v, k); } });
}

// Moves the large keys out of storage.local the first time 0.6 runs. Safe to call on every start.
// overwrite: a value newly written to storage.local replaces what IndexedDB holds.
export async function migrateFromLocal(storageLocal, { overwrite = false } = {}) {
  const found = await storageLocal.get(BIG_KEYS);
  const keys = Object.keys(found).filter((k) => found[k] != null);
  if (!keys.length) return [];
  for (const k of keys) if (overwrite || (await bigGet(k)) == null) { memo.set(k, found[k]); dirty.add(k); }
  await flush();
  await storageLocal.remove(keys);
  return keys;
}
