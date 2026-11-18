// Background page: all network calls, all scoring and all state changes happen here. The pages on
// Hacker News, the digest and the settings page only send messages, so keys never leave this origin.
import { api, getState as readState, save, patchSettings, cacheGet, cachePut, addUsage, todayUsage, today } from "./lib/store.js";
import { bigGet, bigSet, flush, migrateFromLocal, setRider, setOnFlush, BIG_KEYS } from "./lib/idb.js";
import { renderThreadText } from "./lib/render.js";
import * as hist from "./lib/history.js";
import { emptyHealth, notePage, noteWrite, noteRequest, noteWake, report as healthReport } from "./lib/health.js";
import { mergePages, prepare, verdicts as commentVerdicts, fetchPages } from "./lib/thread.js";
import { TagGraph, buildState } from "./lib/graph.js";
import { SUMMARY_SCHEMA, SYSTEM_PROMPT, buildUserMessage, interestsText, normalise } from "./lib/summarise.js";
import { completeJSON, testKey, listModels, keySig, estimateTokens, isUsable } from "./lib/providers.js";
import { estimateCost } from "./lib/pricing.js";
import { fetchAllItems, saveBookmark } from "./lib/raindrop.js";
import { parseFront, mergeFront, groupDuplicates } from "./lib/front.js";
import { tokenize } from "./lib/tokenize.js";
import { domainOf } from "./lib/profile.js";
import { emptyPrefs, setPref, derivePrefs, reviewPref, dueLikes, likeScore, linkId } from "./lib/prefs.js";
import { makeBackup, readBackup, mergeBackup, toSyncChunks } from "./lib/backup.js";
import { scoreStories, RULES_VERSION, SCORING_DEFAULTS } from "./lib/score.js";
import { compileBlocklist, normaliseBlocklist, testBlocklist, suggestFromDismissals, DRAFT_PROMPT, DRAFT_SCHEMA } from "./lib/blocklist.js";
import { buildProfile, bookmarkTreeToItems, parseHnList } from "./lib/profile.js";
import { parsePreview, quickPreview, slimPreview, safeDecode } from "./lib/preview.js";

const HN = "https://news.ycombinator.com/";
const parseDoc = (html) => new DOMParser().parseFromString(html, "text/html");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The last few analysed threads, so Summarise does not parse a thread twice. Kept small on purpose.
const prepared = new Map(); // thread id -> { thread, prep }
const PREPARED_MAX = 4;
function remember(id, entry) {
  prepared.delete(id);
  prepared.set(id, entry);
  while (prepared.size > PREPARED_MAX) prepared.delete(prepared.keys().next().value);
}
let karmaWaitMs = 0, historyDownUntil = 0;
let lastFront = null;        // the most recent front page from page 1 ({ stories, at, pages }), for the digest and blocklist tests

// Large keys move out of storage.local into IndexedDB the first time 0.6 runs.
const ready = migrateFromLocal(api.storage.local).catch((e) => { logError("migrate", e?.message || e); });

// Removed in 0.7: the GitHub gist backup (its token) and the browser-history source. Clean up after them.
ready.then(async () => {
  const { gist, settings } = await api.storage.local.get(["gist", "settings"]);
  if (gist) await api.storage.local.remove(["gist", "pendingTeach"]);
  if (settings?.sources && "history" in settings.sources) { const { history: _gone, ...sources } = settings.sources; await patchSettings({ sources }); }
  await api.permissions.remove({ origins: ["https://api.github.com/*", "https://gist.githubusercontent.com/*"], permissions: [] }).catch(() => {});
}).catch(() => {});

// ---- health (Settings, Health) ----
// Counters in memory; saved only when something else is written to IndexedDB (the "rider").
let healthMemo = null;
const healthReady = ready.then(() => bigGet("health")).then((h) => { healthMemo = h?.v === 1 ? h : emptyHealth(); noteWake(healthMemo); setRider("health", () => healthMemo); }).catch(() => { healthMemo = emptyHealth(); });
setOnFlush(() => H((h) => noteWrite(h, "idb", 0))); // counted, not sized: sizing would cost a serialisation
const H = (fn) => { if (healthMemo) try { fn(healthMemo); } catch { /* never let counting break work */ } };
// Every request the background makes is counted by host.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, opts) => {
  let host = "other";
  try { host = new URL(typeof url === "string" ? url : url.url).hostname; } catch { /* keep "other" */ }
  return realFetch(url, opts).then((r) => { H((h) => noteRequest(h, host, r.ok)); return r; }, (e) => { H((h) => noteRequest(h, host, false)); throw e; });
};

// The interest profile changes only on sync; it is read once and kept in memory.
let profileMemo;
async function getState() {
  await ready;
  const s = await readState({ withProfile: false });
  if (profileMemo === undefined) profileMemo = (await api.storage.local.get("profile")).profile || null;
  s.profile = profileMemo;
  return s;
}

// The tag graph (several MB) lives in IndexedDB and stays compiled in memory. What you taught it
// (per-tag adjustments and mutes) is small and lives apart, in storage.local as "teach", so a thumb
// writes a few hundred bytes instead of the whole graph, and Firefox Sync can carry it.
let graphMemo = null;
async function loadGraph() {
  if (graphMemo) return graphMemo.g;
  await ready;
  const [graph, { teach }] = await Promise.all([bigGet("graph"), api.storage.local.get("teach")]);
  if (graph && teach) { graph.adj = teach.adj || {}; graph.muted = teach.muted || []; }
  else if (graph && (Object.keys(graph.adj || {}).length || graph.muted?.length)) save({ teach: { adj: graph.adj, muted: graph.muted || [] } }).catch(() => {}); // from 0.5
  graphMemo = { g: graph ? new TagGraph(graph) : null };
  return graphMemo.g;
}
api.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  H((h) => { for (const k of Object.keys(ch)) noteWrite(h, "local", k === "hnLogin" ? 0 : JSON.stringify(ch[k].newValue ?? null).length); });
  // Large keys written to storage.local by older code or a test move into IndexedDB as they arrive.
  if (BIG_KEYS.some((k) => ch[k]?.newValue != null)) migrateFromLocal(api.storage.local, { overwrite: true }).then((keys) => { if (keys.includes("graph")) { graphMemo = null; prepared.clear(); } }).catch(() => {});
  if (ch.profile) profileMemo = undefined;
  if (ch.settings || ch.blocklist || ch.dismissed || ch.profile) prepared.clear();
});
const teachOf = (g) => ({ adj: g.state.adj || {}, muted: g.state.muted || [] });
async function saveTeach(g) { await save({ teach: teachOf(g) }); }
async function saveGraph(g) { graphMemo = { g }; await bigSet("graph", g.toJSON(), { now: true }); await saveTeach(g); }

function activeProvider(state, providerId, model) {
  const id = providerId || state.settings.active.providerId;
  const p = state.providers.find((x) => x.id === id);
  if (!p) throw new Error("Choose a provider and model first (Hamsa settings).");
  const m = model || state.settings.active.model || p.models?.[0];
  if (!m) throw new Error("Choose a model for this provider (Hamsa settings).");
  return { p, m };
}

// ---- front page ----
async function loadPrefs() {
  const { prefs } = await api.storage.local.get("prefs");
  return prefs?.items ? prefs : emptyPrefs();
}

