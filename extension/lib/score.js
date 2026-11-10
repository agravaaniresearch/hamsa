// The 0 to 1 relevance score shown in front of every story and comment.
//
// A score is never stored alone. Each item carries:
//   score    0 to 1, a squashed sum of the points below
//   reasons  [{ kind, label, points }], the signals that produced it, strongest first
//   bucket   keep | maybe | stretch | toss | removed
//   rules    the scoring-rules version, so old items can be re-scored and compared fairly
//
// total = sum of reason points
// score = 1 - exp(-2 * total / ceiling)        (ceiling is provisional: tune it on real threads)
import { tokenize } from "./tokenize.js";

export const SCORE_SCHEMA = "hamsa.score/1";
export const RULES_VERSION = "0.4";

export const SCORING_DEFAULTS = {
  ceiling: 0.9,          // a total of this much reaches about 0.86
  keepAt: 0.55,
  maybeAt: 0.2,
  blockOverrideAt: 0.75, // a blocked story this relevant is kept anyway, and says so
  stretchMax: 3,         // most stretch picks among comments
  discoverCount: 5,      // Discover picks per front page, 0 to switch off
  pages: 5,              // front pages merged into one list (1 to 6)
};

const r2 = (x) => Math.round(x * 100) / 100;

export function squash(total, ceiling = SCORING_DEFAULTS.ceiling) {
  if (!(total > 0)) return 0;
  return r2(1 - Math.exp((-2 * total) / Math.max(0.05, ceiling)));
}

export function bucketFor(score, s = SCORING_DEFAULTS) {
  return score >= s.keepAt ? "keep" : score >= s.maybeAt ? "maybe" : "toss";
}

// Tag contributions from the graph -> reasons. w is the tag's weight (rarity) times its learned adjustment.
const RARE_AT = 0.45;
export function tagReasons(contribs = []) {
  return contribs.map((c) => ({
    kind: c.via ? "near" : "tag",
    tag: c.tag,
    label: c.via ? `Near your tag: ${c.tag}` : `${c.weight >= RARE_AT ? "Rare" : "Broad"} tag match: ${c.tag}`,
    points: r2(0.5 * c.w * c.a),
  })).filter((r) => r.points > 0);
}

export function finish(reasons, scoring = SCORING_DEFAULTS) {
  const list = reasons.filter((r) => r.points !== 0 || r.kind === "block" || r.kind === "note").sort((a, b) => b.points - a.points);
  const total = r2(list.reduce((s, r) => s + r.points, 0));
  return { score: squash(total, scoring.ceiling), total, reasons: list, rules: RULES_VERSION };
}

const log2 = (x) => Math.log(x) / Math.LN2;

