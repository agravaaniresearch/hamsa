// Strands: the conversations inside one thread (replaces 0.6's word-only sub-discussions).
//
//   1. Seeds. Each top-level comment with its replies is a branch: HN's own structure is the
//      strongest signal of "one conversation", and it costs nothing.
//   2. Merge. Each branch gets a profile of its distinctive words (tf x idf over branches). Two branches
//      merge when the cosine similarity of their profiles is at least MERGE_AT, even if they sit far
//      apart in the thread. Greedy, biggest branch first.
//   3. Kind. Simple text rules label what sort of conversation it is (debate, experience, explainer,
//      alternatives, stance, meta); the kind whose rule fires on the largest share of the strand's
//      comments wins if that share is at least KIND_AT, otherwise "discussion".
//   4. Relevance. The mean of the comments' own 0 to 1 scores, so a strand can be ranked as a whole.
//
// Local, deterministic, no model. It misses synonyms; a strand name from a model stays optional.
import { tokenize, words } from "./tokenize.js";

const TOP_TERMS = 12, MERGE_AT = 0.22, KIND_AT = 0.2;
export const KINDS = ["debate", "experience", "explainer", "alternatives", "stance", "meta", "discussion"];
const VAGUE = new Set(tokenize("perhaps probably something anything anyone everyone everything actually pretty quite enough though although without rather almost always never better great good years today point sure kind using work works worked even agree disagree right wrong true false example comment comments article post thread question answer reason problem issue case idea part whole fact least seems seem simply literally definitely certainly especially usually generally instead already maybe yeah okay people thing things really"));

// One rule per kind, tested on each comment's text. Order breaks ties.
const RULES = {
  debate: (c) => /^\s*>/m.test(c.text) || /\b(disagree|that's not|that is not|not true|you're wrong|no, |nope|citation needed|source\?|strawman|that's wrong)\b/i.test(c.text),
  experience: (c) => /\b(i use|i've used|i have used|i've been using|we use|we run|i run|in production|my setup|at work we|in my experience|i switched|we switched)\b/i.test(c.text),
  explainer: (c) => (c.text.length > 700 && (c.subtree_size || 1) <= 3) || /\b(the way it works|under the hood|because the|how it works|the reason is|in short,)\b/i.test(c.text),
  alternatives: (c) => /\b(have you tried|alternatives?|instead of|switched to|check out|i recommend|you could try|try out)\b/i.test(c.text),
  stance: (c) => /\b(i don't use|i do not use|i refuse|zero usage|not using (it|any|ai)|i avoid|won't touch|none, no)\b/i.test(c.text),
  meta: (c) => /\b(hn|hacker news|downvot|flagged|this title|the title|submitter|dang|this thread|off.topic)\b/i.test(c.text),
};

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [, w] of a) na += w * w;
  for (const [, w] of b) nb += w * w;
  for (const [t, w] of a) { const v = b.get(t); if (v) dot += w * v; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function buildStrands(comments, { minComments = 6, maxStrands = 8, mutedKinds = [] } = {}) {
  const live = comments.filter((c) => c.status === "ok" && !(c.dropped && c.dropped !== "below_floor" && c.dropped !== "budget"));
  const branchOf = (c) => c.path.split(".")[0];
  const branches = new Map();
  const surface = new Map(); // stem -> { word -> count }: labels use words as people wrote them
  for (const c of live) {
    const b = branchOf(c);
    if (!branches.has(b)) branches.set(b, { root: b, tf: new Map(), comments: [] });
    const br = branches.get(b);
    br.comments.push(c);
    for (const t of tokenize(c.text)) if (t.length > 3 && !VAGUE.has(t)) br.tf.set(t, (br.tf.get(t) || 0) + 1);
    for (const w of words(c.text)) {
      if (w.length <= 3) continue;
      const st = tokenize(w)[0];
      if (!st) continue;
      if (!surface.has(st)) surface.set(st, new Map());
      surface.get(st).set(w, (surface.get(st).get(w) || 0) + 1);
    }
  }
  const list = [...branches.values()];
  if (list.length < 3) return { groups: [], byBranch: {} };
  const df = new Map();
  for (const br of list) for (const t of br.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = list.length;
  for (const br of list) {
    const scored = [...br.tf].filter(([t]) => df.get(t) <= Math.max(2, N * 0.5)).map(([t, f]) => [t, f * Math.log(1 + N / df.get(t))]);
    scored.sort((a, b) => b[1] - a[1]);
    br.vec = new Map(scored.slice(0, TOP_TERMS));
  }
  // 2. Merge, biggest branch first.
  list.sort((a, b) => b.comments.length - a.comments.length);
  const groups = [];
  for (const br of list) {
    let best = null, bestSim = 0;
    for (const g of groups) { const s = cosine(br.vec, g.vec); if (s >= MERGE_AT && s > bestSim) { best = g; bestSim = s; } }
    if (best) {
      best.branches.push(br.root);
      best.comments.push(...br.comments);
      for (const [t, w] of br.vec) best.vec.set(t, (best.vec.get(t) || 0) + w);
    } else groups.push({ branches: [br.root], comments: [...br.comments], vec: new Map(br.vec) });
  }
  const word = (stem) => { const m = surface.get(stem); return m ? [...m].sort((a, b) => b[1] - a[1])[0][0] : stem; };
  // 3. Kind, 4. relevance.
  const real = groups.filter((g) => g.comments.length >= minComments && (g.branches.length > 1 || g.comments.length >= minComments * 2));
  real.sort((a, b) => b.comments.length - a.comments.length);
  const out = [];
  for (const g of real) {
    const n = g.comments.length;
    let kind = "discussion", share = 0;
    for (const k of Object.keys(RULES)) {
      const s = g.comments.filter(RULES[k]).length / n;
      if (s >= KIND_AT && s > share) { kind = k; share = s; }
    }
    if (mutedKinds.includes(kind)) continue;
    const terms = [...g.vec].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => word(t));
    const rel = g.comments.reduce((a, c) => a + (c.verdict?.score ?? c.rel ?? 0), 0) / n;
    const people = new Set(g.comments.map((c) => c.author).filter(Boolean)).size;
    const why = [`${n} comments, ${people} people`];
    if (g.branches.length > 1) why.push(`${g.branches.length} separate branches merged on shared words`);
    if (kind !== "discussion") why.push(`${Math.round(share * 100)}% of its comments read as ${kind}`);
    out.push({
      id: `s${out.length + 1}`, kind, label: terms.slice(0, 3).join(", "), terms,
      colour: KINDS.indexOf(kind), branches: g.branches, count: n, people,
      relevance: Math.round(rel * 100) / 100, why,
      ids: g.comments.map((c) => c.id),
    });
    if (out.length >= maxStrands) break;
  }
  const byBranch = {};
  for (const s of out) for (const b of s.branches) byBranch[b] = s.id;
  const other = list.filter((br) => !byBranch[br.root]);
  if (out.length && other.length) {
    const s = { id: "other", kind: "other", label: "Everything else", terms: [], colour: -1, branches: other.map((b) => b.root), count: other.reduce((a, b) => a + b.comments.length, 0), people: 0, relevance: 0, why: [], ids: [] };
    out.push(s);
    for (const b of s.branches) byBranch[b] = "other";
  }
  return { groups: out.length > 1 ? out : [], byBranch: out.length > 1 ? byBranch : {} };
}