async function scoreFront(state, stories) {
  const graph = await loadGraph();
  const opened = await bigGet("opened");
  // Stories you upvoted on HN count as likes (never over your own thumbs).
  let prefs = await loadPrefs();
  const voted = stories.filter((st) => st.voted && prefs.items[String(st.id)]?.v !== "like");
  if (voted.length) {
    for (const st of voted) prefs = setPref(prefs, { id: st.id, kind: "story", title: st.title, domain: st.domain, url: st.url, threadId: st.id, points: st.points, author: st.by }, "like", "hn");
    await save({ prefs });
  }
  // Karma barely matters on the front page: only what is already cached is used, nothing is fetched.
  const karma = state.settings.karma === false ? null : await karmaFor([], 0);
  const memory = await bigGet("topics", []);
  const day = today();
  const v = scoreStories(stories, { topics: memory.map((m) => ({ ...m, firstSeenToday: (m.firstDay || day) === day && (m.days || 1) <= 1 })),
    graph, profile: state.profile, blocks: compileBlocklist(state.blocklist),
    scoring: state.settings.scoring, dismissed: state.dismissed.map((d) => d.id), opened, prefs: derivePrefs(prefs), karma,
  });
  // Duplicate submissions: the best-voted one leads, takes the best bucket and score of the group.
  const byId = new Map(v.map((x) => [x.id, x]));
  const RANK = { keep: 0, stretch: 1, maybe: 2, toss: 3 };
  for (const g of groupDuplicates(stories)) {
    const lead = byId.get(g[0]);
    const all = g.map((id) => byId.get(id));
    const best = all.slice().sort((a, b) => RANK[a.bucket] - RANK[b.bucket] || b.score - a.score)[0];
    if (best !== lead && !lead.dismissed && !lead.blocked) { lead.bucket = best.bucket; lead.score = best.score; lead.total = best.total; lead.reasons = best.reasons; lead.tags = best.tags; }
    lead.dups = g.slice(1);
    for (const x of all.slice(1)) x.dupOf = lead.id;
  }
  rememberTopics(memory, v.topics || []).catch(() => {});
  return { verdicts: v, topics: v.topics || [], ready: !!(graph?.size || state.profile) };
}

// Topics seen on the front page, kept for 30 days, so a topic can be told apart as new today or returning.
async function rememberTopics(memory, seen) {
  if (!seen.length) return;
  const day = today(), now = Date.now();
  const list = memory.slice();
  for (const t of seen) {
    const hit = list.find((m) => t.terms.filter((x) => m.terms.includes(x)).length >= 2);
    if (hit) {
      if (hit.lastDay !== day) { hit.days = (hit.days || 1) + 1; hit.lastDay = day; }
      hit.last = now; hit.label = t.label;
      hit.terms = [...new Set([...t.terms, ...hit.terms])].slice(0, 16);
    } else if (t.terms.length >= 2) list.push({ terms: t.terms.slice(0, 16), label: t.label, first: now, firstDay: day, last: now, lastDay: day, days: 1 });
  }
  const fresh = list.filter((m) => now - m.last < 30 * 864e5).sort((a, b) => b.last - a.last).slice(0, 500);
  await bigSet("topics", fresh);
}

// ---- reading log: what you open, kept in this browser ----
const emptyOpened = () => ({ domains: {}, titles: [], tags: {} });
async function doOpened({ entry }) {
  const { settings = {} } = await api.storage.local.get("settings");
  if (settings.readingLog === false || !entry) return { ok: true, logged: false };
  const readingLog = await bigGet("readingLog", []);
  const opened = (await bigGet("opened")) || emptyOpened();
  const e = { at: Date.now(), kind: entry.kind, id: entry.id || null, title: String(entry.title || "").slice(0, 300), url: entry.url || null, domain: entry.domain || (entry.url ? domainOf(entry.url) : null), tags: (entry.tags || []).slice(0, 6), score: entry.score ?? null, bucket: entry.bucket || null, rules: RULES_VERSION, page: entry.page || null, background: !!entry.background, strand: entry.strand ? { kind: String(entry.strand.kind || ''), label: String(entry.strand.label || '').slice(0, 80), terms: (entry.strand.terms || []).slice(0, 6) } : null };
  readingLog.unshift(e);
  if (e.domain && e.kind !== "thread") opened.domains[e.domain] = (opened.domains[e.domain] || 0) + 1;
  for (const t of e.tags) opened.tags[t] = (opened.tags[t] || 0) + 1;
  if (e.title && (e.kind === "story" || e.kind === "thread") && !opened.titles.some((x) => x.id === e.id)) {
    opened.titles.unshift({ id: e.id, title: e.title, terms: [...new Set(tokenize(e.title))] });
    opened.titles = opened.titles.slice(0, 400);
  }
  await bigSet("readingLog", readingLog.slice(0, 5000));
  await bigSet("opened", opened, { now: true }); // an open often comes just before the page goes away
  return { ok: true, logged: true };
}

async function doOpenTab({ url, active, entry }) {
  if (!/^https?:/i.test(url || "")) throw new Error("Only web links can be opened.");
  await api.tabs.create({ url, active: !!active });
  if (entry) await doOpened({ entry: { ...entry, background: !active } });
  return { ok: true };
}

// Stories you were shown, so the export has negatives as well as what you opened.
async function recordImpressions(stories, verdicts) {
  const impressions = await bigGet("impressions", {});
  const now = Date.now();
  stories.forEach((st, i) => {
    const v = verdicts[i];
    const prev = impressions[st.id];
    impressions[st.id] = { id: st.id, title: st.title, url: st.url, domain: st.domain, points: st.points, comments: st.comments, tags: v.tags, score: v.score, bucket: v.bucket, rules: RULES_VERSION, first: prev?.first || now, last: now, seen: (prev?.seen || 0) + 1 };
  });
  const keep = Object.values(impressions).sort((a, b) => b.last - a.last).slice(0, 3000);
  await bigSet("impressions", Object.fromEntries(keep.map((x) => [x.id, x])));
}

// One JSON object per line: every story you were shown or opened, with what Hamsa scored and what you did.
async function doExportLog() {
  const impressions = await bigGet("impressions", {}), readingLog = await bigGet("readingLog", []);
  const { dismissed = [] } = await api.storage.local.get("dismissed");
  const opens = new Map();
  for (const e of readingLog) if (e.id) { const o = opens.get(e.id) || []; o.push(e); opens.set(e.id, o); }
  const gone = new Set(dismissed.map((d) => d.id));
  const rows = Object.values(impressions).map((x) => {
    const o = opens.get(x.id) || [];
    return { schema: "hamsa.reading/1", id: x.id, title: x.title, url: x.url, domain: x.domain, points: x.points, comments: x.comments, tags: x.tags, score: x.score, bucket: x.bucket, rules: x.rules, first_seen: new Date(x.first).toISOString(), times_seen: x.seen, opened: o.length > 0, opened_story: o.some((e) => e.kind === "story"), opened_thread: o.some((e) => e.kind === "thread"), dismissed: gone.has(x.id) };
  });
  const seen = new Set(rows.map((r) => r.id));
  for (const e of readingLog) if (!e.id || !seen.has(e.id)) rows.push({ schema: "hamsa.reading/1", kind: e.kind, id: e.id, title: e.title, url: e.url, domain: e.domain, tags: e.tags, score: e.score, bucket: e.bucket, rules: e.rules, opened: true, opened_at: new Date(e.at).toISOString(), page: e.page });
  return { jsonl: rows.map((r) => JSON.stringify(r)).join("\n"), rows: rows.length, opens: readingLog.length };
}