// ---- stories (front page) ----
// stories: parsed front-page rows. graph: TagGraph or null. profile: see profile.js. compiledBlocks: blocklist.compile().
export function scoreStories(stories, { graph = null, profile = null, blocks = null, scoring = SCORING_DEFAULTS, dismissed = [], opened = null, prefs = null, karma = null } = {}) {
  const s = { ...SCORING_DEFAULTS, ...scoring };
  const ready = !!(graph && graph.size) || !!(profile && (Object.keys(profile.domains || {}).length || (profile.fav || []).length));
  const titles = graph && graph.size ? graph.scoreTitles(stories.map((x) => x.title)) : stories.map(() => ({ contribs: [], muted: [] }));
  const gone = new Set(dismissed.map(String));
  const out = stories.map((st, i) => {
    const reasons = tagReasons(titles[i].contribs);
    for (const m of titles[i].muted) reasons.push({ kind: "muted", tag: m, label: `Muted tag: ${m}`, points: -0.3 });
    const d = st.domain;
    if (profile && d) {
      const n = profile.domains?.[d] || profile.domains?.[d.split("/")[0]] || 0;
      if (n) reasons.push({ kind: "domain", label: `Domain appears in your bookmarks (${n})`, points: r2(0.15 * Math.min(1, log2(1 + n) / 4)) });
      const hv = profile.histDomains?.[d] || profile.histDomains?.[d.split("/")[0]] || 0;
      if (hv >= 3) reasons.push({ kind: "history", label: "You often read this site", points: r2(0.08 * Math.min(1, log2(1 + hv) / 5)) });
    }
    if (profile?.fav?.length) {
      const f = favSimilar(profile.fav, st.title);
      if (f) reasons.push({ kind: "fav", label: `Like an HN favourite: ${f.title.slice(0, 60)}`, points: 0.15 });
    }
    // What you actually open: sites, title words and the tags of stories you clicked.
    if (opened) {
      const n = d ? opened.domains?.[d] || 0 : 0;
      if (n) reasons.push({ kind: "opened", label: `You open stories from this site (${n})`, points: r2(0.1 * Math.min(1, log2(1 + n) / 3)) });
      const f = opened.titles?.length ? favSimilar(opened.titles, st.title) : null;
      if (f) reasons.push({ kind: "opened", label: `Like a story you opened: ${f.title.slice(0, 60)}`, points: 0.12 });
      const hot = titles[i].contribs.filter((c) => !c.via).map((c) => [c.tag, opened.tags?.[c.tag] || 0]).sort((a, b) => b[1] - a[1])[0];
      if (hot && hot[1] >= 2) reasons.push({ kind: "opened", label: `You often open stories tagged ${hot[0]} (${hot[1]})`, points: r2(0.05 * Math.min(1, log2(1 + hot[1]) / 3)) });
    }
    // Your likes and dislikes, kept in this browser (and HN upvotes read from the page).
    if (prefs) {
      const liked = favSimilar(prefs.likeTitles, st.title);
      if (liked) reasons.push({ kind: "like", label: `Like something you liked: ${liked.title.slice(0, 60)}`, points: 0.15 });
      const disliked = favSimilar(prefs.dislikeTitles, st.title);
      if (disliked) reasons.push({ kind: "dislike", label: `Like something you disliked: ${disliked.title.slice(0, 60)}`, points: -0.2 });
      const ld = d ? prefs.likeDomains[d] || 0 : 0, dd = d ? prefs.dislikeDomains[d] || 0 : 0;
      if (ld) reasons.push({ kind: "like", label: `You liked stories from this site (${ld})`, points: r2(0.08 * Math.min(1, log2(1 + ld) / 3)) });
      if (dd >= 2) reasons.push({ kind: "dislike", label: `You disliked stories from this site (${dd})`, points: -0.1 });
      const lt = titles[i].contribs.filter((c) => !c.via).map((c) => prefs.likeTags[c.tag] || 0).reduce((a, x) => Math.max(a, x), 0);
      if (lt) reasons.push({ kind: "like", label: "Its tags are ones you liked", points: r2(0.05 * Math.min(1, log2(1 + lt) / 3)) });
    }
    if (karma && st.by && karma[st.by] >= 5000) reasons.push({ kind: "karma", label: `Submitted by a high-karma user (${karma[st.by] >= 1000 ? `${Math.round(karma[st.by] / 1000)}k` : karma[st.by]})`, points: 0.03 });
    const r = finish(reasons, s);
    const matches = r.reasons.filter((x) => x.kind === "tag").length;
    let bucket = ready ? bucketFor(r.score, s) : "maybe";
    if (!ready) r.reasons.push({ kind: "note", label: "No interests synced yet, so nothing is ranked", points: 0 });
    let blocked = null;
    const hit = blocks ? matchBlock(blocks, st) : null;
    if (hit) {
      if (r.score >= s.blockOverrideAt) r.reasons.push({ kind: "block", label: `Blocked by "${hit.group}" but kept: strong match`, points: 0 });
      else { bucket = "toss"; blocked = hit; r.reasons.unshift({ kind: "block", label: `Blocked: ${hit.group} (${hit.pattern})`, points: 0 }); }
    }
    if (gone.has(String(st.id))) { bucket = "toss"; r.reasons.unshift({ kind: "note", label: "You marked this not for you", points: 0 }); }
    const pref = prefs?.items?.[st.id];
    if (pref === "like" && bucket !== "keep") { bucket = "keep"; r.reasons.unshift({ kind: "like", label: "You liked this", points: 0 }); }
    if (pref === "dislike") { bucket = "toss"; r.reasons.unshift({ kind: "dislike", label: "You disliked this", points: 0 }); }
    return { id: st.id, pref: pref || null, disliked: pref === "dislike", ...r, bucket, matches, blocked, dismissed: gone.has(String(st.id)), tags: r.reasons.filter((x) => x.kind === "tag").map((x) => x.tag), gravity: r2(gravity(st.points, st.age)) };
  });
  // Near-clusters: lift stories on the same topic as a keep; mark unmatched clusters as emerging.
  const clusters = nearClusters(stories, out);
  const unmatchedCluster = new Map();
  for (const g of clusters) {
    const keepers = g.filter((i) => out[i].bucket === "keep");
    if (ready && keepers.length) {
      const lead = stories[keepers[0]];
      for (const i of g) {
        const v = out[i];
        if (v.bucket === "keep" || v.blocked || v.dismissed || v.disliked) continue;
        v.reasons.push({ kind: "cluster", label: `Same topic as a story you keep: ${lead.title.slice(0, 60)}`, points: 0.1 });
        const f = finish(v.reasons, s);
        Object.assign(v, f, { bucket: bucketFor(f.score, s), clusterOf: lead.id });
      }
    }
    const unmatched = g.filter((i) => out[i].matches === 0);
    if (unmatched.length >= 2) for (const i of unmatched) unmatchedCluster.set(stories[i].id, unmatched.length - 1);
  }
  if (ready) {
    const vocab = new Set(graph ? graph.vocabulary() : []);
    for (const f of [...(profile?.fav || []), ...(opened?.titles || []), ...(prefs?.likeTitles || [])]) for (const t of f.terms || []) vocab.add(t);
    pickDiscover(stories, out, { vocab, domains: { ...(profile?.domains || {}), ...(opened?.domains || {}) }, karma, unmatchedCluster }, s);
  }
  return out;
}

