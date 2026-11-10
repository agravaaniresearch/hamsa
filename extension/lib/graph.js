// Tag-graph relevance. Domain-agnostic: the graph is built from any items that carry tags and text
// (bookmarks today; TPS plans or literature records later). It replaces the interest.md profile and
// the vote-trained Bayes model of the CLI prototype.
//
//   build      raw tag statistics from items: per-tag term counts, tag counts, tag co-occurrence
//   compile    turns the raw statistics into weights (cheap; runs whenever the state changes)
//   scoreBatch the same call the pruner already uses: texts in, { score in [-1, 1], reasons } out
//
// A tag is "activated" by a text when at least two of its distinctive terms appear (or its own name
// does). Activation spreads a little along co-occurrence edges, so a text about "federated" can
// reach "sovereign ai". Muted tags subtract instead of add. Feedback moves one number per tag.
import { tokenize } from "./tokenize.js";

export const SCHEMA = "hamsa.graph/1";

// Tags that describe workflow, not subject matter. Matched case-insensitively against the tag name.
export const STRUCTURAL = [
  /^\d{4}s?$/, /^\d{1,2}(st|nd|rd|th)-century$/i,
  // workflow labels
  /^(to-?read|read-?later|inbox|unsorted|todo|misc|temp|archive|favou?rites?|important|later|new|list|reference)$/i,
  // format and genre labels: they say how a page is written, not what it is about
  /^(essay|news|longform|blog|howto|how-to|explainer|guide|report|review|opinion|analysis|interview|profile|tutorial|paper|case-study|book-review|newsletters?|publications?|podcast|video|media|personal-story|gallery|photo-essay|classic|criticism|working-paper|journal-article|investigation)$/i,
];

const W_TITLE = 2, W_NAME = 3, W_EXCERPT = 1, W_NOTE = 2, W_HIGHLIGHT = 3;
const MAX_TERMS_PER_TAG = 200;
const TOP_TERMS = 60;          // distinctive terms kept per tag when compiling
const TAG_REF = 2.0;           // summed term weight at which one tag is fully activated
const SPREAD = 0.4;            // share of a neighbour's activation passed along an edge
const MIN_EDGE = 0.05;         // Jaccard below this is not an edge
const NEIGHBOURS = 8;
const MUTE_PENALTY = 0.6;
const SCORE_REF = 1.2;         // summed top-3 contribution that counts as a strong absolute match
const K1 = 1.2, B = 0.75;
const MIN_TERM_DOCS = 2;       // a term must recur in this many items under a tag to count
const MIN_ACT = 0.2;           // weaker activations are noise
const MIN_TAG_COUNT = 4;      // a tag used fewer times than this is a one-off, not yet an interest
const ADJ_LIMIT = 2;

const r2 = (x) => Math.round(x * 100) / 100;
const uniq = (a) => [...new Set(a)];

export function isStructural(tag, extra = []) {
  return STRUCTURAL.some((re) => re.test(tag)) || extra.some((t) => t.toLowerCase() === tag.toLowerCase());
}

export function emptyState() {
  return { schema: SCHEMA, built_at: 0, n_items: 0, tags: {}, cooc: {}, adj: {}, muted: [], excluded: [], params: { minTagCount: MIN_TAG_COUNT, minTermDocs: MIN_TERM_DOCS } };
}

function addTerms(tf, tokens, weight) {
  for (const t of uniq(tokens)) tf[t] = (tf[t] || 0) + weight;
}
// Number of distinct items a term appeared in under a tag. One-off title words are noise.
function addDocs(dc, tokens) {
  for (const t of uniq(tokens)) dc[t] = (dc[t] || 0) + 1;
}

