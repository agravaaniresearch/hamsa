// Background page: all network calls, all scoring and all state changes happen here. The pages on
// Hacker News, the digest and the settings page only send messages, so keys never leave this origin.
import { api, getState, save, patchSettings, cacheGet, cachePut, addUsage, todayUsage, today } from "./lib/store.js";
import { mergePages, prepare, verdicts as commentVerdicts, fetchPages } from "./lib/thread.js";
import { TagGraph, buildState } from "./lib/graph.js";
import { SUMMARY_SCHEMA, SYSTEM_PROMPT, buildUserMessage, interestsText, normalise } from "./lib/summarise.js";
import { completeJSON, testKey, listModels, keySig, originPattern, estimateTokens, isUsable } from "./lib/providers.js";
import { estimateCost } from "./lib/pricing.js";
import { fetchAllItems, saveBookmark } from "./lib/raindrop.js";
import { parseFront, mergeFront, groupDuplicates } from "./lib/front.js";
import { tokenize } from "./lib/tokenize.js";
import { domainOf } from "./lib/profile.js";
import { scoreStories, RULES_VERSION } from "./lib/score.js";
import { compileBlocklist, normaliseBlocklist, testBlocklist, suggestFromDismissals, DRAFT_PROMPT, DRAFT_SCHEMA } from "./lib/blocklist.js";
import { buildProfile, bookmarkTreeToItems, parseHnList } from "./lib/profile.js";
import { clusterStories } from "./lib/cluster.js";

const HN = "https://news.ycombinator.com/";
const parseDoc = (html) => new DOMParser().parseFromString(html, "text/html");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prepared = new Map(); // thread id -> { thread, prep }
let lastFront = null;        // the most recent merged front page, for testing the blocklist

// The tag graph is read from storage once and kept compiled in memory until it changes.
let graphMemo = null;
async function loadGraph() {
  if (graphMemo) return graphMemo.g;
  const { graph } = await api.storage.local.get("graph");
  graphMemo = { g: graph ? new TagGraph(graph) : null };
  return graphMemo.g;
}
api.storage.onChanged.addListener((ch) => { if (ch.graph) { graphMemo = null; prepared.clear(); } });
async function saveGraph(g) { await save({ graph: g.toJSON() }); }

function activeProvider(state, providerId, model) {
  const id = providerId || state.settings.active.providerId;
  const p = state.providers.find((x) => x.id === id);
  if (!p) throw new Error("Choose a provider and model first (Hamsa settings).");
  const m = model || state.settings.active.model || p.models?.[0];
  if (!m) throw new Error("Choose a model for this provider (Hamsa settings).");
  return { p, m };
}