function matchBlock(blocks, st) {
  for (const g of blocks) {
    for (const { re, pattern } of g.rules) {
      if ((g.fields.includes("title") && re.test(st.title || "")) || (g.fields.includes("domain") && re.test(st.domain || ""))) return { group: g.name, pattern };
    }
  }
  return null;
}

// ---- Discover: what you would not have known ----
// A story qualifies when it is unfamiliar (little of its wording is anywhere in your tags, opens, likes or
// favourites, and the site is new to you) and the home page says it is worth a look (votes per hour,
// a healthy comment-to-point ratio, the submitter's karma). Several unrelated submissions on one new
// subject make it an emerging topic. The score is the weighted sum shown in the reasons:
//   0.45 x novelty + 0.30 x quality + 0.15 x new site + 0.10 x emerging
function pickDiscover(stories, out, ctx, s) {
  const k = Math.max(0, Math.min(15, s.discoverCount ?? 5));
  if (!k) return;
  const known = ctx.vocab;
  const grav = stories.map((st) => gravity(st.points, st.age)).filter((g) => g > 0).sort((a, b) => a - b);
  const medianG = grav.length ? grav[Math.floor(grav.length / 2)] : 1;
  const cands = [];
  stories.forEach((st, i) => {
    const v = out[i];
    if (v.blocked || v.dismissed || v.disliked || v.matches > 0 || v.bucket === "keep") return;
    const pts = st.points || 0, com = st.comments || 0;
    if (pts < 20 && com < 15) return;
    const words = [...new Set(tokenize(st.title))].filter((w) => w.length > 3);
    if (words.length < 2) return;
    const fam = words.filter((w) => known.has(w)).length / words.length;
    const novelty = 1 - fam;
    if (novelty < 0.5) return;
    const vel = Math.min(1, gravity(pts, st.age) / (2 * medianG || 1));
    const ratio = pts ? com / pts : 0;
    const depth = ratio >= 0.3 && ratio <= 2 ? 1 : ratio > 2 && ratio <= 3 ? 0.4 : ratio > 0.1 ? 0.5 : 0;
    const kz = ctx.karma && st.by ? ctx.karma[st.by] : null;
    const kNorm = kz ? Math.min(1, Math.log10(1 + kz) / 5) : 0.3;
    const quality = 0.5 * vel + 0.35 * depth + 0.15 * kNorm;
    const d = st.domain;
    const newSite = d && !(ctx.domains?.[d] || ctx.domains?.[d.split("/")[0]]) ? 1 : 0;
    const emerging = ctx.unmatchedCluster.get(st.id) || 0;
    const score = 0.45 * novelty + 0.3 * quality + 0.15 * newSite + 0.1 * (emerging ? 1 : 0);
    cands.push({ i, score, novelty, quality, newSite, emerging, vel, ratio });
  });
  cands.sort((a, b) => b.score - a.score);
  for (const c of cands.slice(0, k)) {
    const st = stories[c.i], v = out[c.i];
    const reasons = [
      { kind: "discover", label: `Unfamiliar to you: ${Math.round(c.novelty * 100)}% of its words are in none of your tags, opens or likes`, points: r2(0.45 * c.novelty) },
      { kind: "discover", label: `Worth a look on HN: ${st.points} points, ${st.comments} comments${c.vel >= 0.5 ? ", rising fast" : ""}`, points: r2(0.3 * c.quality) },
      c.newSite ? { kind: "discover", label: `A site you have never saved: ${st.domain}`, points: 0.15 } : null,
      c.emerging ? { kind: "discover", label: `Emerging: ${c.emerging} other stories on this today`, points: 0.1 } : null,
    ].filter(Boolean);
    const total = r2(reasons.reduce((a, x) => a + x.points, 0));
    Object.assign(v, { bucket: "stretch", score: Math.min(1, total), total, reasons, discover: true });
  }
}

