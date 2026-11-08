// Turns the pruned thread into model input (thread.txt) and a human changelog.
import { DEFAULTS, estTokens } from './config.js';

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

export function renderThreadText(thread, kept, stats, userCfg = {}) {
  const cfg = { ...DEFAULTS, ...userCfg };
  const { story } = thread;
  const byPath = new Map(thread.comments.map((c) => [c.path, c]));
  const out = [];
  out.push(`THREAD: ${story.title}`);
  if (story.link_url) out.push(`LINK: ${story.link_domain || ''} ${story.link_url}`.replace('  ', ' '));
  out.push(`HN: ${story.points} points, ${stats.rows_seen} comments seen, ${kept.length} kept after cleaning`);
  if (story.text) out.push(`POST TEXT: ${oneLine(story.text)}`);
  out.push('LEGEND: [path] @author (s=HN rank score, 1000 best; r=keyword-based hint of relevance to the reader, -1 to +1, shown only when notable, a hint and not a verdict). OP is the submitter. "re @x [path]" quotes the parent when it is not the line above.');
  out.push('---');

  let prev = null;
  for (const c of kept) {
    let re = '';
    if (c.parent_path && (!prev || prev.path !== c.parent_path)) {
      const p = byPath.get(c.parent_path);
      re = p && p.text
        ? ` re @${p.author} [${p.path}]: "${oneLine(p.text).slice(0, cfg.snippetChars)}${oneLine(p.text).length > cfg.snippetChars ? '…' : ''}"`
        : ' re [parent removed]';
    }
    const r = Math.abs(c.rel || 0) >= 0.2 ? ` r${c.rel > 0 ? '+' : ''}${c.rel.toFixed(1)}` : '';
    out.push(`[${c.path}] @${c.author}${c.op ? ' (OP)' : ''} (s${c.score}${r})${re}`);
    out.push(c.text.replace(/\n{2,}/g, ' ¶ ').replace(/\n/g, ' '));
    prev = c;
  }
  return out.join('\n') + '\n';
}

export function renderChangelog(thread, result, threadText) {
  const { stats, pruned } = result;
  const lines = [];
  lines.push(`# Hamsa changelog: ${thread.story.title}`, '');
  lines.push(`Rows seen: ${stats.rows_seen}. Kept: ${stats.kept}. Estimated input tokens: ${estTokens(threadText)}.`, '');
  lines.push('| Reason | Count |', '|---|---|');
  lines.push(`| unavailable (dead, flagged, collapsed, deleted) | ${stats.unavailable} |`);
  for (const [k, v] of Object.entries(stats.pruned)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  for (const reason of ['downvoted', 'flame_chain', 'short', 'budget']) {
    const items = pruned.filter((p) => p.reason === reason);
    if (!items.length) continue;
    lines.push(`## ${reason} (${items.length})`, '');
    for (const p of items.slice(0, 40)) {
      const c = thread.comments.find((x) => x.id === p.id);
      lines.push(`- [${p.path}] @${p.author}, ${p.detail}: ${oneLine(c?.text || '').slice(0, 110)}`);
    }
    if (items.length > 40) lines.push(`- ...and ${items.length - 40} more (see thread.json)`);
    lines.push('');
  }
  return lines.join('\n');
}
