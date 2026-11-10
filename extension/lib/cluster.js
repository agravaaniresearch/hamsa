// Groups stories on the same topic for the daily digest. No model: two stories join when they share
// a tag that fired on both titles, or share at least two title words with an overlap of 0.3 or more.
// A cluster is then one digest entry, ranked by its best story.
import { tokenize, words } from "./tokenize.js";

const ORDER = { keep: 0, stretch: 1, maybe: 2, toss: 3 };

export function clusterStories(stories, verdicts) {
  const n = stories.length;
  const parent = [...Array(n).keys()];
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => { parent[find(a)] = find(b); };
  const terms = stories.map((s) => new Set(tokenize(s.title)));
  const tags = verdicts.map((v) => new Set(v.tags || []));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if ([...tags[i]].some((t) => tags[j].has(t))) { join(i, j); continue; }
      let shared = 0;
      for (const t of terms[i]) if (terms[j].has(t)) shared++;
      if (shared >= 2 && shared / (terms[i].size + terms[j].size - shared) >= 0.3) join(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const out = [];
  for (const idx of groups.values()) {
    idx.sort((a, b) => ORDER[verdicts[a].bucket] - ORDER[verdicts[b].bucket] || verdicts[b].score - verdicts[a].score);
    const top = idx[0];
    const tagCount = new Map();
    for (const i of idx) for (const t of tags[i]) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    const shared = [...tagCount].filter(([, c]) => c >= Math.min(2, idx.length)).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    out.push({
      label: idx.length > 1 ? labelFor(shared, idx.map((i) => stories[i].title)) || stories[top].title : stories[top].title,
      tags: shared.slice(0, 3),
      bucket: verdicts[top].bucket,
      score: verdicts[top].score,
      items: idx.map((i) => ({ story: stories[i], verdict: verdicts[i] })),
    });
  }
  out.sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket] || b.score - a.score);
  return out;
}

// A shared tag names the cluster best; failing that, the words the titles have in common.
function labelFor(sharedTags, titles) {
  if (sharedTags.length) return sharedTags.slice(0, 2).join(", ");
  const count = new Map();
  for (const t of titles) for (const w of new Set(words(t))) count.set(w, (count.get(w) || 0) + 1);
  const common = [...count].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 3);
  return common.length ? common.join(", ") : null;
}