// Adds one item's evidence to the raw statistics. Used for the first build and for every later save.
export function addItem(state, item) {
  const tags = uniq((item.tags || []).map((t) => String(t).trim()).filter(Boolean))
    .filter((t) => !isStructural(t, state.excluded));
  state.n_items += 1;
  if (!tags.length) return state;
  const title = tokenize(item.title || "");
  const excerpt = tokenize(item.excerpt || "");
  const note = tokenize(item.note || "");
  const highlights = (item.highlights || []).map((h) => tokenize(typeof h === "string" ? h : h.text || ""));
  for (const tag of tags) {
    const node = (state.tags[tag] ||= { count: 0, tf: {}, dc: {}, last: 0 });
    node.dc ||= {};
    node.count += 1;
    addDocs(node.dc, [...tokenize(tag), ...title, ...excerpt, ...note, ...highlights.flat()]);
    node.last = Math.max(node.last, item.created ? Date.parse(item.created) || 0 : 0);
    addTerms(node.tf, tokenize(tag), W_NAME);
    addTerms(node.tf, title, W_TITLE);
    addTerms(node.tf, excerpt, W_EXCERPT);
    addTerms(node.tf, note, W_NOTE);
    for (const h of highlights) addTerms(node.tf, h, W_HIGHLIGHT);
  }
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const key = [tags[i], tags[j]].sort().join("\u0001");
      state.cooc[key] = (state.cooc[key] || 0) + 1;
    }
  }
  return state;
}

export function buildState(items, { excluded = [], params = {} } = {}) {
  const state = emptyState();
  state.excluded = excluded;
  state.params = { ...state.params, ...params };
  for (const it of items) addItem(state, it);
  state.built_at = Date.now();
  return trim(state);
}

// Keeps the stored state small: only each tag's strongest raw terms survive.
function trim(state) {
  for (const node of Object.values(state.tags)) {
    const keep = Object.entries(node.tf).sort((a, b) => b[1] - a[1]).slice(0, MAX_TERMS_PER_TAG);
    node.tf = Object.fromEntries(keep);
    node.dc = Object.fromEntries(keep.map(([t]) => [t, node.dc?.[t] || 0]));
  }
  return state;
}

// Raw statistics -> scoring weights.
export function compile(state) {
  const names = Object.keys(state.tags);
  const T = names.length || 1;
  const df = new Map();
  for (const n of names) for (const t of Object.keys(state.tags[n].tf)) df.set(t, (df.get(t) || 0) + 1);
  const compiled = new Map();
  for (const n of names) {
    const node = state.tags[n];
    if (node.count < (state.params?.minTagCount ?? MIN_TAG_COUNT)) continue;
    const nameSet = new Set(tokenize(n));
    const scored = Object.entries(node.tf).filter(([t]) => nameSet.has(t) || (node.dc?.[t] || 0) >= (state.params?.minTermDocs ?? MIN_TERM_DOCS)).map(([t, tf]) => [t, (1 + Math.log(tf)) * Math.log(1 + T / df.get(t))]);
    scored.sort((a, b) => b[1] - a[1]);
    const top = scored.slice(0, TOP_TERMS);
    const max = top[0]?.[1] || 1;
    const terms = new Map(top.map(([t, w]) => [t, w / max]));
    const nameTokens = new Set(tokenize(n));
    // Specific tags carry the signal: a tag on a tenth of everything saved says little about what
    // matters now. Tags seen only once or twice are damped as likely one-offs.
    const N = Math.max(2, state.n_items);
    const specific = Math.log(N / Math.max(1, node.count)) / Math.log(N);
    const seen = Math.min(1, Math.log(1 + node.count) / Math.log(4));
    // Anchors are the terms that identify a tag: its own name and terms found under at most three tags.
    // A tag fires only when an anchor appears, so generic words (plan, cost, use) cannot activate it alone.
    const anchors = new Set([...nameTokens, ...top.filter(([t]) => df.get(t) <= 3).map(([t]) => t)]);
    compiled.set(n, { terms, nameTokens, anchors, weight: Math.max(0.02, specific * seen) });
  }
  const edges = new Map();
  for (const [key, c] of Object.entries(state.cooc)) {
    const [a, b] = key.split("\u0001");
    const ca = state.tags[a]?.count, cb = state.tags[b]?.count;
    if (!ca || !cb) continue;
    const j = c / (ca + cb - c);
    if (j < MIN_EDGE) continue;
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!edges.has(x)) edges.set(x, []);
      edges.get(x).push([y, Math.min(1, j * 3)]);
    }
  }
  for (const [k, list] of edges) edges.set(k, list.sort((p, q) => q[1] - p[1]).slice(0, NEIGHBOURS));
  return { state, tags: compiled, edges };
}

export class TagGraph {
  constructor(state = emptyState()) {
    this.state = { ...emptyState(), ...state };
    this.c = compile(this.state);
  }