async function doFront({ pages, path = "/" }) {
  const state = await getState();
  const merged = mergeFront(pages.map((h) => parseFront(parseDoc(h))));
  if (merged.me && merged.me !== state.settings.hnUser) await patchSettings({ hnUser: merged.me });
  // Only the real front page, read from page 1, may stand in for the digest's own reading
  // (not /newest, /ask, /show, a past day or a later page).
  if (/^\/(news)?(\?p=1)?$/.test(path)) lastFront = { stories: merged.stories, at: Date.now(), pages: pages.length };
  const { verdicts, ready, topics } = await scoreFront(state, merged.stories);
  if (state.settings.readingLog !== false) recordImpressions(merged.stories, verdicts).catch(() => {});
  const counts = { keep: 0, maybe: 0, stretch: 0, toss: 0 };
  for (const x of verdicts) counts[x.bucket]++;
  const graph = await loadGraph();
  return {
    stories: merged.stories, verdicts, counts, ready, me: merged.me, topics,
    rules: RULES_VERSION, scoring: state.settings.scoring,
    sources: sourceStatus(state, graph),
    suggestions: suggestFromDismissals(state.dismissed, state.blocklist, { ownTags: graph ? graph.tagNames() : [] }),
    usage: await todayUsage(),
  };
}

function sourceStatus(state, graph) {
  const s = state.settings.sources, src = state.profile?.sources || {};
  return [
    { id: "raindrop", name: "Raindrop tags", on: s.raindrop && !!state.raindropToken, n: src.raindrop?.items },
    { id: "hnfav", name: "HN favourites", on: s.hnfav, n: src.hnfav?.items },
    { id: "bookmarks", name: "Browser bookmarks", on: s.bookmarks, n: src.bookmarks?.items },
    { id: "graph", name: "Tags in use", on: !!graph?.size, n: graph?.size || 0 },
  ];
}

async function doDismiss({ story, undo }) {
  const { dismissed = [] } = await api.storage.local.get("dismissed");
  let next = dismissed.filter((d) => d.id !== story.id);
  if (!undo) next = [{ id: story.id, title: story.title, domain: story.domain, at: Date.now() }, ...next].slice(0, 500);
  await save({ dismissed: next });
  const state = await getState();
  const graph = await loadGraph();
  return { ok: true, suggestions: suggestFromDismissals(next, state.blocklist, { ownTags: graph ? graph.tagNames() : [] }) };
}