// Near-clusters on the page: stories sharing a tag or most of their title words. A story in the same
// cluster as one you keep is lifted; clusters of stories none of your tags touch are emerging topics.
function nearClusters(stories, out) {
  const terms = stories.map((st) => new Set(tokenize(st.title).filter((w) => w.length > 3)));
  const n = stories.length, parent = [...Array(n).keys()];
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const ti = out[i].tags || [], tj = new Set(out[j].tags || []);
    let shared = 0;
    for (const t of terms[i]) if (terms[j].has(t)) shared++;
    const jac = shared / Math.max(1, terms[i].size + terms[j].size - shared);
    if (ti.some((t) => tj.has(t)) || (shared >= 2 && jac >= 0.25)) parent[find(j)] = find(i);
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  return [...groups.values()].filter((g) => g.length > 1);
}

// Shared title words with a favourite: at least two, and a Jaccard overlap of 0.3 or more.
export function favSimilar(fav, title) {
  const t = new Set(tokenize(title));
  if (t.size < 2) return null;
  let best = null;
  for (const f of fav) {
    const ft = f.terms || [];
    let shared = 0;
    for (const x of ft) if (t.has(x)) shared++;
    if (shared < 2) continue;
    const j = shared / (t.size + ft.length - shared);
    if (j >= 0.3 && (!best || j > best.j)) best = { j, title: f.title };
  }
  return best;
}

// ---- comments (thread page) ----
// ctx: { scoring, hasGraph, story: { tags, score, terms } | null, parentTagPoints, karma }
const ON_TOPIC = new Set(["tag", "near", "context", "inherit"]);
const fmtK = (k) => (k >= 1000 ? `${(k / 1000).toFixed(k >= 10000 ? 0 : 1)}k` : String(k));

