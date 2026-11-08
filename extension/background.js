// Background page: all network calls and all state changes happen here. The sidebar and options pages
// only send messages, so keys never leave this origin.
import { api, getState, save, patchSettings, cacheGet, cachePut, addUsage } from "./lib/store.js";
import { fetchPages, mergePages, prepare, itemIdFrom } from "./lib/thread.js";
import { TagGraph, buildState } from "./lib/graph.js";
import { SUMMARY_SCHEMA, SYSTEM_PROMPT, buildUserMessage, interestsText, normalise } from "./lib/summarise.js";
import { completeJSON, testKey, listModels, keySig, originPattern, estimateTokens } from "./lib/providers.js";
import { estimateCost } from "./lib/pricing.js";
import { fetchAllItems, saveBookmark } from "./lib/raindrop.js";

const parseDoc = (html) => new DOMParser().parseFromString(html, "text/html");
const prepared = new Map(); // thread id -> { thread, prep, graphStamp }

async function loadGraph() {
  const { graph } = await getState();
  return graph ? new TagGraph(graph) : null;
}
async function saveGraph(g) {
  await save({ graph: g.toJSON() });
}

function pickProvider(state, providerId, model) {
  const id = providerId || state.settings.active.providerId;
  const p = state.providers.find((x) => x.id === id);
  if (!p) throw new Error("Choose a provider and model first (Hamsa options).");
  const m = model || state.settings.active.model || p.models?.[0];
  if (!m) throw new Error("Choose a model for this provider (Hamsa options).");
  return { p, m };
}

async function doPrepare({ id }) {
  const state = await getState();
  const graph = state.graph ? new TagGraph(state.graph) : null;
  const pages = await fetchPages(id, { parseDoc });
  const thread = mergePages(pages, parseDoc);
  const prep = prepare(thread, graph, { budgetTokens: state.settings.budgetTokens });
  prepared.set(id, { thread, prep });
  const out = {
    id, title: thread.story.title, domain: thread.story.link_domain, points: thread.story.points,
    rows: prep.result.stats.rows_seen, kept: prep.result.stats.kept, tokens: prep.tokens,
    dropped: { unavailable: prep.result.stats.unavailable, ...prep.result.stats.pruned },
    threadRelevance: Math.round(prep.threadRelevance * 100) / 100,
    graphReady: !!graph,
    cached: !!(await cacheGet(id)),
  };
  return out;
}

async function doCost({ id, providerId, model }) {
  const state = await getState();
  const { p, m } = pickProvider(state, providerId, model);
  const entry = prepared.get(id) || (await doPrepare({ id }), prepared.get(id));
  const graph = state.graph ? new TagGraph(state.graph) : null;
  const interests = interestsText(graph, state.settings.extraInterests);
  const input = entry.prep.tokens + estimateTokens(SYSTEM_PROMPT + interests + JSON.stringify(SUMMARY_SCHEMA)) ;
  const cost = estimateCost(m, input, state.settings.maxOutputTokens, { fx: state.settings.fx, overrides: state.settings.priceOverrides, baseUrl: p.baseUrl });
  return { input, output: state.settings.maxOutputTokens, ...cost };
}

// For each point: the tags that fired on the comments it cites, and the strongest absolute relevance among them.
function annotate(summary, comments) {
  const byPath = new Map(comments.map((c) => [c.path, c]));
  for (const pt of summary.points) {
    const tags = new Map();
    let best = 0;
    for (const r of pt.refs) {
      const rel = byPath.get(r)?.relevance;
      if (!rel) continue;
      best = Math.max(best, rel.abs ?? 0);
      for (const t of rel.tags) if (!t.via) tags.set(t.tag, Math.max(tags.get(t.tag) || 0, t.a));
    }
    pt.tags = [...tags].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
    pt.rel = Math.round(best * 100) / 100;
  }
}

async function doSummarise({ id, providerId, model, force }) {
  if (!force) {
    const hit = await cacheGet(id);
    if (hit) return { ...hit, fromCache: true };
  }
  const state = await getState();
  const { p, m } = pickProvider(state, providerId, model);
  const entry = prepared.get(id) || (await doPrepare({ id }), prepared.get(id));
  const graph = state.graph ? new TagGraph(state.graph) : null;
  const interests = interestsText(graph, state.settings.extraInterests);
  const user = buildUserMessage(entry.prep.threadText, interests);
  const out = await completeJSON({ provider: p, model: m, system: SYSTEM_PROMPT, user, schema: SUMMARY_SCHEMA, maxTokens: state.settings.maxOutputTokens });
  const { summary, known, words, bad_refs } = normalise(out.object, entry.thread.comments);
  if (!summary.points.length && !summary.gist) throw new Error("The model returned an empty summary. Try again or choose another model.");
  annotate(summary, entry.prep.result.kept);
  const ids = Object.fromEntries(known);
  const cost = estimateCost(m, out.usage.input, out.usage.output, { fx: state.settings.fx, overrides: state.settings.priceOverrides, baseUrl: p.baseUrl });
  await addUsage(p.name, m, out.usage.input, out.usage.output);
  const result = {
    id, title: entry.thread.story.title, link: entry.thread.story.link_url, summary, ids, words, bad_refs,
    provider: p.name, model: m, mode: out.mode, usage: out.usage, cost,
    stats: { rows: entry.prep.result.stats.rows_seen, kept: entry.prep.result.stats.kept, tokens: entry.prep.tokens, dropped: { unavailable: entry.prep.result.stats.unavailable, ...entry.prep.result.stats.pruned } },
    threadRelevance: Math.round(entry.prep.threadRelevance * 100) / 100,
  };
  await cachePut(id, result);
  return result;
}