// ---- front page ----
async function scoreFront(state, stories) {
  const graph = await loadGraph();
  const { opened = null } = await api.storage.local.get("opened");
  const v = scoreStories(stories, {
    graph, profile: state.profile, blocks: compileBlocklist(state.blocklist),
    scoring: state.settings.scoring, dismissed: state.dismissed.map((d) => d.id), opened,
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
  return { verdicts: v, ready: !!(graph?.size || state.profile) };
}

// ---- reading log: what you open, kept in this browser ----
const emptyOpened = () => ({ domains: {}, titles: [], tags: {} });
async function doOpened({ entry }) {
  const { settings = {} } = await api.storage.local.get("settings");
  if (settings.readingLog === false || !entry) return { ok: true, logged: false };
  const { readingLog = [], opened = emptyOpened() } = await api.storage.local.get(["readingLog", "opened"]);
  const e = { at: Date.now(), kind: entry.kind, id: entry.id || null, title: String(entry.title || "").slice(0, 300), url: entry.url || null, domain: entry.domain || (entry.url ? domainOf(entry.url) : null), tags: (entry.tags || []).slice(0, 6), score: entry.score ?? null, bucket: entry.bucket || null, rules: RULES_VERSION, page: entry.page || null, background: !!entry.background };
  readingLog.unshift(e);
  if (e.domain && e.kind !== "thread") opened.domains[e.domain] = (opened.domains[e.domain] || 0) + 1;
  for (const t of e.tags) opened.tags[t] = (opened.tags[t] || 0) + 1;
  if (e.title && (e.kind === "story" || e.kind === "thread") && !opened.titles.some((x) => x.id === e.id)) {
    opened.titles.unshift({ id: e.id, title: e.title, terms: [...new Set(tokenize(e.title))] });
    opened.titles = opened.titles.slice(0, 400);
  }
  await save({ readingLog: readingLog.slice(0, 5000), opened });
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
  const { impressions = {} } = await api.storage.local.get("impressions");
  const now = Date.now();
  stories.forEach((st, i) => {
    const v = verdicts[i];
    const prev = impressions[st.id];
    impressions[st.id] = { id: st.id, title: st.title, url: st.url, domain: st.domain, points: st.points, comments: st.comments, tags: v.tags, score: v.score, bucket: v.bucket, rules: RULES_VERSION, first: prev?.first || now, last: now, seen: (prev?.seen || 0) + 1 };
  });
  const keep = Object.values(impressions).sort((a, b) => b.last - a.last).slice(0, 3000);
  await save({ impressions: Object.fromEntries(keep.map((x) => [x.id, x])) });
}

// One JSON object per line: every story you were shown or opened, with what Hamsa scored and what you did.
async function doExportLog() {
  const { impressions = {}, readingLog = [], dismissed = [] } = await api.storage.local.get(["impressions", "readingLog", "dismissed"]);
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

async function doFront({ pages }) {
  const state = await getState();
  const merged = mergeFront(pages.map((h) => parseFront(parseDoc(h))));
  if (merged.me && merged.me !== state.settings.hnUser) await patchSettings({ hnUser: merged.me });
  lastFront = { stories: merged.stories, at: Date.now() };
  const { verdicts, ready } = await scoreFront(state, merged.stories);
  if (state.settings.readingLog !== false) recordImpressions(merged.stories, verdicts).catch(() => {});
  const counts = { keep: 0, maybe: 0, stretch: 0, toss: 0 };
  for (const x of verdicts) counts[x.bucket]++;
  const graph = await loadGraph();
  return {
    stories: merged.stories, verdicts, counts, ready, me: merged.me,
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
    { id: "history", name: "Browser history", on: s.history, n: src.history?.items },
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
const KARMA_TTL = 7 * 864e5;
let karmaMemo = null;
async function karmaFor(users, budgetMs = 1200) {
  if (!karmaMemo) karmaMemo = (await api.storage.local.get("karma")).karma || {};
  const now = Date.now();
  const want = [...new Set(users.filter(Boolean))].filter((u) => !karmaMemo[u] || now - karmaMemo[u][1] > KARMA_TTL).slice(0, 200);
  const one = async (u) => {
    try {
      const r = await fetch(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(u)}/karma.json`, { credentials: "omit" });
      if (r.ok) { const k = await r.json(); if (typeof k === "number") karmaMemo[u] = [k, Date.now()]; }
    } catch { /* offline or blocked: karma is a small signal */ }
  };
  const run = (async () => {
    for (let i = 0; i < want.length; i += 12) await Promise.all(want.slice(i, i + 12).map(one));
    const keep = Object.entries(karmaMemo).sort((a, b) => b[1][1] - a[1][1]).slice(0, 20000);
    karmaMemo = Object.fromEntries(keep);
    await save({ karma: karmaMemo });
  })();
  await Promise.race([run, sleep(budgetMs)]);
  return Object.fromEntries(Object.entries(karmaMemo).map(([u, [k]]) => [u, k]));
}

async function analyse(id, pages) {
  const state = await getState();
  const graph = await loadGraph();
  const html = pages?.length ? pages : await fetchPages(id, { parseDoc });
  const thread = mergePages(html, parseDoc);
  const karma = state.settings.karma === false ? null : await karmaFor(thread.comments.filter((c) => c.status === "ok").map((c) => c.author));
  const prep = prepare(thread, graph, { budgetTokens: state.settings.budgetTokens, scoring: state.settings.scoring, gate: state.settings.gate, karma });
  prepared.set(id, { thread, prep });
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
  return {
    id, title: thread.story.title, domain: thread.story.link_domain, points: thread.story.points, author: thread.story.author,
    funnel: prep.funnel, dropped: { unavailable: stats.unavailable, ...stats.pruned }, tokens: prep.tokens, context: thread.story.context,
    verdicts: commentVerdicts(thread), threadRelevance: Math.round(prep.threadRelevance * 100) / 100,
    graphReady: !!graph?.size, estimate, model, rules: RULES_VERSION,
    cached: cached && cached.rules === RULES_VERSION ? cached : null,
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

async function doSummarise({ id, providerId, model, force }) {
  if (!force) {
    const hit = await cacheGet(id);
    if (hit && hit.rules === RULES_VERSION) return { ...hit, fromCache: true };
  }
  const state = await getState();
  const { p, m } = activeProvider(state, providerId, model);
  const entry = prepared.get(id) || (await analyse(id), prepared.get(id));
  const graph = await loadGraph();
  const interests = interestsText(graph, state.settings.extraInterests);
  const user = buildUserMessage(entry.prep.threadText, interests);
  const estimateIn = entry.prep.tokens + estimateTokens(SYSTEM_PROMPT + interests + JSON.stringify(SUMMARY_SCHEMA));
  const out = await completeJSON({ provider: p, model: m, system: SYSTEM_PROMPT, user, schema: SUMMARY_SCHEMA, maxTokens: state.settings.maxOutputTokens });
  const { summary, known, words, bad_refs } = normalise(out.object, entry.thread.comments);
  if (!summary.points.length && !summary.gist) throw new Error("The model returned an empty summary. Try again or choose another model.");
  annotate(summary, entry.prep.result.kept);
  const cost = estimateCost(m, out.usage.input, out.usage.output, { fx: state.settings.fx, overrides: state.settings.priceOverrides, baseUrl: p.baseUrl });
  await addUsage(p.name, m, out.usage.input, out.usage.output, cost.usd || 0);
  const result = {
    id, title: entry.thread.story.title, link: entry.thread.story.link_url, summary, ids: Object.fromEntries(known), words, bad_refs,
    provider: p.name, model: m, mode: out.mode, usage: out.usage, estimateIn, cost, rules: RULES_VERSION,
    funnel: entry.prep.funnel, at: Date.now(),
  };
  await cachePut(id, result);
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
  g.recompile();
  await saveGraph(g);
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
  let history = [];
  if (s.history) {
    if (await api.permissions.contains({ permissions: ["history"] })) {
      history = await api.history.search({ text: "", startTime: Date.now() - 90 * 864e5, maxResults: 5000 });
      sources.history = { items: history.length, at: Date.now() };
    } else notes.push("Browser history needs permission: switch the source off and on again.");
  }
  const prev = await loadGraph();
  const gstate = buildState(items, { excluded: state.settings.excludedTags });
  if (prev) { gstate.adj = prev.state.adj; gstate.muted = prev.state.muted; } // keep what you taught it
  const profile = buildProfile({ items, favourites, history, sources });
  await save({ graph: gstate, profile, graphSyncedAt: Date.now() });
  const g = new TagGraph(gstate);
  prepared.clear();
  await save({ digest: null });
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
  if (lastFront && Date.now() - lastFront.at < 30 * 60e3) return lastFront.stories;
  const pages = [];
  let url = `${HN}news`;
  for (let i = 0; i < pagesWanted && url; i++) {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) throw new Error(`Hacker News returned ${res.status}.`);
    const p = parseFront(parseDoc(await res.text()));
    pages.push(p);
    url = p.more ? new URL(p.more, HN).href : null;
    if (url && i + 1 < pagesWanted) await sleep(700);
  }
  const merged = mergeFront(pages).stories;
  lastFront = { stories: merged, at: Date.now() };
  return merged;
}

async function doBlocklistTest({ blocklist }) {
  const bl = normaliseBlocklist(blocklist);
  const stories = await frontStories(4);
  return { tested: stories.length, groups: testBlocklist({ ...bl, groups: bl.groups.map((g) => ({ ...g, enabled: true })) }, stories) };
}

// ---- digest ----
async function buildDigest() {
  const state = await getState();
  const want = Math.max(1, Math.min(6, state.settings.scoring.pages || 4));
  lastFront = null;
  const stories = await frontStories(want);
  const { verdicts, ready } = await scoreFront(state, stories);
  const clusters = clusterStories(stories, verdicts).map((c) => ({
    ...c, items: c.items.map(({ story, verdict }) => ({ story: { id: story.id, title: story.title, url: story.url, domain: story.domain, points: story.points, comments: story.comments }, verdict: { score: verdict.score, bucket: verdict.bucket, reasons: verdict.reasons.slice(0, 4), tags: verdict.tags } })),
  }));
  const digest = { date: today(), built_at: Date.now(), stories: stories.length, pages: want, ready, clusters, rules: RULES_VERSION };
  await save({ digest });
  return digest;
}

async function doDigest({ force }) {
  const { digest } = await api.storage.local.get("digest");
  if (!force && digest && digest.date === today() && digest.rules === RULES_VERSION) return { ...digest, usage: await todayUsage() };
  return { ...(await buildDigest()), usage: await todayUsage() };
}

// ---- providers ----
async function doTestKey({ id }) {
  const { providers } = await getState();
  const p = providers.find((x) => x.id === id);
  if (!p) throw new Error("Unknown provider.");
  if (p.baseUrl && !/localhost|127\.0\.0\.1/.test(p.baseUrl)) {
    try { await api.permissions.request({ origins: [originPattern(p.baseUrl)] }); } catch { /* may already be granted */ }
  }
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
  const pick = ["theme", "font", "titleFont", "textSize", "width", "justify", "density", "darkStyle", "skin", "layer", "order", "scoring", "hnUser", "learning", "fx", "linkTarget", "threadView", "threadSort", "collapseTossed", "readingLog"];
  return { ...Object.fromEntries(pick.map((k) => [k, s[k]])), usage: await todayUsage(), model, models };
}

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
  opened: doOpened,
  "open-tab": doOpenTab,
  "export-log": doExportLog,
  "log-clear": async () => { await save({ readingLog: [], opened: emptyOpened(), impressions: {} }); return { ok: true }; },
  "set-ui": async ({ patch }) => {
    const allowed = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => ["theme", "layer", "order", "active", "threadView", "threadSort", "collapseTossed", "linkTarget"].includes(k)));
    await patchSettings(allowed);
    return { ok: true };
  },
  "open-settings": async () => { await api.runtime.openOptionsPage(); return { ok: true }; },
  "open-digest": async () => { await api.tabs.create({ url: api.runtime.getURL("digest/digest.html") }); return { ok: true }; },
};

// A short log of what went wrong, shown in settings under Recent problems.
async function logError(where, message) {
  try {
    const { errors = [] } = await api.storage.local.get("errors");
    await save({ errors: [{ at: Date.now(), where, message: String(message).slice(0, 400), version: api.runtime.getManifest().version }, ...errors].slice(0, 30) });
  } catch { /* storage unavailable */ }
}
handlers["log-error"] = async ({ where, message }) => { await logError(where, message); return { ok: true }; };
handlers["errors-clear"] = async () => { await save({ errors: [] }); return { ok: true }; };

api.runtime.onMessage.addListener((msg) => {
  const h = handlers[msg?.type];
  if (!h) return undefined;
  return h(msg).catch((e) => {
    logError(msg.type, e?.message || e);
    return { error: e?.message || String(e) };
  });
});

// The toolbar button opens the digest.
api.action?.onClicked.addListener(() => api.tabs.create({ url: api.runtime.getURL("digest/digest.html") }));

// The digest is built once a day, the first time the browser starts.
api.runtime.onStartup.addListener(async () => {
  try {
    const { digest } = await api.storage.local.get("digest");
    if (!digest || digest.date !== today()) await buildDigest();
  } catch { /* offline; it is built on demand instead */ }
});