export function scoreComment(c, { scoring = SCORING_DEFAULTS, hasGraph = false, story = null, parentTagPoints = 0, karma = null } = {}) {
  const reasons = c.relevance ? tagReasons(c.relevance.tags) : [];
  for (const m of c.relevance?.muted || []) reasons.push({ kind: "muted", tag: m, label: `Muted tag: ${m}`, points: -0.3 });
  // A comment on the subject of a story you care about is on-topic even without your tag words.
  if (story && story.tags.length && story.score > 0 && c.tokens) {
    let shared = 0;
    for (const t of story.terms) if (c.tokens.has(t)) shared++;
    if (shared >= 1) reasons.push({ kind: "context", label: `On the thread's topic (${story.tags.slice(0, 2).join(", ")})`, points: r2(0.15 * story.score) });
  }
  if (parentTagPoints > 0) reasons.push({ kind: "inherit", label: "Continues a relevant comment", points: r2(Math.min(0.12, 0.3 * parentTagPoints)) });
  const ev = [];
  let evPts = 0;
  if (c.evidence?.link) { ev.push("link"); evPts += 0.08; }
  if (c.evidence?.number) { ev.push("number"); evPts += 0.05; }
  if (c.evidence?.code) { ev.push("code"); evPts += 0.08; }
  if (ev.length) reasons.push({ kind: "evidence", label: `Carries evidence: ${ev.join(", ")}`, points: r2(Math.min(0.15, evPts)) });
  if (c.rebuttal) reasons.push({ kind: "rebuttal", label: "Rebuttal: disagrees with its parent and adds a fact", points: 0.15 });
  if (c.score >= 700) reasons.push({ kind: "hn", label: "Ranked high by HN readers", points: r2(0.12 * (c.score / 1000)) });
  const k = karma && c.author ? karma[c.author] : null;
  const karmaNorm = k ? Math.min(1, Math.log10(1 + k) / 5) : 0;
  if (k >= 500) reasons.push({ kind: "karma", label: `Author karma ${fmtK(k)}`, points: r2(0.08 * karmaNorm) });
  const replies = Math.max(0, (c.subtree_size || 1) - 1);
  const replyNorm = Math.min(1, Math.log2(1 + replies) / 5);
  if (replies >= 2) reasons.push({ kind: "replies", label: `Drew ${replies} replies`, points: r2(0.06 * replyNorm) });
  if (c.op) reasons.push({ kind: "op", label: "Written by the submitter", points: 0.05 });
  const r = finish(reasons, scoring);
  // With interests synced, a comment that matches none of them sits below the floor, however much
  // evidence it carries: it stays on the page but is not sent. Rebuttals are protected in prune.js.
  const onTopic = r.reasons.some((x) => ON_TOPIC.has(x.kind));
  const bucket = hasGraph ? (onTopic ? bucketFor(r.score, scoring) : "toss") : r.score >= scoring.keepAt ? "keep" : "maybe";
  // Quality, for ordering only: HN's own vote-driven position, the author's karma and the replies drawn.
  const quality = r2(0.5 * ((c.score || 0) / 1000) + 0.3 * karmaNorm + 0.2 * replyNorm);
  const tagPoints = r2(r.reasons.filter((x) => x.kind === "tag" || x.kind === "near").reduce((a, x) => a + x.points, 0));
  return { ...r, bucket, quality, tagPoints, onTopic };
}

// "Best" order on a thread: mostly relevance, partly quality.
export const bestKey = (v) => 0.7 * (v.score || 0) + 0.3 * (v.quality || 0);

// Hacker News' published story ranking: (points - 1) / (hours + 2) ^ 1.8. Used to break ties.
export function gravity(points, ageIso, now = Date.now()) {
  const t = Date.parse(ageIso ? (/Z$|[+-]\d\d:?\d\d$/.test(ageIso) ? ageIso : `${ageIso}Z`) : "");
  const hours = Number.isFinite(t) ? Math.max(0, (now - t) / 36e5) : 24;
  return Math.max(0, (points || 0) - 1) / Math.pow(hours + 2, 1.8);
}
