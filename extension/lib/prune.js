// Deterministic cleanup: no model involved. Order matters and is documented in SCHEMA.md.
// Every comment ends with a verdict: { score, total, reasons, bucket, rule, rules }.
// Depth never lowers a score; a rebuttal deep in a chain is protected, and so is the comment it answers.
import { DEFAULTS, estTokens } from './config.js';
import { scoreComment, SCORING_DEFAULTS, RULES_VERSION, squash, tagReasons } from './score.js';
import { tokenize } from './tokenize.js';

const wordCount = (s) => (s.match(/\S+/g) || []).length;
const hasNumber = (s) => /\d{2,}|\d+\s?%|[$€£₹]\s?\d/.test(s);

// Opening words of a reply that disagrees. Checked after any quoted lines.
const DISAGREE_START = /^(no[,.!]|nope\b|not (really|true|quite|exactly|so)\b|actually\b|but\b|however\b|i disagree|disagree\b|that'?s (not|wrong|incorrect|false)|this is (not|wrong|false)|wrong\b|incorrect\b|on the contrary|counter-?point|except\b|i don'?t think|that isn'?t|it isn'?t|it'?s not\b|false\b|citation needed)/i;
const DISAGREE_ANY = /\b(i disagree|that'?s not (true|correct|right|how)|this is (wrong|incorrect|false)|is (incorrect|false|not true)|not true\b|on the contrary|counter-?example|you'?re (wrong|mistaken)|that'?s a myth|in fact,)\b/i;
const INSULT = /\b(idiot|moron|imbecile|stupid|dumbass|retard\w*|shut up|clown|loser|pathetic|troll|fuck (you|off)|you('re| are) (an? )?(idiot|moron|clown|joke|fool))\b/i;
const CUSS = /\b(fuck\w*|shit\w*|bullshit|crap|asshole|dickhead|bastard)\b/gi;
const META = /\b(paywall(ed)?|archive\.(ph|is|today|org)|web\.archive|12ft\.io|clickbait|editoriali[sz]ed|misleading title|title (is|should be|was changed)|dupe\b|duplicate of|why is this (on|at) (the )?(front ?page|hn)|downvot(e|ed|es|ing)\b|flagged|cookie (banner|wall)|can'?t read (it|this|the article)|(unreadable|broken) on mobile|hn guidelines|please don'?t)\b/i;

export function prune(thread, userCfg = {}, relModel = null) {
  const cfg = { ...DEFAULTS, ...userCfg };
  const scoring = { ...SCORING_DEFAULTS, ...(userCfg.scoring || {}) };
  const all = thread.comments;
  const pruned = [];
  const stats = { rows_seen: all.length, unavailable: 0, pruned: { downvoted: 0, abusive: 0, flame_chain: 0, meta: 0, quote_only: 0, short: 0, duplicate: 0, below_floor: 0, budget: 0 } };

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
  const byPathLive = new Map(live.map((c) => [c.path, c]));
  live.forEach((c, i) => {
    c.rank = i;
    c.op = !!c.author && c.author === thread.story.author;
    c.words = wordCount(c.text);
    c.evidence = { link: c.links.length > 0, code: c.has_code, number: hasNumber(c.text) };
    const base = Math.floor(1000 - (i * 1000) / live.length);
    c.score = Math.floor(Math.max(base - (base / 10) * c.downvotes, 0));
  });
  const isEvidence = (c) => c.evidence.link || c.evidence.code || c.evidence.number;

  // Rebuttals: a reply that disagrees with its parent and brings something (evidence, or real length).
  for (const c of live) {
    const parent = c.parent_path ? byPathLive.get(c.parent_path) : null;
    if (!parent || parent.author === c.author) continue;
    const body = c.text.split('\n\n').filter((p) => !p.startsWith('>')).join(' ').trim();
    const head = body.split(/\s+/).slice(0, 30).join(' ');
    if ((DISAGREE_START.test(body) || DISAGREE_ANY.test(head)) && (isEvidence(c) || c.words >= 40)) {
      c.rebuttal = true;
      parent.answered = true; // kept as the parent of a rebuttal
    }
  }

  // Personal relevance (tag graph). Without a graph every comment is neutral.
  const rels = relModel ? relModel.scoreBatch(live.map((c) => c.text)) : null;
  // The story's own relevance: comments on its subject count as on-topic.
  let story = null;
  if (relModel) {
    const head = `${thread.story.title} ${(thread.story.text || '').slice(0, 400)}`;
    const st = relModel.scoreTitles([head])[0];
    const reasons = tagReasons(st.contribs.filter((x) => !x.via));
    story = {
      tags: reasons.map((x) => x.tag),
      score: squash(reasons.reduce((a, x) => a + x.points, 0), scoring.ceiling),
      terms: new Set(tokenize(head).filter((t) => t.length > 3)),
    };
  }
  thread.story.context = story ? { tags: story.tags, score: story.score } : null;
  // In document order, so a parent is always scored before its replies.
  live.forEach((c, i) => {
    c.rel = rels ? rels[i].score : 0;
    c.relevance = rels ? rels[i] : null;
    c.tokens = new Set(tokenize(c.text));
    const parent = c.parent_path ? byPathLive.get(c.parent_path) : null;
    c.verdict = scoreComment(c, { scoring, hasGraph: !!relModel, story, parentTagPoints: parent?.verdict?.tagPoints || 0, karma: cfg.karma });
  });
  const protectedC = (c) => c.rebuttal || c.answered || c.op;

  // 3. Downvoted.
  for (const c of live) {
    if (c.downvotes >= cfg.maxDownvotes) drop(c, 'downvoted', `${c.downvotes} downvotes`);
  }

  // 4. Abuse: insults, or a short burst of cussing, with nothing else in it.
  for (const c of live) {
    if (c.dropped || c.rel >= cfg.relKeep) continue;
    const cuss = (c.text.match(CUSS) || []).length;
    if ((INSULT.test(c.text) && c.words < 80 && !c.evidence.link && !c.evidence.code) || (cuss >= 2 && c.words < 40 && !isEvidence(c))) {
      drop(c, 'abusive', INSULT.test(c.text) ? 'insult' : `${cuss} swear words`);
    }
  }

  // 5. Flame chains: two authors alternating A B A B ... along one reply path.
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
    const last = group[group.length - 1];
    for (const c of group) {
      const keep = c === first || c === longest || c === last || protectedC(c) || c.evidence.link || c.evidence.code
        || c.words >= cfg.chainKeepWords || c.rel >= cfg.relKeep;
      if (!keep) drop(c, 'flame_chain', `${group.length} replies between two people; kept ${first.path}, ${longest.path} and ${last.path}`);
    }
  }

  // 6. Meta complaints (paywall, title, voting, the site itself) that add nothing about the subject.
  for (const c of live) {
    if (c.dropped || protectedC(c) || c.evidence.code) continue;
    if (c.words < 50 && META.test(c.text)) drop(c, 'meta', 'about the site, title or paywall');
  }

  // 7. Quote-only replies.
  for (const c of live) {
    if (c.dropped || protectedC(c)) continue;
    const paras = c.text.split('\n\n').map((p) => p.trim()).filter(Boolean);
    if (paras.length && paras.every((p) => p.startsWith('>'))) drop(c, 'quote_only', 'only quotes its parent');
  }

  // 8. Short comments with no evidence.
  for (const c of live) {
    if (c.dropped || protectedC(c)) continue;
    // A short comment that drew replies is kept: the replies need it, and HN weighs reply count too.
    if (c.words < cfg.minWords && !isEvidence(c) && c.subtree_size <= 1 && c.rel < cfg.relKeep) drop(c, 'short', `${c.words} words`);
  }

  // 9a. Near-duplicates: the same point made twice. The better-ranked comment stays and lists the others.
  {
    const shingles = (c) => { const t = tokenize(c.text); const out = new Set(); for (let i = 0; i + 2 < t.length; i++) out.add(`${t[i]} ${t[i + 1]} ${t[i + 2]}`); return out; };
    const pool = live.filter((c) => !c.dropped).map((c) => ({ c, sh: shingles(c) })).filter((x) => x.sh.size >= 6);
    const index = new Map();
    pool.forEach((x, i) => { for (const s of x.sh) { if (!index.has(s)) index.set(s, []); index.get(s).push(i); } });
    const pairs = new Map();
    for (const list of index.values()) {
      if (list.length < 2 || list.length > 40) continue;
      for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) { const k = `${list[a]}:${list[b]}`; pairs.set(k, (pairs.get(k) || 0) + 1); }
    }
    for (const [k, n] of pairs) {
      if (n < 2) continue;
      const [ia, ib] = k.split(':').map(Number);
      const A = pool[ia], Bx = pool[ib];
      if (A.c.dropped || Bx.c.dropped) continue;
      const jac = n / (A.sh.size + Bx.sh.size - n);
      if (jac < 0.5) continue;
      const [keep, lose] = A.c.score >= Bx.c.score ? [A.c, Bx.c] : [Bx.c, A.c];
      if (protectedC(lose)) continue;
      drop(lose, 'duplicate', `same point as [${keep.path}]`);
      lose.dupOf = keep.id;
      (keep.dups ||= []).push(lose.id);
    }
  }

  // 9. Discover in the thread: substantial comments outside your usual topics, preferring first-hand
  //    experience, respected authors and comments HN readers rank high. They are kept and sent.
  if (relModel) {
    const FIRST_HAND = /\b(i (work|worked|used to work)( on| at| for)?|i('ve| have) (built|shipped|run|used|maintained|written)|at my (company|job|work|employer|lab|hospital)|in my experience|we (built|run|shipped|use|used|switched)|i('m| am) (a|an) [a-z]+ (engineer|doctor|researcher|developer|scientist|lawyer|pilot))\b/i;
    const offTopic = (c) => !(c.verdict.reasons || []).some((r) => r.kind === 'tag' || r.kind === 'near' || r.kind === 'context' || r.kind === 'inherit');
    const cands = [];
    for (const c of live) {
      if (c.dropped || c.depth > 2 || c.words < 40 || !offTopic(c)) continue;
      const k = cfg.karma && c.author ? cfg.karma[c.author] : null;
      const karmaNorm = k ? Math.min(1, Math.log10(1 + k) / 5) : 0;
      const replyNorm = Math.min(1, Math.log2(1 + Math.max(0, c.subtree_size - 1)) / 5);
      const firstHand = FIRST_HAND.test(c.text);
      const q = 0.35 * (c.score / 1000) + 0.25 * karmaNorm + 0.15 * replyNorm + 0.1 * (isEvidence(c) ? 1 : 0) + 0.15 * (firstHand ? 1 : 0);
      if (q >= 0.4) cands.push({ c, q, k, firstHand, replies: c.subtree_size - 1 });
    }
    cands.sort((a, b) => b.q - a.q);
    for (const { c, q, k, firstHand, replies } of cands.slice(0, cfg.stretchComments ?? scoring.stretchMax ?? 3)) {
      c.stretch = true;
      const reasons = [
        { kind: 'discover', label: 'Off your usual topics', points: 0 },
        firstHand ? { kind: 'discover', label: 'First-hand experience', points: 0.15 } : null,
        k >= 1000 ? { kind: 'discover', label: `Respected author (karma ${k >= 10000 ? Math.round(k / 1000) + 'k' : k})`, points: Math.round(25 * Math.min(1, Math.log10(1 + k) / 5)) / 100 } : null,
        c.score >= 700 ? { kind: 'discover', label: 'Ranked high by HN readers', points: Math.round(35 * c.score / 1000) / 100 } : null,
        replies >= 3 ? { kind: 'discover', label: `Drew ${replies} replies`, points: 0.05 } : null,
        isEvidence(c) ? { kind: 'discover', label: 'Carries a link, a number or code', points: 0.1 } : null,
      ].filter(Boolean);
      c.verdict = { ...c.verdict, bucket: 'stretch', score: Math.min(1, Math.round(q * 100) / 100), total: Math.round(q * 100) / 100, reasons, discover: true };
    }
    if (cfg.gate !== false) {
      for (const c of live) {
        if (c.dropped || protectedC(c) || c.stretch) continue;
        if (c.verdict.bucket === 'toss') drop(c, 'below_floor', `score ${c.verdict.score}`);
      }
    }
  }

  // 9b. Minimum survivors: a long thread is never cut to almost nothing by the interest floor.
  //     The best-ranked held-back comments come back as maybe, and say why.
  if (relModel && cfg.gate !== false) {
    const alive = live.filter((c) => !c.dropped || c.dropped === 'below_floor');
    const need = Math.min(alive.length, Math.max(cfg.minSurvivors ?? 15, Math.ceil((cfg.minSurvivorShare ?? 0.08) * alive.length)));
    const have = live.filter((c) => !c.dropped).length;
    if (have < need) {
      const back = live.filter((c) => c.dropped === 'below_floor').sort((a, b) => b.verdict.quality - a.verdict.quality).slice(0, need - have);
      for (const c of back) {
        c.dropped = undefined;
        stats.pruned.below_floor--;
        const i = pruned.findIndex((p) => p.id === c.id);
        if (i >= 0) pruned.splice(i, 1);
        c.verdict.bucket = 'maybe';
        c.verdict.reasons.unshift({ kind: 'floor', label: 'Kept so the thread is not empty: ranked high by HN', points: 0 });
      }
    }
  }

  // 10. Token budget: lowest priority first.
  let kept = live.filter((c) => !c.dropped);
  const cost = (c) => estTokens(c.text) + cfg.lineOverheadTokens;
  let total = kept.reduce((s, c) => s + cost(c), 0);
  if (total > cfg.budgetTokens) {
    const priority = (c) => c.score * (1 + cfg.relLambda * c.rel) * (c.op ? cfg.opBoost : 1) * (isEvidence(c) ? cfg.evidenceBoost : 1) * (c.rebuttal ? 1.5 : 1);
    const order = [...kept].sort((a, b) => priority(a) - priority(b) || b.rank - a.rank);
    for (const c of order) {
      if (total <= cfg.budgetTokens) break;
      drop(c, 'budget', `priority ${Math.round(priority(c))}`);
      total -= cost(c);
    }
    kept = live.filter((c) => !c.dropped);
  }

  // Final verdicts. A removed comment keeps its score, so the page can say what it would have been.
  for (const c of all) {
    if (!c.verdict) c.verdict = { score: 0, total: 0, reasons: [], bucket: 'removed', rules: RULES_VERSION };
    // The crust is removed. The interest floor and the budget only keep a comment away from the model.
    if (c.dropped && c.dropped !== 'below_floor' && c.dropped !== 'budget') { c.verdict.bucket = 'removed'; c.verdict.rule = c.dropped; }
    if (c.dropped === 'below_floor' || c.dropped === 'budget') c.verdict.rule = c.dropped;
    if (c.rebuttal) c.verdict.rebuttal = true;
    if (c.answered) c.verdict.answered = true;
    if (c.dupOf) c.verdict.dupOf = c.dupOf;
    if (c.dups) c.verdict.dups = c.dups;
    c.verdict.sent = !c.dropped;
  }

  stats.kept = kept.length;
  stats.est_tokens = total;
  return { kept, pruned, stats, config: cfg };
}