// ---- thread page ----
// Author karma from HN's public API, cached for a week. Fetched within a time budget so a page never
// waits long; whatever is still missing keeps loading and is used next time.
const KARMA_TTL = 7 * 864e5, KARMA_MAX = 6000, VISITS_MAX = 500;
let karmaMemo = null;
async function karmaFor(users, budgetMs = 1200, max = 60) {
  if (!karmaMemo) karmaMemo = (await bigGet("karma")) || {};
  const now = Date.now();
  const want = [...new Set(users.filter(Boolean))].filter((u) => !karmaMemo[u] || now - karmaMemo[u][1] > KARMA_TTL).slice(0, max);
  const known = () => Object.fromEntries(Object.entries(karmaMemo).map(([u, [k]]) => [u, k]));
  if (!want.length || budgetMs <= 0) return known();
  const one = async (u) => {
    try {
      const r = await fetch(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(u)}/karma.json`, { credentials: "omit" });
      if (r.ok) { const k = await r.json(); if (typeof k === "number") karmaMemo[u] = [k, Date.now()]; }
    } catch { /* offline or blocked: karma is a small signal */ }
  };
  const run = (async () => {
    for (let i = 0; i < want.length; i += 12) await Promise.all(want.slice(i, i + 12).map(one));
    const keep = Object.entries(karmaMemo).sort((a, b) => b[1][1] - a[1][1]).slice(0, KARMA_MAX);
    karmaMemo = Object.fromEntries(keep);
    await bigSet("karma", karmaMemo);
  })();
  await Promise.race([run, sleep(budgetMs)]);
  return known();
}

async function analyse(id, pages) {
  const state = await getState();
  const graph = await loadGraph();
  const html = pages?.length ? pages : await fetchPages(id, { parseDoc });
  const thread = mergePages(html, parseDoc);
  // Karma for at most 60 new authors per thread, top-level comments first: it is a small signal.
  const authors = thread.comments.filter((c) => c.status === "ok").sort((a, b) => (a.depth || 0) - (b.depth || 0)).map((c) => c.author);
  const tk = performance.now();
  const karma = state.settings.karma === false ? null : await karmaFor(authors);
  karmaWaitMs = Math.round(performance.now() - tk); // network waiting, not Hamsa's work (Health subtracts it)
  const prep = prepare(thread, graph, { budgetTokens: state.settings.budgetTokens, scoring: state.settings.scoring, gate: state.settings.gate, karma, mutedKinds: state.settings.mutedKinds || [] });
  let prefs0 = null;
  const mine = thread.comments.filter((c) => c.my_vote);
  if (mine.length) prefs0 = await loadPrefs();
  const fresh = mine.filter((c) => { const x = prefs0?.items[String(c.id)]; return !x || (x.source === "hn" && x.v !== (c.my_vote === "up" ? "like" : "dislike")); });
  if (fresh.length) {
    let prefs = prefs0;
    for (const c of fresh) prefs = setPref(prefs, { id: c.id, kind: "comment", title: c.text.slice(0, 160), excerpt: c.text.slice(0, 300), author: c.author, threadId: id, threadTitle: thread.story.title, url: `${HN}item?id=${c.id}`, links: c.links || [], tags: (c.verdict?.reasons || []).filter((r) => r.kind === "tag").map((r) => r.tag) }, c.my_vote === "up" ? "like" : "dislike", "hn");
    await save({ prefs });
  }
  remember(id, { thread, prep });
  return { state, graph, thread, prep };
}

async function doThread({ id, pages }) {
  const { state, graph, thread, prep } = await analyse(id, pages);
  const stats = prep.result.stats;
  let estimate = null, model = null;
  try {
    const { p, m } = activeProvider(state);
    if (isUsable(p)) {
      const interests = interestsText(graph, state.settings.extraInterests);
      const input = prep.tokens + estimateTokens(SYSTEM_PROMPT + interests + JSON.stringify(SUMMARY_SCHEMA));
      estimate = { input, output: state.settings.maxOutputTokens, ...estimateCost(m, input, state.settings.maxOutputTokens, { fx: state.settings.fx, overrides: state.settings.priceOverrides, baseUrl: p.baseUrl }) };
      model = { provider: p.name, model: m };
    }
  } catch { /* no provider yet */ }
  const cached = await cacheGet(id);
  const prefs = await loadPrefs();
  // New since your last visit: HN comment ids only grow, so the highest id you saw is all we keep.
  const visits = { ...(await bigGet("visits", {})) };
  const lastVisit = visits[id] || null;
  const maxId = thread.comments.reduce((m, c) => Math.max(m, c.id || 0), 0);
  visits[id] = { max: Math.max(maxId, lastVisit?.max || 0), at: Date.now() };
  const keepVisits = Object.entries(visits).sort((a, b) => b[1].at - a[1].at).slice(0, VISITS_MAX);
  await bigSet("visits", Object.fromEntries(keepVisits));
  return {
    id, title: thread.story.title, domain: thread.story.link_domain, points: thread.story.points, author: thread.story.author,
    funnel: prep.funnel, dropped: { unavailable: stats.unavailable, ...stats.pruned }, tokens: prep.tokens, context: thread.story.context,
    storyPref: prefs.items[String(id)]?.v || null,
    verdicts: commentVerdicts(thread), strands: prep.strands, prefs: Object.fromEntries(thread.comments.filter((c) => prefs.items[String(c.id)]?.kind === "comment").map((c) => [String(c.id), prefs.items[String(c.id)].v])), threadRelevance: Math.round(prep.threadRelevance * 100) / 100,
    graphReady: !!graph?.size, estimate, model, rules: RULES_VERSION, lastVisit,
    cached: cached && cached.rules === RULES_VERSION ? { ...cached, fromCache: true } : null,
    usage: await todayUsage(),
  };
}

// For each point: the tags that fired on the comments it cites, and the strongest score among them.
function annotate(summary, comments) {
  const byPath = new Map(comments.map((c) => [c.path, c]));
  for (const pt of summary.points) {
    const tags = new Map();
    let best = 0;
    for (const r of pt.refs) {
      const c = byPath.get(r);
      if (!c) continue;
      best = Math.max(best, c.verdict?.score ?? 0);
      for (const t of c.relevance?.tags || []) if (!t.via) tags.set(t.tag, Math.max(tags.get(t.tag) || 0, t.a));
    }
    pt.tags = [...tags].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
    pt.rel = Math.round(best * 100) / 100;
  }
}

async function doSummarise({ id, pages, providerId, model, force, strand }) {
  const key = strand ? `${id}:${strand}` : id;
  if (!force) {
    const hit = await cacheGet(key);
    if (hit && hit.rules === RULES_VERSION) return { ...hit, fromCache: true };
  }
  const state = await getState();
  const { p, m } = activeProvider(state, providerId, model);
  // The page sends the HTML it already holds, so a background page that Firefox unloaded in the
  // meantime does not read the thread from HN again.
  const entry = prepared.get(id) || (await analyse(id, pages), prepared.get(id));
  const graph = await loadGraph();
  const interests = interestsText(graph, state.settings.extraInterests);
  // A strand summary sends only that strand's comments (those that survived the crust rules).
  let text = entry.prep.threadText, tokens = entry.prep.tokens, kept = entry.prep.result.kept;
  if (strand) {
    const s = entry.prep.strands.groups.find((g) => g.id === strand);
    if (!s) throw new Error("That strand is not in this thread any more. Reload the page.");
    const ids = new Set(s.ids);
    kept = entry.thread.comments.filter((c) => ids.has(c.id) && (!c.dropped || c.dropped === "below_floor" || c.dropped === "budget"));
    text = renderThreadText(entry.thread, kept, entry.prep.result.stats, entry.prep.result.config);
    tokens = estimateTokens(text);
  }
  const user = buildUserMessage(text, interests);
  const estimateIn = tokens + estimateTokens(SYSTEM_PROMPT + interests + JSON.stringify(SUMMARY_SCHEMA));
  const out = await completeJSON({ provider: p, model: m, system: SYSTEM_PROMPT, user, schema: SUMMARY_SCHEMA, maxTokens: state.settings.maxOutputTokens });
  const { summary, known, words, bad_refs } = normalise(out.object, entry.thread.comments);
  if (!summary.points.length && !summary.gist) throw new Error("The model returned an empty summary. Try again or choose another model.");
  annotate(summary, kept);
  const cost = estimateCost(m, out.usage.input, out.usage.output, { fx: state.settings.fx, overrides: state.settings.priceOverrides, baseUrl: p.baseUrl });
  await addUsage(p.name, m, out.usage.input, out.usage.output, cost.usd || 0);
  const result = {
    id, title: entry.thread.story.title, link: entry.thread.story.link_url, summary, ids: Object.fromEntries(known), words, bad_refs,
    provider: p.name, model: m, mode: out.mode, usage: out.usage, estimateIn, cost, rules: RULES_VERSION,
    funnel: entry.prep.funnel, at: Date.now(), strand: strand || null,
  };
  await cachePut(key, result);
  return { ...result, today: await todayUsage() };
}

// ---- learning ----
async function doFeedback(msg) {
  const state = await getState();
  const g = await loadGraph();
  if (!g) throw new Error("Sync your interest sources first (Hamsa settings).");
  if (state.settings.learning === "off") return { ok: true, note: "Learning is off." };
  let note = "";
  switch (msg.kind) {
    case "thumb": {
      const delta = msg.dir === "up" ? 0.3 : -0.3;
      g.nudge(msg.tags || [], delta);
      note = `${msg.dir === "up" ? "Stronger" : "Weaker"}: ${(msg.tags || []).join(", ") || "no tags fired"}`;
      break;
    }
    case "tag":
      if (msg.action === "boost") g.boost(msg.tag);
      else if (msg.action === "mute") g.mute(msg.tag);
      else g.reset(msg.tag);
      note = `${msg.tag}: ${msg.action === "boost" ? "boosted" : msg.action === "mute" ? "muted" : "back to neutral"}`;
      break;
    case "implicit":
      g.nudge(msg.tags || [], msg.delta || 0.1);
      note = `Noted interest in ${(msg.tags || []).join(", ")}`;
      break;
  }
  // Adjustments and mutes are read when scoring, so no recompile is needed (it cost ~0.75 s).
  await saveTeach(g);
  prepared.clear();
  return { ok: true, note };
}

async function doSavePoint({ id, title, tags, point }) {
  const state = await getState();
  const g = await loadGraph();
  if (state.raindropToken) await saveBookmark(state.raindropToken, { link: `${HN}item?id=${id}`, title: `HN: ${title}`, tags: (tags || []).slice(0, 5), note: point || "" });
  if (g) {
    g.add({ title, excerpt: point || "", tags: tags || [], created: new Date().toISOString() });
    g.nudge(tags || [], 0.2);
    await saveGraph(g);
  }
  return { ok: true, saved: !!state.raindropToken, note: state.raindropToken ? `Saved to Raindrop with tags ${(tags || []).join(", ")}` : "No Raindrop token set; the interest was still counted." };
}

// ---- interest sources ----
const progress = (source, n) => api.runtime.sendMessage({ type: "sync-progress", source, n }).catch(() => {});

async function hnList(kind, user, max = 15) {
  const out = [];
  let url = `${HN}${kind}?id=${encodeURIComponent(user)}`;
  for (let i = 0; i < max && url; i++) {
    const res = await fetch(url, { credentials: kind === "upvoted" ? "include" : "omit" });
    if (!res.ok) break;
    const { items, more } = parseHnList(parseDoc(await res.text()));
    out.push(...items);
    progress(kind, out.length);
    url = more ? new URL(more, HN).href : null;
    if (url) await sleep(700);
  }
  return out;
}

async function doSync() {
  const state = await getState();
  const s = state.settings.sources;
  const notes = [], sources = {};
  let items = [];
  if (s.raindrop && state.raindropToken) {
    let rd = await fetchAllItems(state.raindropToken, { onProgress: (n) => progress("raindrop", n) });
    if (!s.highlights) rd = rd.map((x) => ({ ...x, highlights: [] }));
    items.push(...rd);
    sources.raindrop = { items: rd.length, at: Date.now() };
  } else if (s.raindrop) notes.push("Raindrop is on but has no token.");
  if (s.bookmarks) {
    if (await api.permissions.contains({ permissions: ["bookmarks"] })) {
      const bm = bookmarkTreeToItems(await api.bookmarks.getTree());
      items.push(...bm);
      sources.bookmarks = { items: bm.length, at: Date.now() };
    } else notes.push("Browser bookmarks need permission: switch the source off and on again.");
  }
  const { importedItems = [] } = await api.storage.local.get("importedItems");
  if (importedItems.length) { items.push(...importedItems); sources.file = { items: importedItems.length, at: Date.now() }; }
  let favourites = [];
  if (s.hnfav) {
    if (!state.settings.hnUser) notes.push("HN favourites need your HN user name: open the HN front page while logged in, or type it in settings.");
    else {
      const fav = await hnList("favorites", state.settings.hnUser);
      const up = await hnList("upvoted", state.settings.hnUser).catch(() => []);
      favourites = [...fav, ...up];
      sources.hnfav = { items: favourites.length, favourites: fav.length, upvoted: up.length, at: Date.now() };
      if (!up.length) notes.push("Upvoted stories were not readable (log in to HN in this browser to include them).");
    }
  }
  const prev = await loadGraph();
  const gstate = buildState(items, { excluded: state.settings.excludedTags });
  if (prev) { gstate.adj = prev.state.adj; gstate.muted = prev.state.muted; } // keep what you taught it
  const { teach } = await api.storage.local.get("teach");
  if (teach && !prev) { gstate.adj = { ...(teach.adj || {}) }; gstate.muted = [...(teach.muted || [])]; }
  const profile = buildProfile({ items, favourites, sources });
  const g = new TagGraph(gstate);
  await saveGraph(g);
  await save({ profile, graphSyncedAt: Date.now() });
  profileMemo = profile;
  prepared.clear();
  await bigSet("digest", null);
  return { items: items.length, tags: g.size, domains: Object.keys(profile.domains).length, favourites: profile.fav.length, notes, top: g.topTags(30) };
}

async function doGraphInfo() {
  const state = await getState();
  const g = await loadGraph();
  const { graphSyncedAt } = await api.storage.local.get("graphSyncedAt");
  if (!g) return { ready: false, sources: sourceStatus(state, null) };
  return { ready: true, tags: g.size, items: g.state.n_items, syncedAt: graphSyncedAt || null, top: g.topTags(40).map((t) => ({ ...t, muted: g.isMuted(t.tag), adj: g.adj(t.tag) })), muted: g.state.muted, sources: sourceStatus(state, g), domains: Object.keys(state.profile?.domains || {}).length, favourites: state.profile?.fav?.length || 0 };
}

// ---- blocklist ----
async function doBlocklistSave({ blocklist }) {
  const bl = normaliseBlocklist(blocklist);
  await save({ blocklist: bl });
  return { ok: true, blocklist: bl };
}

async function doBlocklistDraft({ text }) {
  if (!String(text || "").trim()) throw new Error("Describe what you do not want to see first.");
  const state = await getState();
  const { p, m } = activeProvider(state);
  const out = await completeJSON({ provider: p, model: m, system: DRAFT_PROMPT, user: `What the reader does not want to see:\n${text}`, schema: DRAFT_SCHEMA, maxTokens: 900 });
  const cost = estimateCost(m, out.usage.input, out.usage.output, { fx: state.settings.fx, overrides: state.settings.priceOverrides, baseUrl: p.baseUrl });
  await addUsage(p.name, m, out.usage.input, out.usage.output, cost.usd || 0);
  const drafted = normaliseBlocklist({ groups: (out.object?.groups || []).map((g) => ({ ...g, enabled: false })) }, { source: "drafted" });
  return { groups: drafted.groups, usage: out.usage, cost, model: m };
}

async function frontStories(pagesWanted = 1) {
  if (lastFront && Date.now() - lastFront.at < 30 * 60e3 && lastFront.pages >= pagesWanted) return lastFront.stories;
  const pages = [];
  let url = `${HN}news`;
  for (let i = 0; i < pagesWanted && url; i++) {
    let res = await fetch(url, { credentials: "omit" }).catch(() => null);
    if (res?.status === 503) { await sleep(2500); res = await fetch(url, { credentials: "omit" }).catch(() => null); }
    // A page that fails ends the reading; what was read is used. Only a failed first page is an error.
    if (!res?.ok) { if (!pages.length) throw new Error(`Hacker News returned ${res ? res.status : "no answer"}.`); break; }
    const p = parseFront(parseDoc(await res.text()));
    pages.push(p);
    url = p.more ? new URL(p.more, HN).href : null;
    if (url && i + 1 < pagesWanted) await sleep(700);
  }
  const merged = mergeFront(pages).stories;
  lastFront = { stories: merged, at: Date.now(), pages: pages.length };
  return merged;
}

async function doBlocklistTest({ blocklist }) {
  const bl = normaliseBlocklist(blocklist);
  const stories = await frontStories(4);
  return { tested: stories.length, groups: testBlocklist({ ...bl, groups: bl.groups.map((g) => ({ ...g, enabled: true })) }, stories) };
}

// ---- digest ----
// The digest is built from your likes alone: likes due for another look (spaced repetition), today's
// stories that resemble what you liked, and everything you liked, by topic. No model.
async function buildDigest() {
  const state = await getState();
  const want = Math.max(1, Math.min(6, state.settings.scoring.pages || 4));
  const stories = await frontStories(want); // reuses the front page you just read, if fresh
  const { verdicts } = await scoreFront(state, stories);
  const tagsById = new Map(verdicts.map((v) => [v.id, v.tags || []]));
  const slim = stories.map((st) => ({ id: st.id, title: st.title, url: st.url, domain: st.domain, points: st.points, comments: st.comments, by: st.by, ageText: st.ageText }));
  const digest = { date: today(), built_at: Date.now(), stories: slim, tags: Object.fromEntries(tagsById), pages: want, rules: RULES_VERSION, schema: 2 };
  await bigSet("digest", digest);
  return digest;
}

function likeLibrary(prefs) {
  const liked = Object.entries(prefs.items || {}).filter(([, x]) => x.v === "like").map(([id, x]) => ({ id, ...x }));
  const out = {};
  for (const kind of ["story", "comment", "link"]) {
    const items = liked.filter((x) => (x.kind || "story") === kind).sort((a, b) => b.at - a.at);
    const groups = new Map();
    for (const x of items) {
      const key = x.tags?.[0] || (kind === "comment" ? x.threadTitle : x.domain) || "Other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(x);
    }
    let list = [...groups].map(([label, xs]) => ({ label, items: xs })).sort((a, b) => b.items.length - a.items.length || b.items[0].at - a.items[0].at);
    if (list.length > 8) {
      const big = list.filter((g) => g.items.length > 1).slice(0, 10);
      const rest = list.filter((g) => !big.includes(g)).flatMap((g) => g.items).sort((a, b) => b.at - a.at);
      list = rest.length ? [...big, { label: "Everything else", items: rest }] : big;
    }
    out[kind] = { count: items.length, groups: list };
  }
  return out;
}

async function doDigest({ force }) {
  let digest = await bigGet("digest");
  if (force || !digest || digest.date !== today() || digest.rules !== RULES_VERSION || digest.schema !== 2) digest = await buildDigest();
  const prefs = await loadPrefs();
  const picks = likeScore(digest.stories, prefs, { tagsOf: (st) => digest.tags?.[st.id] || [] });
  const likes = Object.values(prefs.items).filter((x) => x.v === "like").length;
  return {
    date: digest.date, built_at: digest.built_at, pages: digest.pages, rules: RULES_VERSION, scanned: digest.stories.length,
    likes, due: dueLikes(prefs, Date.now(), 10), today: picks, library: likeLibrary(prefs), usage: await todayUsage(),
  };
}

// ---- providers ----
async function doTestKey({ id }) {
  const { providers } = await getState();
  const p = providers.find((x) => x.id === id);
  if (!p) throw new Error("Unknown provider.");
  const r = await testKey(p);
  const fresh = (await getState()).providers;
  const t = fresh.find((x) => x.id === id);
  if (t && keySig(t) === keySig(p)) { t.keyStatus = { ...r, at: Date.now(), sig: keySig(p) }; await save({ providers: fresh }); }
  let models = null;
  if (r.state === "ok" || r.state === "unverified") { try { models = await listModels(p); } catch { /* no list endpoint */ } }
  return { ...r, models };
}

async function doUiState() {
  const state = await getState();
  const s = state.settings;
  let model = null;
  try { const { p, m } = activeProvider(state); if (isUsable(p)) model = { provider: p.name, model: m, providerId: p.id }; } catch { /* none */ }
  const models = state.providers.filter(isUsable).flatMap((p) => (p.models || []).map((m) => ({ providerId: p.id, provider: p.name, model: m })));
  const pick = ["theme", "font", "titleFont", "textSize", "width", "justify", "density", "darkStyle", "skin", "layer", "order", "scoring", "hnUser", "learning", "fx", "linkTarget", "threadView", "threadSort", "collapseTossed", "readingLog", "previews", "previewImages", "quoteColours"];
  return { ...Object.fromEntries(pick.map((k) => [k, s[k]])), previewAllowed: await canPreview(), usage: await todayUsage(), model, models };
}

// ---- HN login ----
// hnLogin: { user, pass, auto, status: ok | bad | captcha | paused | error, at }. Read by no backup or
// sync. The page asks for the login when HN shows it logged out; the page itself posts HN's own login
// form (so the cookie lands exactly as when you log in by hand) and reports back. At most one try every
// five minutes, and none after a wrong password or a captcha until you save the login again.
const LOGIN_GAP = 5 * 60e3;
async function hnLogin() { return (await api.storage.local.get("hnLogin")).hnLogin || {}; }
// HN pages read only hnAuto ({ auto, status }), never the password itself.
async function saveLogin(l) { await save({ hnLogin: l, hnAuto: { auto: !!l.auto, status: l.status || null } }); }
// One login question at a time, so tabs restored together cannot each post the form.
let loginQueue = Promise.resolve();
const oneAtATime = (fn) => { const run = loginQueue.then(fn); loginQueue = run.catch(() => {}); return run; };
const fromHN = (sender) => /^https:\/\/news\.ycombinator\.com\//.test(sender?.url || sender?.tab?.url || "");

const handlers = {
  front: doFront,
  dismiss: doDismiss,
  thread: doThread,
  summarise: doSummarise,
  feedback: doFeedback,
  "save-point": doSavePoint,
  sync: doSync,
  "graph-info": doGraphInfo,
  "blocklist-save": doBlocklistSave,
  "blocklist-draft": doBlocklistDraft,
  "blocklist-test": doBlocklistTest,
  digest: doDigest,
  suggestions: async () => {
    const state = await getState();
    const g = await loadGraph();
    return { suggestions: suggestFromDismissals(state.dismissed, state.blocklist, { ownTags: g ? g.tagNames() : [] }) };
  },
  "test-key": doTestKey,
  "ui-state": doUiState,
  "prefs-clear": async () => { await save({ prefs: emptyPrefs() }); return { ok: true }; },
  "backup-export": doBackupExport,
  "backup-import": doBackupImport,
  "sync-firefox-now": async () => { const pull = await firefoxPull(); const push = await firefoxPush(); return { pull, push, info: await syncState() }; },
  "sync-info": async () => syncState(),
  opened: doOpened,
  previews: doPreviews,
  review: doReview,
  "preview-info": async () => { const c = await previewCache(); const { settings = {} } = await api.storage.local.get("settings"); return { allowed: await canPreview(), cached: Object.keys(c).length, on: settings.previews !== false, images: settings.previewImages !== false }; },
  "previews-clear": async () => { previewMemo = {}; await bigSet("previews", {}); return { ok: true }; },
  pref: async ({ item, value }) => {
    let prefs = await loadPrefs();
    const prev = prefs.items[String(item.id)]?.v || null;
    prefs = setPref(prefs, item, value, "you");
    await save({ prefs });
    // A thumb also teaches the tags that fired on the item (0.5 recorded thumbs without teaching).
    // Changing or clearing a thumb takes back what the earlier one taught.
    const pts = (v) => (v === "like" ? 0.3 : v === "dislike" ? -0.3 : 0);
    const delta = pts(value) - pts(prev);
    const { settings = {} } = await api.storage.local.get("settings");
    if (delta && item.tags?.length && settings.learning !== "off") {
      const g = await loadGraph();
      if (g) { g.nudge(item.tags, delta); await saveTeach(g); prepared.clear(); }
    }
    return { ok: true, counts: derivePrefs(prefs).counts };
  },
  "open-tab": doOpenTab,
  "export-log": doExportLog,
  "log-clear": async () => { await bigSet("readingLog", []); await bigSet("opened", emptyOpened()); await bigSet("impressions", {}, { now: true }); return { ok: true }; },
  "log-count": async () => ({ opened: (await bigGet("readingLog", [])).length, seen: Object.keys(await bigGet("impressions", {})).length }),
  "set-ui": async ({ patch }) => {
    const allowed = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => ["theme", "layer", "order", "active", "threadView", "threadSort", "collapseTossed", "linkTarget"].includes(k)));
    if (patch?.pages) {
      const { settings = {} } = await api.storage.local.get("settings");
      allowed.scoring = { ...SCORING_DEFAULTS, ...(settings.scoring || {}), pages: Math.max(1, Math.min(6, Number(patch.pages) || 5)) };
    }
    await patchSettings(allowed);
    return { ok: true };
  },
  "open-settings": async ({ section }) => {
    if (section && /^s-[a-z]+$/.test(section)) await api.tabs.create({ url: api.runtime.getURL(`options/options.html#${section}`) });
    else await api.runtime.openOptionsPage();
    return { ok: true };
  },
  "hn-login-state": async () => { const l = await hnLogin(); return { user: l.user || "", hasPass: !!l.pass, auto: !!l.auto, status: l.status || null, at: l.at || null }; },
  "hn-login-save": async ({ user, pass, auto }) => {
    const l = await hnLogin();
    await saveLogin({ ...l, user: String(user || l.user || "").trim(), pass: pass == null ? l.pass || "" : String(pass), auto: auto == null ? !!l.auto : !!auto, status: null, at: 0 });
    return { ok: true };
  },
  // Asked by an HN page that shows you logged out. Only pages on news.ycombinator.com get an answer.
  "hn-login-ask": async (_msg, sender) => oneAtATime(async () => {
    const l = await hnLogin();
    if (!fromHN(sender) || !l.auto || !l.user || !l.pass) return { go: false };
    if (["bad", "captcha", "paused"].includes(l.status)) return { go: false, status: l.status };
    if (Date.now() - (l.at || 0) < LOGIN_GAP) return { go: false, status: "wait" };
    await saveLogin({ ...l, at: Date.now() });
    return { go: true, acct: l.user, pw: l.pass };
  }),
  "hn-login-result": async ({ status }, sender) => {
    if (!fromHN(sender)) return { ok: false };
    const l = await hnLogin();
    if (["ok", "bad", "captcha", "paused", "error"].includes(status)) await saveLogin({ ...l, status, at: status === "paused" ? l.at : Date.now() });
    return { ok: true };
  },
  // ---- health ----
  // One batched write per page view keeps the counters (Firefox may unload the background soon after).
  "health-page": async ({ kind, ms, bgMs }) => { await healthReady; H((h) => notePage(h, { kind, ms, bg: bgMs })); if (healthMemo) await bigSet("health", healthMemo); return { ok: true }; },
  health: async () => {
    await healthReady;
    const local = await api.storage.local.get(null);
    const localBytes = new TextEncoder().encode(JSON.stringify(local)).length;
    const est = await navigator.storage?.estimate?.().catch(() => null);
    return healthReport(healthMemo, { storage: { localBytes, totalBytes: est?.usage ?? null } });
  },
  "health-reset": async () => { healthMemo = emptyHealth(); await bigSet("health", healthMemo); return { ok: true }; },
  // Lightest mode: everything optional that costs requests or work, off in one go.
  lightest: async () => {
    const { settings = {} } = await api.storage.local.get("settings");
    await patchSettings({ previews: false, karma: false, hnHistory: false, scoring: { ...(settings.scoring || {}), pages: 1 } });
    return { ok: true };
  },
  // ---- HN history (Algolia), only when switched on and permitted ----
  history: async ({ id }) => {
    const { settings = {} } = await api.storage.local.get("settings");
    if (!settings.hnHistory) return { off: true };
    if (!(await api.permissions.contains({ origins: ["https://hn.algolia.com/*"] }))) return { off: true, permission: true };
    const entry = prepared.get(id);
    if (!entry) return { error: "Open the thread again to look up its history." };
    const all = { ...(await bigGet("history", {})) };
    const cached = all[id];
    const fresh = (part, ttl) => cached?.[part] && Date.now() - cached[part].at < ttl;
    const story = { url: entry.thread.story.link_url, title: entry.thread.story.title };
    const strands = entry.prep.strands.groups;
    const terms = new Set([...tokenize(story.title), ...strands.flatMap((g) => g.terms.flatMap((t) => tokenize(t)))].filter((t) => t.length > 2));
    const graph = await loadGraph();
    const urls = hist.urls(story, strands);
    const out = { ...(cached || {}) };
    // If HN search was unreachable, wait an hour before trying again; the failure is logged once.
    if (historyDownUntil > Date.now()) return { same: out.same?.items || [], similar: out.similar?.items || [], down: true };
    const get = async (u) => { const r = await fetch(u, { credentials: "omit" }); if (!r.ok) throw new Error(`HN search returned ${r.status}.`); return r.json(); };
    const [a, b] = await Promise.allSettled([
      urls.same && !fresh("same", hist.HISTORY_TTL.same) ? get(urls.same) : null,
      urls.similar && !fresh("similar", hist.HISTORY_TTL.similar) ? get(urls.similar) : null,
    ]);
    if (a.status === "fulfilled" && a.value) out.same = { at: Date.now(), items: hist.stories(a.value, { selfId: id, threadTerms: terms, graph, min: 0 }) };
    if (b.status === "fulfilled" && b.value) out.similar = { at: Date.now(), items: hist.stories(b.value, { selfId: id, threadTerms: terms, graph }).filter((x) => !(out.same?.items || []).some((y) => y.id === x.id)) };
    const failed = [a, b].find((x) => x.status === "rejected");
    if (failed) { historyDownUntil = Date.now() + 3600e3; logError("history", `HN search unreachable: ${failed.reason?.message || failed.reason}`); }
    all[id] = out;
    const keep = Object.entries(all).sort((a, b) => (b[1].similar?.at || 0) - (a[1].similar?.at || 0)).slice(0, 200);
    await bigSet("history", Object.fromEntries(keep));
    return { same: out.same?.items || [], similar: out.similar?.items || [], query: hist.similarQuery(story.title, strands) };
  },
  // The page sends the strand's words, so this works after Firefox unloads the background page.
  "history-strand": async ({ id, strand, terms: sent }) => {
    const { settings = {} } = await api.storage.local.get("settings");
    if (!settings.hnHistory || !(await api.permissions.contains({ origins: ["https://hn.algolia.com/*"] }))) return { off: true };
    if (historyDownUntil > Date.now()) return { error: "HN search is unreachable at the moment. Hamsa will try again in an hour." };
    const s = prepared.get(id)?.prep.strands.groups.find((g) => g.id === strand) || (Array.isArray(sent) && sent.length ? { terms: sent.slice(0, 6).map(String) } : null);
    if (!s) return { error: "Open the thread again to look up this strand." };
    const all = { ...(await bigGet("history", {})) };
    const hit = all[id]?.strands?.[strand];
    if (hit && Date.now() - hit.at < hist.HISTORY_TTL.strand) return { items: hit.items };
    const r = await fetch(hist.strandUrl(s), { credentials: "omit" }).catch(() => null);
    if (!r?.ok) { historyDownUntil = Date.now() + 3600e3; logError("history", `HN search unreachable (${r ? r.status : "no answer"})`); return { error: "HN search is unreachable at the moment. Hamsa will try again in an hour." }; }
    const terms = new Set(s.terms.flatMap((t) => tokenize(t)));
    const items = hist.comments(await r.json(), { selfId: id, threadTerms: terms, graph: await loadGraph() });
    all[id] = { ...(all[id] || {}), strands: { ...(all[id]?.strands || {}), [strand]: { at: Date.now(), items } } };
    await bigSet("history", all);
    return { items };
  },
  "open-digest": async () => { await api.tabs.create({ url: api.runtime.getURL("digest/digest.html") }); return { ok: true }; },
};

// ---- link previews ----
// What a linked page says about itself (title, description, image, site), read from the first 512 KB of
// its HTML with no cookies and no scripts run. Needs the optional "all sites" permission. Cached 14 days.
const PREVIEW_TTL = 14 * 864e5, PREVIEW_MAX = 1500, PREVIEW_BYTES = 512 * 1024;
let previewMemo = null, previewSaveTimer = null;
const previewFlight = new Map();
async function previewCache() {
  if (!previewMemo) previewMemo = (await bigGet("previews")) || {};
  return previewMemo;
}
function savePreviewsSoon() {
  clearTimeout(previewSaveTimer);
  previewSaveTimer = setTimeout(async () => {
    const list = Object.entries(previewMemo || {}).sort((a, b) => b[1].at - a[1].at).slice(0, PREVIEW_MAX);
    previewMemo = Object.fromEntries(list);
    await bigSet("previews", previewMemo).catch(() => {});
  }, 3000);
}
async function canPreview() {
  try { return await api.permissions.contains({ origins: ["<all_urls>"] }); } catch { return false; }
}
async function readCapped(res) {
  if (!res.body?.getReader) return (await res.text()).slice(0, PREVIEW_BYTES);
  const reader = res.body.getReader();
  const chunks = []; let n = 0;
  while (n < PREVIEW_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); n += value.length;
    // The head is all a preview needs; stop once it has closed.
    if (n > 32768 && new TextDecoder().decode(value).includes("</head>")) break;
  }
  reader.cancel().catch(() => {});
  const buf = new Uint8Array(n); let o = 0;
  for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, n - o)), o); o += c.length; if (o >= n) break; }
  return new TextDecoder().decode(buf);
}
async function fetchPreview(url) {
  const quick = quickPreview(url);
  if (quick?.skip || quick?.error) return quick;
  if (quick && !quick.needsTitle) return quick;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    if (quick?.needsTitle) {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { credentials: "omit", signal: ctl.signal });
      const j = r.ok ? await r.json() : {};
      return { ...quick, needsTitle: undefined, title: j.title || "YouTube video", author: j.author_name || null };
    }
    const res = await fetch(url, { credentials: "omit", redirect: "follow", signal: ctl.signal, headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" } });
    const type = res.headers.get("content-type") || "";
    if (/application\/pdf/.test(type)) return { url, kind: "pdf", site: new URL(res.url || url).hostname.replace(/^www\./, ""), title: safeDecode(new URL(url).pathname.split("/").pop() || "PDF"), description: "PDF document" };
    if (/^image\//.test(type)) return { url, kind: "image", image: url, site: new URL(url).hostname };
    if (!res.ok) return { url, error: "http", status: res.status };
    if (type && !/html|xml/.test(type)) return { url, error: "not-html" };
    const html = await readCapped(res);
    return parsePreview(html, res.url || url, parseDoc);
  } catch (e) {
    return { url, error: e?.name === "AbortError" ? "timeout" : "network" };
  } finally { clearTimeout(timer); }
}
async function doPreviews({ urls = [], images }) {
  const { settings = {} } = await api.storage.local.get("settings");
  if (settings.previews === false) return { off: true, previews: {} };
  if (!(await canPreview())) return { needPermission: true, previews: {} };
  const cache = await previewCache();
  const now = Date.now();
  const out = {};
  await Promise.all([...new Set(urls)].slice(0, 12).map(async (u) => {
    const hit = cache[u];
    if (hit && now - hit.at < (hit.p.error ? 864e5 : PREVIEW_TTL)) { out[u] = hit.p; return; }
    if (!previewFlight.has(u)) previewFlight.set(u, fetchPreview(u).catch(() => ({ url: u, error: "bad-url" })).finally(() => previewFlight.delete(u)));
    const p = slimPreview(await previewFlight.get(u));
    cache[u] = { p, at: Date.now() };
    out[u] = p;
  }));
  savePreviewsSoon();
  const prefs = await loadPrefs();
  for (const k in out) if (out[k]) { const v = prefs.items[linkId(k)]?.v; if (v) out[k] = { ...out[k], pref: v }; }
  if (images === false || settings.previewImages === false) for (const k in out) if (out[k]) out[k] = { ...out[k], image: null };
  return { previews: out };
}

// ---- reviews of what you liked ----
async function doReview({ id, action }) {
  const prefs = reviewPref(await loadPrefs(), id, action);
  await save({ prefs });
  return { ok: true, due: dueLikes(prefs).length };
}

// ---- backup, import and sync ----
const VERSION = api.runtime.getManifest().version;
const BACKUP_KEYS = ["settings", "blocklist", "prefs", "dismissed", "providers", "raindropToken", "teach"];
async function currentStore() {
  await ready;
  const local = await api.storage.local.get(BACKUP_KEYS);
  const [opened, readingLog, impressions] = await Promise.all([bigGet("opened"), bigGet("readingLog"), bigGet("impressions")]);
  // makeBackup reads what you taught the graph from store.graph.
  return { ...local, graph: local.teach || null, opened, readingLog, impressions };
}

async function applyMerge(patch) {
  const { teach, ...rest } = patch;
  if (teach) {
    const { teach: mine = { adj: {}, muted: [] } } = await api.storage.local.get("teach");
    const merged = { adj: { ...(teach.adj || {}), ...(mine.adj || {}) }, muted: [...new Set([...(mine.muted || []), ...(teach.muted || [])])] };
    rest.teach = merged;
    const g = await loadGraph();
    if (g) { g.state.adj = merged.adj; g.state.muted = merged.muted; }
  }
  for (const k of BIG_KEYS) if (k in rest) { await bigSet(k, rest[k]); delete rest[k]; }
  syncPaused = true;
  try { await save(rest); } finally { setTimeout(() => { syncPaused = false; }, 1000); }
  prepared.clear();
  return Object.keys(patch);
}

async function doBackupExport({ includeKeys = false, includeLog = true }) {
  const b = makeBackup(await currentStore(), { version: VERSION, includeKeys, includeLog });
  return { json: JSON.stringify(b, null, 1), size: JSON.stringify(b).length };
}

async function doBackupImport({ json }) {
  const inc = readBackup(typeof json === "string" ? JSON.parse(json) : json);
  const keys = await applyMerge(mergeBackup(await currentStore(), inc));
  return { ok: true, merged: keys, from: inc.app_version, at: inc.exported_at };
}

// Firefox Sync: the same backup, without keys or the reading log, in storage.sync.
let deviceMemo = null;
async function deviceId() {
  if (deviceMemo) return deviceMemo;
  let { deviceId: d } = await api.storage.local.get("deviceId");
  if (!d) { d = crypto.randomUUID(); await api.storage.local.set({ deviceId: d }); }
  return (deviceMemo = d);
}
let syncPaused = false, syncTimer = null, lastPushed = "";
async function syncState() { const { syncInfo = {} } = await api.storage.local.get("syncInfo"); return syncInfo; }
async function setSyncInfo(patch) { const cur = await syncState(); await api.storage.local.set({ syncInfo: { ...cur, ...patch } }); }

async function firefoxPush() {
  const parts = toSyncChunks(makeBackup(await currentStore(), { version: VERSION, includeKeys: false, includeLog: false }));
  const joined = parts.join("");
  if (joined === lastPushed) return { ok: true, unchanged: true };
  const old = await api.storage.sync.get(null);
  const items = { "hamsa:meta": { n: parts.length, at: Date.now(), v: VERSION, d: await deviceId() } };
  parts.forEach((p, i) => { items[`hamsa:${i}`] = p; });
  await api.storage.sync.set(items);
  const stale = Object.keys(old).filter((k) => /^hamsa:\d+$/.test(k) && Number(k.split(":")[1]) >= parts.length);
  if (stale.length) await api.storage.sync.remove(stale);
  lastPushed = joined;
  const bytes = parts.reduce((a, p, i) => a + new TextEncoder().encode(`hamsa:${i}${JSON.stringify(p)}`).length, 0); // as Firefox counts them
  await setSyncInfo({ firefoxPushedAt: Date.now(), firefoxBytes: bytes });
  return { ok: true, bytes };
}

async function firefoxPull() {
  const all = await api.storage.sync.get(null);
  const meta = all["hamsa:meta"];
  if (!meta) return { ok: true, empty: true };
  if (meta.d && meta.d === (await deviceId())) return { ok: true, own: true }; // our own push coming back
  const text = Array.from({ length: meta.n }, (_, i) => all[`hamsa:${i}`] || "").join("");
  const info = await syncState();
  if (info.firefoxPulledAt && meta.at <= info.firefoxPulledAt) return { ok: true, unchanged: true };
  const keys = await applyMerge(mergeBackup(await currentStore(), readBackup(JSON.parse(text))));
  lastPushed = text;
  await setSyncInfo({ firefoxPulledAt: Date.now() });
  return { ok: true, merged: keys };
}

// Push a little after anything worth syncing changes.
const SYNCED = ["settings", "blocklist", "prefs", "dismissed", "teach"];
api.storage.onChanged.addListener((ch, area) => {
  if (area === "sync") { if (Object.keys(ch).some((k) => k.startsWith("hamsa:"))) settingsSync("pull"); return; }
  if (syncPaused || !SYNCED.some((k) => ch[k])) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => settingsSync("push"), 8000);
});
async function settingsSync(dir) {
  try {
    const { settings = {} } = await api.storage.local.get("settings");
    if (settings.syncFirefox) await (dir === "pull" ? firefoxPull() : firefoxPush());
  } catch (e) { logError(`sync-${dir}`, e?.message || e); }
}

