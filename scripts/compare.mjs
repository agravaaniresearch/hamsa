// node scripts/compare.mjs <thread.html> <bookmarks.json> [interest.md]
// Offline check of the tag-graph scorer on a saved HN page. Prints the distribution, the top comments,
// and (optionally) how the top 30 overlap with the old interest.md model. Bookmark data stays local.
import fs from "node:fs";
import { parseHTML } from "linkedom";
import { parseThread } from "../extension/lib/parse.js";
import { prune } from "../extension/lib/prune.js";
import { TagGraph, buildState, explain } from "../extension/lib/graph.js";

const [html, bm, interest] = process.argv.slice(2);
const { document } = parseHTML(fs.readFileSync(html, "utf8"));
const thread = parseThread(document);
const items = JSON.parse(fs.readFileSync(bm, "utf8"));
const state = buildState(items);
const countsFile = new URL("../fixtures/private/tagcounts.txt", import.meta.url);
if (fs.existsSync(countsFile)) {
  // The sample is only 600 bookmarks; use the real library counts so weights match the full library.
  const real = Object.fromEntries(fs.readFileSync(countsFile, "utf8").trim().split(",").map((x) => { const i = x.lastIndexOf(" "); return [x.slice(0, i), +x.slice(i + 1)]; }));
  for (const [name, node] of Object.entries(state.tags)) { if (real[name]) node.count = real[name]; else node.count = Math.min(node.count, 3); }
  state.n_items = 6000;
}
const graph = new TagGraph(state);
console.log(`graph: ${items.length} items, ${graph.size} tags`);
console.log("top tags:", graph.topTags(12).map((t) => `${t.tag}(${t.count})`).join(" "));

const res = prune(thread, {}, graph);
const kept = res.kept;
const hi = kept.filter((c) => c.rel >= 0.5).length, mid = kept.filter((c) => c.rel >= 0.2 && c.rel < 0.5).length;
console.log(`kept ${kept.length}/${thread.comments.length}  rel>=0.5: ${hi}  0.2-0.5: ${mid}  <0.2: ${kept.length - hi - mid}  neg: ${kept.filter((c) => c.rel < 0).length}`);
const top = [...kept].sort((a, b) => b.rel - a.rel).slice(0, 12);
for (const c of top) console.log(`[${c.path}] rel ${c.rel.toFixed(2)} | ${explain(c.relevance)} | ${c.text.replace(/\s+/g, " ").slice(0, 110)}`);

if (interest) {
  const { RelevanceModel } = await import("/home/claude/hamsa-cli/src/relevance/model.js");
  const old = new RelevanceModel({}, { profile: fs.readFileSync(interest, "utf8").split("\n").filter((l) => !l.startsWith("#")).join("\n") });
  const all = thread.comments.filter((c) => c.status === "ok");
  const a = graph.scoreBatch(all.map((c) => c.text)).map((r, i) => [all[i].path, r.score]).sort((x, y) => y[1] - x[1]).slice(0, 30).map((x) => x[0]);
  const b = old.scoreBatch(all.map((c) => c.text)).map((r, i) => [all[i].path, r.score]).sort((x, y) => y[1] - x[1]).slice(0, 30).map((x) => x[0]);
  console.log(`top-30 overlap with interest.md model: ${a.filter((p) => b.includes(p)).length}/30`);
}
