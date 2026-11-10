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
export const RULES_VERSION = "0.3";

export const SCORING_DEFAULTS = {
  ceiling: 0.9,          // a total of this much reaches about 0.86
  keepAt: 0.55,
  maybeAt: 0.2,
  blockOverrideAt: 0.75, // a blocked story this relevant is kept anyway, and says so
  stretchPerKeeps: 4,    // one stretch pick per this many keeps
  stretchMax: 3,
  pages: 4,              // front pages merged into one list
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
export function scoreStories(stories, { graph = null, profile = null, blocks = null, scoring = SCORING_DEFAULTS, dismissed = [], opened = null } = {}) {
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
    return { id: st.id, ...r, bucket, matches, blocked, dismissed: gone.has(String(st.id)), tags: r.reasons.filter((x) => x.kind === "tag").map((x) => x.tag), gravity: r2(gravity(st.points, st.age)) };
  });
  if (ready) pickStretch(stories, out, profile, s);
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

// Things you do not know yet: no tag of yours fires, but the discussion looks substantial.
function pickStretch(stories, out, profile, s) {
  const keeps = out.filter((x) => x.bucket === "keep").length;
  const k = Math.min(s.stretchMax, Math.max(1, Math.ceil(keeps / s.stretchPerKeeps)));
  const cands = [];
  stories.forEach((st, i) => {
    const v = out[i];
    if (v.bucket !== "toss" || v.blocked || v.dismissed || v.matches > 0) return;
    const pts = st.points || 0, com = st.comments || 0;
    if (pts < 40 || com < 25) return;
    const ratio = com / pts;
    if (ratio < 0.25 || ratio > 2.5) return; // very high ratio usually means an argument
    const known = st.domain && (profile?.domains?.[st.domain] || profile?.domains?.[st.domain.split("/")[0]]);
    const surprise = Math.log(1 + com) * (known ? 1 : 1.25) * (ratio >= 0.6 ? 1.15 : 1);
    cands.push({ i, surprise, known, ratio });
  });
  cands.sort((a, b) => b.surprise - a.surprise);
  for (const c of cands.slice(0, k)) {
    const st = stories[c.i], v = out[c.i];
    const reasons = [
      { kind: "stretch", label: "None of your tags match", points: 0 },
      { kind: "stretch", label: `Deep discussion for its votes (${st.comments} comments on ${st.points} points)`, points: r2(0.12 * Math.min(1, c.ratio)) },
      { kind: "stretch", label: c.known ? "From a site you have saved before" : "From a site you have not saved before", points: c.known ? 0.05 : 0.15 },
      { kind: "stretch", label: "Sizeable thread", points: r2(0.05 * Math.min(1, Math.log10(1 + st.comments) / 2.5)) },
    ];
    const f = finish(reasons, s);
    Object.assign(v, { bucket: "stretch", score: f.score, total: f.total, reasons: f.reasons });
  }
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
