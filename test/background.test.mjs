// The background page end to end, with a fake browser: storage, messages and IndexedDB.
// Checks the 0.6 storage layout (large data in IndexedDB, nothing large in storage.local), the
// migration from 0.5, learning that writes only "teach", backup round trips and the HN login flow.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import "fake-indexeddb/auto";
import { parseHTML } from "linkedom";
import { buildState } from "../extension/lib/graph.js";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const front1 = read("../fixtures/front/news-p1.html");
const thread1 = read("../fixtures/threads/50403507.html");
const bm = JSON.parse(read("../fixtures/synthetic/bookmarks.json"));

// ---- a fake browser ----
function area(name, changes) {
  let data = {};
  const pick = (keys) => {
    if (keys == null) return { ...data };
    if (typeof keys === "string") return keys in data ? { [keys]: clone(data[keys]) } : {};
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, clone(data[k])]));
    return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? clone(data[k]) : d]));
  };
  return {
    data: () => data,
    reset: (d = {}) => { data = clone(d); },
    get: async (k) => pick(k),
    set: async (obj) => {
      const ch = {};
      for (const [k, v] of Object.entries(obj)) { ch[k] = { oldValue: data[k], newValue: clone(v) }; data[k] = clone(v); }
      changes.push({ area: name, keys: Object.keys(obj), bytes: JSON.stringify(obj).length });
      for (const l of listeners) l(ch, name);
    },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  };
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const listeners = [];
const changes = [];
let onMessage = null;
const sent = [];
globalThis.browser = {
  storage: { local: area("local", changes), sync: area("sync", changes), onChanged: { addListener: (f) => listeners.push(f) } },
  runtime: {
    onMessage: { addListener: (f) => { onMessage = f; } },
    onStartup: { addListener: () => {} },
    getManifest: () => ({ version: "0.6.0" }),
    getURL: (p) => `moz-extension://test/${p}`,
    sendMessage: async (m) => { sent.push(m); },
    openOptionsPage: async () => {},
  },
  action: { onClicked: { addListener: () => {} } },
  permissions: { contains: async () => false, request: async () => false },
  tabs: { create: async () => ({}) },
};
globalThis.DOMParser = class { parseFromString(html) { return parseHTML(html).document; } };
// No network: karma and pages are not fetched in these tests.
globalThis.fetch = async () => { throw new Error("offline"); };

const HN = { url: "https://news.ycombinator.com/news" };
const call = (msg, sender = HN) => onMessage(msg, sender);
const local = globalThis.browser.storage.local;

test("0.5 data moves into IndexedDB and the background answers", async () => {
  // A 0.5 profile: the graph and logs in storage.local.
  const graph = buildState(bm, { params: { minTagCount: 1, minTermDocs: 1 } });
  graph.adj = { "pkm": 0.6 };
  local.reset({ graph, readingLog: [{ at: 1, kind: "story", id: 1 }], opened: { domains: { "a.com": 2 }, titles: [], tags: {} }, karma: { pg: [155000, Date.now()] }, settings: { readingLog: true } });
  await import("../extension/background.js");
  assert.equal(typeof onMessage, "function");
  const r = await call({ type: "graph-info" });
  assert.equal(r.ready, true);
  const d = local.data();
  for (const k of ["graph", "readingLog", "opened", "karma"]) assert.ok(!(k in d), `${k} left in storage.local`);
  assert.deepEqual(d.teach?.adj, { "pkm": 0.6 }, "what you taught the 0.5 graph is kept as teach");
});

test("a front page is scored and nothing large is written to storage.local", async () => {
  changes.length = 0;
  const r = await call({ type: "front", pages: [front1] });
  assert.ok(r.stories.length >= 25, `stories ${r.stories.length}`);
  assert.equal(r.verdicts.length, r.stories.length);
  const big = changes.filter((c) => c.area === "local" && c.bytes > 20000);
  assert.deepEqual(big, [], "no write over 20 KB to storage.local");
});

test("a thumb writes only the small teach key", async () => {
  changes.length = 0;
  const r = await call({ type: "feedback", kind: "thumb", dir: "up", tags: ["pkm"] });
  assert.equal(r.ok, true);
  const keys = changes.filter((c) => c.area === "local").flatMap((c) => c.keys);
  assert.deepEqual([...new Set(keys)], ["teach"]);
  assert.ok(changes.every((c) => c.bytes < 5000));
});