  recompile() { this.c = compile(this.state); this._vocab = null; }

  get size() { return Object.keys(this.state.tags).length; }

  adj(tag) { return this.state.adj[tag] || 0; }
  isMuted(tag) { return this.state.muted.includes(tag); }

  boost(tag) { this.state.adj[tag] = Math.min(ADJ_LIMIT, this.adj(tag) + 1); this.state.muted = this.state.muted.filter((t) => t !== tag); }
  mute(tag) { if (!this.isMuted(tag)) this.state.muted.push(tag); }
  reset(tag) { delete this.state.adj[tag]; this.state.muted = this.state.muted.filter((t) => t !== tag); }

  // Thumbs and implicit signals nudge the tags that fired on a point. delta is about +-0.3 for a thumb.
  nudge(tags, delta) {
    for (const t of tags) {
      if (!this.state.tags[t]) continue;
      this.state.adj[t] = Math.max(-ADJ_LIMIT, Math.min(ADJ_LIMIT, r2(this.adj(t) + delta)));
    }
  }

  add(item) { addItem(this.state, item); this.state.built_at = Date.now(); this.recompile(); }

  scoreBatch(texts) {
    const docs = texts.map((t) => tokenize(t));
    const N = docs.length || 1;
    const avgLen = docs.reduce((a, d) => a + d.length, 0) / N || 1;
    const tagEntries = [...this.c.tags];
    // A term that fills the whole thread ("model" in an AI thread) cannot tell comments apart.
    const df = new Map();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
    const bidf = (t) => Math.log(1 + (N + 0.5) / ((df.get(t) || 0) + 0.5)) / Math.log(2 + N);

    const raws = docs.map((tokens) => {
      if (!tokens.length) return { act: new Map(), terms: new Map() };
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      const norm = 1 - B + (B * tokens.length) / avgLen;
      const act = new Map(), why = new Map();
      for (const [name, info] of tagEntries) {
        let sum = 0, hits = 0, nameHit = false, anchorHit = false;
        const matched = [];
        for (const [term, w] of info.terms) {
          const f = tf.get(term);
          if (!f) continue;
          sum += w * bidf(term) * ((f * (K1 + 1)) / (f + K1 * norm));
          hits += 1; matched.push(term);
          if (info.nameTokens.has(term)) nameHit = true;
          if (info.anchors.has(term)) anchorHit = true;
        }
        if (anchorHit && (hits >= 2 || (nameHit && info.nameTokens.size > 1))) {
          const a = Math.min(1, sum / TAG_REF);
          if (a >= MIN_ACT) { act.set(name, a); why.set(name, matched.slice(0, 3)); }
        }
      }
      return { act, why };
    });

    const detailed = raws.map(({ act, why }) => {
      // Spread along edges: a neighbour is reached, not matched.
      const reached = new Map();
      for (const [name, a] of act) {
        for (const [nb, edge] of this.c.edges.get(name) || []) {
          const v = SPREAD * edge * a;
          if (v > (act.get(nb) || 0) && v > (reached.get(nb) || 0)) reached.set(nb, v);
        }
      }
      const contribs = [];
      const muted = [];
      let penalty = 0;
      const consider = (name, a, via) => {
        const info = this.c.tags.get(name);
        if (!info) return;
        if (this.isMuted(name)) { if (!via) { penalty += MUTE_PENALTY * a; muted.push(name); } return; }
        const w = info.weight * Math.exp(this.adj(name));
        contribs.push({ tag: name, via, a, w, weight: info.weight, value: w * a });
      };
      for (const [name, a] of act) consider(name, a, false);
      for (const [name, a] of reached) consider(name, a, true);
      contribs.sort((x, y) => y.value - x.value);
      const top = contribs.slice(0, 3);
      return { pos: top.reduce((s, c) => s + c.value, 0), penalty, top, why, muted };
    });

    // Scale against this thread, not against an absolute yardstick: in an all-AI thread nearly every
    // comment touches an AI tag, and what the reader needs is which ones touch it most. The median of
    // the batch is the floor and its 95th percentile (at least SCORE_REF above the floor) the ceiling.
    const raws2 = detailed.map((d) => Math.max(0, d.pos)).sort((a, b) => a - b);
    const lo = raws2.length >= 20 ? raws2[Math.floor(0.5 * (raws2.length - 1))] || 0 : 0; // a median means nothing in a tiny batch
    const p95 = raws2[Math.floor(0.95 * (raws2.length - 1))] || 0;
    const hi = raws2.length >= 20 ? Math.max(lo + SCORE_REF * 0.5, p95) : SCORE_REF; // small batches use the absolute yardstick

    return detailed.map(({ pos, penalty, top, why, muted }) => {
      const rel = Math.max(0, Math.min(1, (pos - lo) / (hi - lo)));
      const score = Math.max(-1, rel - penalty);
      return {
        score: r2(score), abs: r2(Math.min(1, pos / SCORE_REF)), cold: r2(score), learned: 0, w: 0,
        terms: { matched: top.filter((c) => !c.via).map((c) => c.tag), up: [], down: [] },
        tags: top.map((c) => ({ tag: c.tag, via: c.via, a: r2(c.a), w: r2(c.w), weight: r2(c.weight), terms: c.via ? [] : why.get(c.tag) || [] })),
        muted,
      };
    });
  }