// Feedback from the sidebar. Everything is a small move on per-tag numbers; the graph is saved each time.
async function doFeedback(msg) {
  const g = await loadGraph();
  if (!g) throw new Error("Sync your Raindrop tags first (Hamsa options).");
  const { settings } = await getState();
  if (settings.learning === "off") return { ok: true, note: "Learning is off." };
  let note = "";
  switch (msg.kind) {
    case "thumb": {
      const mag = { "Wrong topic": 0.6, "Already know this": 0.3, "Too shallow": 0.2, "Wrong reason shown": 0 }[msg.reason] ?? 0.3;
      const delta = msg.dir === "up" ? 0.3 : msg.dir === "down" ? -(msg.reason && mag ? mag : 0.3) : 0;
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
  prepared.clear(); // scores changed; the next run re-cleans with the new weights
  return { ok: true, note };
}

async function doSavePoint({ id, title, link, tags, point }) {
  const { raindropToken, settings } = await getState();
  const g = await loadGraph();
  const url = `https://news.ycombinator.com/item?id=${id}`;
  if (raindropToken) await saveBookmark(raindropToken, { link: url, title: `HN: ${title}`, tags: (tags || []).slice(0, 5), note: point || "" });
  if (g) {
    g.add({ title, excerpt: point || "", tags: tags || [], created: new Date().toISOString() });
    g.nudge(tags || [], 0.2);
    await saveGraph(g);
  }
  return { ok: true, saved: !!raindropToken, note: raindropToken ? `Saved to Raindrop with tags ${(tags || []).join(", ")}` : "No Raindrop token set; the interest was still counted." };
}

async function doSync() {
  const { raindropToken, settings } = await getState();
  if (!raindropToken) throw new Error("Add your Raindrop token first.");
  let n = 0;
  const items = await fetchAllItems(raindropToken, { onProgress: (c) => { n = c; api.runtime.sendMessage({ type: "sync-progress", n: c }).catch(() => {}); } });
  const prev = await loadGraph();
  const state = buildState(items, { excluded: settings.excludedTags });
  if (prev) { state.adj = prev.state.adj; state.muted = prev.state.muted; } // keep what you taught it
  await save({ graph: state, graphSyncedAt: Date.now() });
  const g = new TagGraph(state);
  prepared.clear();
  return { items: items.length, tags: g.size, top: g.topTags(30) };
}

async function doGraphInfo() {
  const g = await loadGraph();
  const { graphSyncedAt } = await api.storage.local.get("graphSyncedAt");
  if (!g) return { ready: false };
  return { ready: true, tags: g.size, items: g.state.n_items, syncedAt: graphSyncedAt || null, top: g.topTags(40).map((t) => ({ ...t, muted: g.isMuted(t.tag), adj: g.adj(t.tag) })), muted: g.state.muted };
}

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

const handlers = {
  prepare: doPrepare,
  cost: doCost,
  summarise: doSummarise,
  feedback: doFeedback,
  "save-point": doSavePoint,
  sync: doSync,
  "graph-info": doGraphInfo,
  "test-key": doTestKey,
  "open-sidebar": async () => {
    try { await api.sidebarAction.open(); return { opened: true }; }
    catch { return { opened: false, hint: "Press Alt+Shift+H or click the Hamsa toolbar button." }; }
  },
  jump: async ({ tabId, id }) => api.tabs.sendMessage(tabId, { type: "jump", id }).catch(() => ({ found: false })),
  "active-thread": async () => {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const m = tab?.url && /^https:\/\/news\.ycombinator\.com\/item\?id=(\d+)/.exec(tab.url);
    return { tabId: tab?.id ?? null, id: m ? Number(m[1]) : null };
  },
};

api.runtime.onMessage.addListener((msg) => {
  const h = handlers[msg?.type];
  if (!h) return undefined;
  return h(msg).catch((e) => ({ error: e?.message || String(e) }));
});
