// One open format for everything you set and taught Hamsa: a backup file, Firefox Sync and a GitHub gist
// all carry the same JSON. API keys and tokens are left out unless you ask for them.
//
// { "schema": "hamsa.backup/1", "app_version": "0.4.0", "exported_at": "...", "includes_keys": false,
//   "settings": {...}, "blocklist": {...}, "prefs": {...}, "dismissed": [...], "opened": {...},
//   "teach": { "adj": {...}, "muted": [...] }, "providers": [...], "reading_log": [...], "impressions": {...} }
import { normaliseBlocklist } from "./blocklist.js";
import { mergePrefs } from "./prefs.js";

export const BACKUP_SCHEMA = "hamsa.backup/1";
// Settings that belong to one browser and are never carried over.
const LOCAL_ONLY = new Set(["active"]);

export function makeBackup(store, { version = "", includeKeys = false, includeLog = true } = {}) {
  const settings = Object.fromEntries(Object.entries(store.settings || {}).filter(([k]) => !LOCAL_ONLY.has(k)));
  const b = {
    schema: BACKUP_SCHEMA, app_version: version, exported_at: new Date().toISOString(), includes_keys: !!includeKeys,
    settings, blocklist: store.blocklist || null, prefs: store.prefs || null, dismissed: store.dismissed || [],
    opened: store.opened || null, teach: { adj: store.graph?.adj || {}, muted: store.graph?.muted || [] },
    providers: (store.providers || []).map((p) => ({ name: p.name, kind: p.kind, baseUrl: p.baseUrl, models: p.models || [], knownModels: p.knownModels || [], ...(includeKeys && p.apiKey ? { apiKey: p.apiKey } : {}) })),
  };
  if (includeKeys && store.raindropToken) b.raindropToken = store.raindropToken;
  if (includeLog) { b.reading_log = store.readingLog || []; b.impressions = store.impressions || {}; }
  return b;
}

export function readBackup(obj) {
  if (!obj || typeof obj !== "object" || obj.schema !== BACKUP_SCHEMA) throw new Error("That is not a Hamsa backup (hamsa.backup/1).");
  return obj;
}

// Incoming backup + what this browser has -> the storage keys to write. Nothing is thrown away:
// likes merge by item (newest wins, your own choice beats one read from HN), blocklist groups merge by
// name, dismissals and the reading log are joined, providers merge by name and keep local keys.
export function mergeBackup(cur, inc) {
  const out = {};
  if (inc.settings) out.settings = { ...(cur.settings || {}), ...Object.fromEntries(Object.entries(inc.settings).filter(([k]) => !LOCAL_ONLY.has(k))), active: cur.settings?.active };
  if (inc.blocklist) {
    const mine = cur.blocklist?.groups || [];
    const names = new Set(mine.map((g) => g.name.toLowerCase()));
    const theirs = normaliseBlocklist(inc.blocklist).groups.filter((g) => !names.has(g.name.toLowerCase()));
    out.blocklist = normaliseBlocklist({ groups: [...mine, ...theirs] });
  }
  if (inc.prefs) out.prefs = mergePrefs(cur.prefs, inc.prefs);
  if (inc.dismissed) {
    const seen = new Set((cur.dismissed || []).map((d) => d.id));
    out.dismissed = [...(cur.dismissed || []), ...inc.dismissed.filter((d) => !seen.has(d.id))].sort((a, b) => b.at - a.at).slice(0, 500);
  }
  if (inc.opened) {
    const a = cur.opened || { domains: {}, titles: [], tags: {} }, b = inc.opened;
    const add = (x, y) => { const m = { ...x }; for (const [k, v] of Object.entries(y || {})) m[k] = Math.max(m[k] || 0, v); return m; };
    const ids = new Set((a.titles || []).map((t) => t.id));
    out.opened = { domains: add(a.domains, b.domains), tags: add(a.tags, b.tags), titles: [...(a.titles || []), ...(b.titles || []).filter((t) => !ids.has(t.id))].slice(0, 400) };
  }
  if (inc.reading_log) {
    const key = (e) => `${e.at}:${e.id}:${e.kind}`;
    const seen = new Set((cur.readingLog || []).map(key));
    out.readingLog = [...(cur.readingLog || []), ...inc.reading_log.filter((e) => !seen.has(key(e)))].sort((a, b) => b.at - a.at).slice(0, 5000);
  }
  if (inc.impressions) out.impressions = { ...inc.impressions, ...(cur.impressions || {}) };
  if (inc.teach) out.teach = inc.teach;
  if (inc.providers) {
    const mine = cur.providers || [];
    const merged = [...mine];
    for (const p of inc.providers) {
      const m = merged.find((x) => x.name === p.name && x.baseUrl === p.baseUrl);
      if (m) { m.models = [...new Set([...(m.models || []), ...(p.models || [])])]; if (!m.apiKey && p.apiKey) m.apiKey = p.apiKey; }
      else merged.push({ id: crypto.randomUUID(), name: p.name, kind: p.kind, baseUrl: p.baseUrl, apiKey: p.apiKey || "", models: p.models || [], knownModels: p.knownModels || [] });
    }
    out.providers = merged;
  }
  if (inc.raindropToken && !cur.raindropToken) out.raindropToken = inc.raindropToken;
  return out;
}

// Firefox Sync allows about 100 KB in items of 8 KB: the backup (no keys, no reading log) is cut into
// chunks, and the oldest likes and opened titles are trimmed until it fits.
export function toSyncChunks(backup, { maxBytes = 90000, chunk = 7000 } = {}) {
  const b = JSON.parse(JSON.stringify(backup));
  delete b.reading_log; delete b.impressions; delete b.raindropToken;
  for (const p of b.providers || []) delete p.apiKey;
  b.includes_keys = false;
  let text = JSON.stringify(b);
  while (text.length > maxBytes) {
    const items = Object.entries(b.prefs?.items || {}).sort((x, y) => x[1].at - y[1].at);
    if (items.length > 50) { for (const [k] of items.slice(0, Math.ceil(items.length / 5))) delete b.prefs.items[k]; }
    else if ((b.opened?.titles || []).length > 20) b.opened.titles = b.opened.titles.slice(0, Math.floor(b.opened.titles.length / 2));
    else if ((b.dismissed || []).length > 20) b.dismissed = b.dismissed.slice(0, Math.floor(b.dismissed.length / 2));
    else break;
    text = JSON.stringify(b);
  }
  const parts = [];
  for (let i = 0; i < text.length; i += chunk) parts.push(text.slice(i, i + chunk));
  return parts;
}
