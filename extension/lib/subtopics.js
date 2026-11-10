// Sub-discussions in a thread: each top-level comment and its replies is a branch; branches that share
// their distinctive words (words common in the branch, rare in the rest of the thread) become one
// sub-discussion, labelled with those words as people wrote them. Word-based and local; it misses synonyms.
import { tokenize, words } from "./tokenize.js";

const TOP_TERMS = 8;
// Words that say nothing about what a branch is about.
const VAGUE = new Set(tokenize("perhaps probably something anything anyone everyone everything actually pretty quite enough though although without rather almost always never better great good years today point sure kind using work works worked even agree disagree right wrong true false example comment comments article post thread question answer reason problem issue case idea part whole fact least seems seem simply literally definitely certainly especially usually generally instead already maybe yeah okay"));

export function subDiscussions(comments, { minComments = 6, maxGroups = 7 } = {}) {
  const live = comments.filter((c) => c.status === "ok" && !(c.dropped && c.dropped !== "below_floor" && c.dropped !== "budget"));
  const branchOf = (c) => c.path.split(".")[0];
  const branches = new Map();
  const surface = new Map(); // stem -> { word -> count }, to label with real words
  for (const c of live) {
    const b = branchOf(c);
    if (!branches.has(b)) branches.set(b, { root: b, tf: new Map(), count: 0 });
    const br = branches.get(b);
    br.count++;
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
    br.top = scored.slice(0, TOP_TERMS);
    br.terms = new Set(br.top.map(([t]) => t));
  }
  // Greedy grouping, biggest branches first.
  list.sort((a, b) => b.count - a.count);
  const groups = [];
  for (const br of list) {
    let best = null, bestScore = 0;
    for (const g of groups) {
      let shared = 0;
      for (const t of br.terms) if (g.terms.has(t)) shared++;
      const j = shared / Math.max(1, br.terms.size + g.terms.size - shared);
      if ((shared >= 3 || j >= 0.2) && j > bestScore) { best = g; bestScore = j; }
    }
    if (best) {
      best.branches.push(br.root); best.count += br.count;
      for (const [t, w] of br.top) best.weight.set(t, (best.weight.get(t) || 0) + w);
      for (const t of br.terms) best.terms.add(t);
    } else {
      groups.push({ branches: [br.root], count: br.count, terms: new Set(br.terms), weight: new Map(br.top) });
    }
  }
  const real = groups.filter((g) => g.count >= minComments && g.branches.length >= 1 && (g.branches.length > 1 || g.count >= minComments * 2));
  real.sort((a, b) => b.count - a.count);
  const kept = real.slice(0, maxGroups);
  const word = (stem) => { const m = surface.get(stem); return m ? [...m].sort((a, b) => b[1] - a[1])[0][0] : stem; };
  const out = kept.map((g, i) => ({
    id: `t${i + 1}`,
    label: [...g.weight].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => word(t)).join(", "),
    branches: g.branches, count: g.count,
  }));
  const byBranch = {};
  for (const g of out) for (const b of g.branches) byBranch[b] = g.id;
  const other = list.filter((br) => !byBranch[br.root]);
  if (out.length && other.length) {
    const g = { id: "other", label: "Everything else", branches: other.map((b) => b.root), count: other.reduce((a, b) => a + b.count, 0) };
    out.push(g);
    for (const b of g.branches) byBranch[b] = "other";
  }
  return { groups: out.length > 1 ? out : [], byBranch: out.length > 1 ? byBranch : {} };
}