test("a thread is analysed, and summarising without a provider says what to do", async () => {
  const r = await call({ type: "thread", id: 50403507, pages: [thread1] });
  assert.ok(r.funnel, "funnel");
  assert.ok(Object.keys(r.verdicts).length > 20);
  const s = await call({ type: "summarise", id: 50403507 });
  assert.match(s.error, /provider/i);
});

test("backup export carries teach and the log; import merges back", async () => {
  await call({ type: "opened", entry: { kind: "story", id: 7, title: "Rust compilers in practice", url: "https://x.org/a", tags: [] } });
  const b = await call({ type: "backup-export", includeKeys: false, includeLog: true });
  const j = JSON.parse(b.json);
  assert.equal(j.schema, "hamsa.backup/1");
  assert.notDeepEqual(j.teach.adj.pkm, 0.6, "the thumb is in the backup");
  assert.ok(j.reading_log.some((e) => e.id === 7));
  assert.ok(!JSON.stringify(j).includes("hnLogin"));
  const back = await call({ type: "backup-import", json: b.json });
  assert.equal(back.ok, true);
  const n = await call({ type: "log-count" });
  assert.ok(n.opened >= 2);
});

test("HN login: only HN pages get it, a wrong password stops it, saving again resets", async () => {
  await call({ type: "hn-login-save", user: "ap", pass: "secret", auto: true });
  assert.deepEqual(await call({ type: "hn-login-ask" }, { url: "https://evil.example/" }), { go: false });
  const ask = await call({ type: "hn-login-ask" });
  assert.deepEqual(ask, { go: true, acct: "ap", pw: "secret" });
  assert.equal((await call({ type: "hn-login-ask" })).status, "wait", "one try per five minutes");
  await call({ type: "hn-login-result", status: "bad" });
  assert.equal((await call({ type: "hn-login-state" })).status, "bad");
  await call({ type: "hn-login-save", user: "ap", pass: null, auto: true });
  const st = await call({ type: "hn-login-state" });
  assert.equal(st.status, null);
  assert.equal(st.hasPass, true, "saving without a new password keeps the old one");
  const b = JSON.parse((await call({ type: "backup-export", includeKeys: true })).json);
  assert.ok(!JSON.stringify(b).includes("secret"), "the HN password never reaches a backup");
});

test("a thumb on a story teaches its tags, and clearing it takes the lesson back", async () => {
  const before = (await local.get("teach")).teach?.adj?.obsidian ?? 0;
  await call({ type: "pref", item: { id: 999, kind: "story", title: "Obsidian vault tips", tags: ["obsidian"] }, value: "like" });
  const mid = (await local.get("teach")).teach.adj.obsidian;
  assert.ok(mid > before, "like raises the tag");
  await call({ type: "pref", item: { id: 999, kind: "story", title: "Obsidian vault tips", tags: ["obsidian"] }, value: null });
  assert.equal((await local.get("teach")).teach.adj.obsidian, before, "clearing restores it");
  const opened = await call({ type: "log-count" });
  assert.ok(opened.opened < 10, "a thumb is not logged as an open");
});

test("0.7: a second visit to a thread knows the last comment you saw; health reports and lightest mode", async () => {
  const r1 = await call({ type: "thread", id: 50403507, pages: [thread1] });
  assert.ok(r1.lastVisit && r1.lastVisit.max > 0, "the earlier test's visit is remembered");
  assert.ok(r1.strands && Array.isArray(r1.strands.groups));
  assert.ok(typeof r1.bgMs === "number");
  await call({ type: "health-page", kind: "thread", ms: 200, bgMs: r1.bgMs });
  const hr = await call({ type: "health" });
  assert.ok(["healthy", "watch", "slow"].includes(hr.status));
  assert.ok(hr.pages.count >= 1);
  await call({ type: "lightest" });
  const s = (await local.get("settings")).settings;
  assert.equal(s.previews, false); assert.equal(s.karma, false); assert.equal(s.hnHistory, false); assert.equal(s.scoring.pages, 1);
  assert.deepEqual(await call({ type: "history", id: 50403507 }), { off: true });
  const sum = await call({ type: "summarise", id: 50403507, strand: r1.strands.groups[0]?.id || "s1" });
  assert.match(sum.error, /provider|strand/i);
});
