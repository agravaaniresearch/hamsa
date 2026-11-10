// Likes and dislikes, kept in this browser. Explicit (the thumbs on stories and comments) or read from
// Hacker News itself (stories and comments you upvoted, comments you downvoted). An explicit choice is
// never overwritten by one read from HN.
//
// { schema: "hamsa.prefs/1",
//   items: { "<hn id>": { v: "like" | "dislike", kind: "story" | "comment", title, domain, tags, at, source: "you" | "hn" } } }
import { tokenize } from "./tokenize.js";

export const PREFS_SCHEMA = "hamsa.prefs/1";
const MAX = 5000;

export function emptyPrefs() {
  return { schema: PREFS_SCHEMA, items: {} };
}

export function setPref(prefs, item, value, source = "you") {
  const p = prefs?.items ? prefs : emptyPrefs();
  const id = String(item.id);
  const prev = p.items[id];
  if (source === "hn" && prev && prev.source === "you") return p; // your own choice wins
  if (!value) { delete p.items[id]; return p; }
  p.items[id] = { v: value, kind: item.kind || "story", title: String(item.title || "").slice(0, 300), domain: item.domain || null, tags: (item.tags || []).slice(0, 6), at: Date.now(), source };
  const ids = Object.keys(p.items);
  if (ids.length > MAX) for (const k of ids.sort((a, b) => p.items[a].at - p.items[b].at).slice(0, ids.length - MAX)) delete p.items[k];
  return p;
}

// What scoring needs: liked and disliked titles as terms, site counts, tag counts, and each item's state.
export function derivePrefs(prefs) {
  const out = { items: {}, likeTitles: [], dislikeTitles: [], likeDomains: {}, dislikeDomains: {}, likeTags: {}, counts: { like: 0, dislike: 0, hn: 0 } };
  for (const [id, x] of Object.entries(prefs?.items || {})) {
    out.items[id] = x.v;
    out.counts[x.v]++;
    if (x.source === "hn") out.counts.hn++;
    if (x.kind === "story" && x.title) (x.v === "like" ? out.likeTitles : out.dislikeTitles).push({ id, title: x.title, terms: [...new Set(tokenize(x.title))] });
    if (x.kind === "story" && x.domain) { const m = x.v === "like" ? out.likeDomains : out.dislikeDomains; m[x.domain] = (m[x.domain] || 0) + 1; }
    if (x.v === "like") for (const t of x.tags || []) out.likeTags[t] = (out.likeTags[t] || 0) + 1;
  }
  out.likeTitles = out.likeTitles.slice(-600);
  out.dislikeTitles = out.dislikeTitles.slice(-600);
  return out;
}

// Newest wins, but an explicit choice beats one read from HN.
export function mergePrefs(a, b) {
  const out = emptyPrefs();
  for (const src of [a, b]) {
    for (const [id, x] of Object.entries(src?.items || {})) {
      const cur = out.items[id];
      if (!cur || (x.source === "you" && cur.source !== "you") || ((x.source === cur.source) && x.at > cur.at)) out.items[id] = x;
    }
  }
  return out;
}
