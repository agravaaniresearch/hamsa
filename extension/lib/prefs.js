// Likes and dislikes, kept in this browser. Explicit (the thumbs on stories and comments) or read from
// Hacker News itself (stories and comments you upvoted, comments you downvoted). An explicit choice is
// never overwritten by one read from HN.
//
// { schema: "hamsa.prefs/1",
//   items: { "<hn id>" | "link:<url>": { v: "like" | "dislike", kind: "story" | "comment" | "link", title, domain, tags, at,
//            source: "you" | "hn", url?, threadId?, threadTitle?, author?, excerpt?, links?, points?,
//            review?: { step, due, stopped?, done?, last? } } } }
// A like is brought back for review on a spaced schedule (1, 3, 7, 16, 35, 90 and 180 days), so what you
// once found worth keeping comes round again while it can still be useful.
import { tokenize, words } from "./tokenize.js";

export const PREFS_SCHEMA = "hamsa.prefs/1";
const MAX = 5000;
export const INTERVALS = [1, 3, 7, 16, 35, 90, 180]; // days
const DAY = 864e5;
export const linkId = (url) => "link:" + String(url).replace(/#.*$/, "").replace(/\/$/, "");

export function emptyPrefs() {
  return { schema: PREFS_SCHEMA, items: {} };
}

export function setPref(prefs, item, value, source = "you") {
  const p = prefs?.items ? prefs : emptyPrefs();
  const id = String(item.id);
  const prev = p.items[id];
  if (source === "hn" && prev && prev.source === "you") return p; // your own choice wins
  if (!value) { delete p.items[id]; return p; }
  const now = Date.now();
  const rec = { v: value, kind: item.kind || "story", title: String(item.title || "").slice(0, 300), domain: item.domain || null, tags: (item.tags || []).slice(0, 6), at: now, source };
  for (const k of ["url", "threadId", "threadTitle", "author", "points", "site", "image"]) if (item[k] != null && item[k] !== "") rec[k] = typeof item[k] === "string" ? item[k].slice(0, 500) : item[k];
  if (item.excerpt) rec.excerpt = String(item.excerpt).replace(/\s+/g, " ").trim().slice(0, 300);
  if (item.links?.length) rec.links = item.links.slice(0, 5).map((u) => String(u).slice(0, 500));
  // Keep what an earlier record knew, and the review schedule of a like that is liked again.
  if (prev) for (const k of ["url", "threadId", "threadTitle", "author", "excerpt", "links", "points", "site", "image"]) if (rec[k] == null && prev[k] != null) rec[k] = prev[k];
  if (value === "like") rec.review = prev?.v === "like" && prev.review ? prev.review : { step: 0, due: now + INTERVALS[0] * DAY };
  p.items[id] = rec;
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
    if ((x.kind === "story" || x.kind === "link") && x.title) (x.v === "like" ? out.likeTitles : out.dislikeTitles).push({ id, title: x.title, terms: [...new Set(tokenize(x.title))] });
    if ((x.kind === "story" || x.kind === "link") && x.domain) { const m = x.v === "like" ? out.likeDomains : out.dislikeDomains; m[x.domain] = (m[x.domain] || 0) + 1; }
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

// Review a liked item: "keep" (still useful, so the next interval), "later" (tomorrow, same step),
// "stop" (never bring it back) or "unlike" (forget the like).
export function reviewPref(prefs, id, action, now = Date.now()) {
  const x = prefs?.items?.[String(id)];
  if (!x || x.v !== "like") return prefs;
  if (action === "unlike") { delete prefs.items[String(id)]; return prefs; }
  const r = { ...(x.review || { step: 0 }) };
  r.last = now;
  if (action === "stop") r.stopped = true;
  else if (action === "later") r.due = now + DAY;
  else {
    r.step = (r.step || 0) + 1;
    if (r.step >= INTERVALS.length) { r.done = true; r.due = null; } else r.due = now + INTERVALS[r.step] * DAY;
  }
  x.review = r;
  return prefs;
}

// Likes due for review, oldest due first. A like made before reviews existed is due a day after it was made.
export function dueLikes(prefs, now = Date.now(), max = 8) {
  return Object.entries(prefs?.items || {})
    .filter(([, x]) => x.v === "like" && !x.review?.stopped && !x.review?.done)
    .map(([id, x]) => ({ id, ...x, due: x.review?.due ?? x.at + DAY }))
    .filter((x) => x.due <= now)
    .sort((a, b) => a.due - b.due)
    .slice(0, max);
}

// Stories scored by your likes alone: words shared with liked titles and comments (rarer words count
// more), sites you liked, and tags your likes carried. Each pick says which like it came from.
export function likeScore(stories, prefs, { tagsOf = () => [], max = 12 } = {}) {
  const liked = Object.entries(prefs?.items || {}).filter(([, x]) => x.v === "like");
  if (!liked.length) return [];
  const docs = liked.map(([id, x]) => ({ id, x, terms: new Set(tokenize([x.title, x.threadTitle, x.excerpt].filter(Boolean).join(" ")).filter((t) => t.length > 3)) }));
  const df = new Map();
  for (const d of docs) for (const t of d.terms) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  const idf = (t) => Math.log(1 + N / (df.get(t) || N));
  const domains = {}, tags = {};
  for (const [, x] of liked) {
    if (x.domain) domains[x.domain] = (domains[x.domain] || 0) + 1;
    for (const t of x.tags || []) tags[t] = (tags[t] || 0) + 1;
  }
  const out = [];
  const likedThreads = new Set(liked.map(([, x]) => String(x.threadId || "")).filter(Boolean));
  for (const st of stories) {
    if (prefs.items[String(st.id)] || likedThreads.has(String(st.id))) continue; // already liked, or where a like came from
    const terms = [...new Set(tokenize(st.title))].filter((t) => t.length > 3);
    const said = new Map(words(st.title).map((w) => [tokenize(w)[0], w]));
    let best = null, bestScore = 0;
    for (const d of docs) {
      const shared = terms.filter((t) => d.terms.has(t));
      if (!shared.length) continue;
      const sc = shared.reduce((a, t) => a + idf(t), 0) / Math.max(3, terms.length);
      if (sc > bestScore) { bestScore = sc; best = { d, shared }; }
    }
    const reasons = [];
    let score = 0;
    if (best && best.shared.length >= (terms.length <= 3 ? 1 : 2)) {
      const pts = Math.min(0.6, bestScore / 2);
      score += pts;
      reasons.push({ kind: "like", label: `Shares "${best.shared.slice(0, 3).map((t) => said.get(t) || t).join(", ")}" with ${best.d.x.kind === "comment" ? "a comment" : best.d.x.kind === "link" ? "a link" : "a story"} you liked: ${best.d.x.title.length > 70 ? best.d.x.title.slice(0, 70).replace(/\s+\S*$/, "") + "…" : best.d.x.title}`, points: Math.round(pts * 100) / 100, likeId: best.d.id });
    }
    if (st.domain && domains[st.domain]) { const pts = Math.min(0.25, 0.1 * domains[st.domain]); score += pts; reasons.push({ kind: "like", label: `From ${st.domain}, a site you liked ${domains[st.domain]} time${domains[st.domain] > 1 ? "s" : ""}`, points: Math.round(pts * 100) / 100 }); }
    const tg = tagsOf(st).filter((t) => tags[t]);
    if (tg.length) { const pts = Math.min(0.3, 0.1 * tg.length); score += pts; reasons.push({ kind: "like", label: `Tags your likes carry: ${tg.slice(0, 3).join(", ")}`, points: Math.round(pts * 100) / 100 }); }
    if (score >= 0.2) out.push({ id: st.id, story: st, score: Math.min(1, Math.round(score * 100) / 100), reasons, because: best ? { id: best.d.id, title: best.d.x.title, kind: best.d.x.kind } : null });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}