// A short log of what went wrong, shown in settings under Recent problems.
async function logError(where, message) {
  try {
    const { errors = [] } = await api.storage.local.get("errors");
    await save({ errors: [{ at: Date.now(), where, message: String(message).slice(0, 400), version: api.runtime.getManifest().version }, ...errors].slice(0, 30) });
  } catch { /* storage unavailable */ }
}
handlers["log-error"] = async ({ where, message }) => { await logError(where, message); return { ok: true }; };
handlers["errors-clear"] = async () => { await save({ errors: [] }); return { ok: true }; };

api.runtime.onMessage.addListener((msg, sender) => {
  const h = handlers[msg?.type];
  if (!h) return undefined;
  const t0 = performance.now();
  return h(msg, sender).then((r) => {
    // The page adds this to its own drawing time when it reports to Health.
    if ((msg.type === "front" || msg.type === "thread") && r && typeof r === "object") { r.waitMs = msg.type === "thread" ? karmaWaitMs : 0; r.bgMs = Math.round(performance.now() - t0) - r.waitMs; karmaWaitMs = 0; }
    return r;
  }).catch((e) => {
    logError(msg.type, e?.message || e);
    return { error: e?.message || String(e) };
  });
});

// The toolbar button opens the digest.
api.action?.onClicked.addListener(() => api.tabs.create({ url: api.runtime.getURL("digest/digest.html") }));

// Pending IndexedDB writes go out before Firefox unloads the background page.
api.runtime.onSuspend?.addListener(() => { flush().catch(() => {}); });

// Firefox Sync is pulled when the browser starts. The digest is built when you open it, not before.
api.runtime.onStartup.addListener(() => settingsSync("pull"));

