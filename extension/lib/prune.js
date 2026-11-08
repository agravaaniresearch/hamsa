// Deterministic cleanup: no model involved. Order matters and is documented in SCHEMA.md.
import { DEFAULTS, estTokens } from './config.js';

const wordCount = (s) => (s.match(/\S+/g) || []).length;
const hasNumber = (s) => /\d{2,}|\d+\s?%|[$€£₹]\s?\d/.test(s);

export function prune(thread, userCfg = {}, relModel = null) {
  const cfg = { ...DEFAULTS, ...userCfg };
  const all = thread.comments;
  const pruned = [];
  const stats = { rows_seen: all.length, unavailable: 0, pruned: { downvoted: 0, short: 0, flame_chain: 0, budget: 0 } };

  const drop = (c, reason, detail = '') => {
    c.dropped = reason;
    if (reason === 'unavailable') stats.unavailable++;
    else stats.pruned[reason]++;
    pruned.push({ id: c.id, path: c.path, author: c.author, reason, detail });
  };

  // 1. Unavailable rows.
  for (const c of all) if (c.status !== 'ok') drop(c, 'unavailable', c.status);

  // 2. Features and HN Companion's score, over live comments only.
  const live = all.filter((c) => !c.dropped);
  live.forEach((c, i) => {
    c.rank = i;
    c.op = !!c.author && c.author === thread.story.author;
    c.words = wordCount(c.text);
    c.evidence = { link: c.links.length > 0, code: c.has_code, number: hasNumber(c.text) };
    const base = Math.floor(1000 - (i * 1000) / live.length);
    c.score = Math.floor(Math.max(base - (base / 10) * c.downvotes, 0));
  });
  const isEvidence = (c) => c.evidence.link || c.evidence.code || c.evidence.number;

  // Personal relevance (see src/relevance/model.js). Without a model every comment is neutral.
  const rels = relModel ? relModel.scoreBatch(live.map((c) => c.text)) : null;
  live.forEach((c, i) => {
    c.rel = rels ? rels[i].score : 0;
    c.relevance = rels ? rels[i] : null;
  });

  // 3. Downvoted.
  for (const c of live) {
    if (c.downvotes >= cfg.maxDownvotes) drop(c, 'downvoted', `${c.downvotes} downvotes`);
  }

  // 4. Flame chains: two authors alternating A B A B ... along one reply path.
  //    Runs before the short-comment rule, because short snipes are what make a chain.
  const byPath = new Map(live.filter((c) => !c.dropped).map((c) => [c.path, c]));
  const run = new Map();
  for (const c of byPath.values()) {
    const p = c.parent_path && byPath.get(c.parent_path);
    if (!p || p.author === c.author) { run.set(c.path, 1); continue; }
    const g = p.parent_path && byPath.get(p.parent_path);
    run.set(c.path, g && g.author === c.author && run.get(p.path) >= 2 ? run.get(p.path) + 1 : 2);
  }
  const members = new Map(); // path -> chain id
  let chainId = 0;
  for (const c of byPath.values()) {
    const r = run.get(c.path);
    if (r < cfg.chainMinRun) continue;
    // mark this node and the r-1 ancestors that form the alternation
    let node = c, id = null;
    for (let k = 0; k < r && node; k++) {
      if (members.has(node.path)) id = members.get(node.path);
      node = node.parent_path ? byPath.get(node.parent_path) : null;
    }
    id = id ?? ++chainId;
    node = c;
    for (let k = 0; k < r && node; k++) {
      members.set(node.path, id);
      node = node.parent_path ? byPath.get(node.parent_path) : null;
    }
  }
  const chains = new Map();
  for (const [path, id] of members) {
    if (!chains.has(id)) chains.set(id, []);
    chains.get(id).push(byPath.get(path));
  }
  for (const group of chains.values()) {
    group.sort((a, b) => a.rank - b.rank);
    const first = group[0];
    const longest = group.reduce((m, c) => (c.words > m.words ? c : m), group[0]);
    for (const c of group) {
      const keep = c === first || c === longest || c.op || c.evidence.link || c.evidence.code
        || c.words >= cfg.chainKeepWords || c.rel >= cfg.relKeep;
      if (!keep) drop(c, 'flame_chain', `kept ${first.path} and ${longest.path}`);
    }
  }

  // 5. Short comments with no evidence.
  for (const c of live) {
    if (c.dropped) continue;
    // A short comment that drew replies is kept: the replies need it, and HN weighs reply count too.
    if (c.words < cfg.minWords && !isEvidence(c) && !c.op && c.subtree_size <= 1 && c.rel < cfg.relKeep) drop(c, 'short', `${c.words} words`);
  }

  // 6. Token budget: lowest priority first.
  let kept = live.filter((c) => !c.dropped);
  const cost = (c) => estTokens(c.text) + cfg.lineOverheadTokens;
  let total = kept.reduce((s, c) => s + cost(c), 0);
  if (total > cfg.budgetTokens) {
    const priority = (c) => c.score * (1 + cfg.relLambda * c.rel) * (c.op ? cfg.opBoost : 1) * (isEvidence(c) ? cfg.evidenceBoost : 1);
    const order = [...kept].sort((a, b) => priority(a) - priority(b) || b.rank - a.rank);
    for (const c of order) {
      if (total <= cfg.budgetTokens) break;
      drop(c, 'budget', `priority ${Math.round(priority(c))}`);
      total -= cost(c);
    }
    kept = live.filter((c) => !c.dropped);
  }

  stats.kept = kept.length;
  stats.est_tokens = total;
  return { kept, pruned, stats, config: cfg };
}