  // Short texts (story titles). A title is a handful of words, so the comment rule (an anchor plus a
  // second term) almost never fires. Here a tag also fires when every word of its name is in the title.
  // Absolute: no scaling against the batch, so a title scores the same on any page.
  scoreTitles(texts) {
    const tagEntries = [...this.c.tags];
    return texts.map((text) => {
      const set = new Set(tokenize(text));
      const act = new Map();
      if (set.size) {
        for (const [name, info] of tagEntries) {
          const nameAll = info.nameTokens.size > 0 && [...info.nameTokens].every((t) => set.has(t));
          let sum = 0, hits = 0, anchor = false;
          for (const [term, w] of info.terms) {
            if (!set.has(term)) continue;
            sum += w; hits += 1;
            if (info.anchors.has(term)) anchor = true;
          }
          const a = nameAll ? 1 : anchor && hits >= 2 ? Math.min(1, sum / TAG_REF) : 0;
          if (a >= MIN_ACT) act.set(name, a);
        }
      }
      const reached = new Map();
      for (const [name, a] of act) {
        for (const [nb, edge] of this.c.edges.get(name) || []) {
          const v = SPREAD * edge * a;
          if (!act.has(nb) && v >= MIN_ACT * SPREAD && v > (reached.get(nb) || 0)) reached.set(nb, v);
        }
      }
      const contribs = [], muted = [];
      const consider = (name, a, via) => {
        const info = this.c.tags.get(name);
        if (!info) return;
        if (this.isMuted(name)) { if (!via) muted.push(name); return; }
        const w = info.weight * Math.exp(this.adj(name));
        contribs.push({ tag: name, via, a: r2(a), w: r2(w), weight: r2(info.weight), value: w * a });
      };
      for (const [n, a] of act) consider(n, a, false);
      for (const [n, a] of reached) consider(n, a, true);
      contribs.sort((x, y) => y.value - x.value);
      return { contribs: contribs.slice(0, 4), muted };
    });
  }

  // Every term the compiled tags know: what counts as familiar for Discover.
  vocabulary() {
    if (!this._vocab) { this._vocab = new Set(); for (const info of this.c.tags.values()) { for (const t of info.terms.keys()) this._vocab.add(t); for (const t of info.nameTokens) this._vocab.add(t); } }
    return this._vocab;
  }

  // Tag names and counts, for clustering and the options page.
  tagNames() { return [...this.c.tags.keys()]; }

  score(text) { return this.scoreBatch([text])[0]; }

  // The tags that drive scores most, for the options page.
  topTags(n = 15) {
    return [...this.c.tags].sort((a, b) => b[1].weight - a[1].weight).slice(0, n).map(([name, i]) => ({ tag: name, weight: r2(i.weight), count: this.state.tags[name].count }));
  }

  toJSON() { return this.state; }
}

export function explain(rel) {
  const direct = rel.tags.filter((t) => !t.via).map((t) => t.tag);
  const via = rel.tags.filter((t) => t.via).map((t) => t.tag);
  const bits = [];
  if (direct.length) bits.push(`matches your tags: ${direct.join(", ")}`);
  if (via.length) bits.push(`close to: ${via.join(", ")}`);
  return bits.join("; ");
}
