// A worked example on synthetic data: what Hamsa's cheap layer does, step by step, with no browser,
// no network and no model. Run: node scripts/example.mjs
//
// The bookmarks are synthetic (fixtures/synthetic/bookmarks.json) and the HN pages are saved copies
// (fixtures/). Code and runs are synthetic and for illustrative purposes only.
import fs from "node:fs";
import { parseHTML } from "linkedom";
import { TagGraph, buildState } from "../extension/lib/graph.js";
import { parseFront, mergeFront } from "../extension/lib/front.js";
import { scoreStories } from "../extension/lib/score.js";
import { mergePages, prepare } from "../extension/lib/thread.js";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const doc = (html) => parseHTML(html).document;

// 1. Interests: the tag graph is built from bookmarks that carry tags. A tiny library needs low
//    thresholds; a real one uses the defaults (a tag counts from its fourth use).
const bookmarks = JSON.parse(read("fixtures/synthetic/bookmarks.json"));
const graph = new TagGraph(buildState(bookmarks, { params: { minTagCount: 1, minTermDocs: 1 } }));
console.log(`1. Interests: ${bookmarks.length} synthetic bookmarks -> ${graph.size} tags that can score`);
console.log(`   strongest: ${graph.topTags(6).map((t) => `${t.tag} (${t.weight})`).join(", ")}\n`);

// 2. Front page: two saved HN pages merged and scored on titles, sites and your signals.
const front = mergeFront([read("fixtures/front/news-p1.html"), read("fixtures/front/news-p2.html")].map((h) => parseFront(doc(h))));
const verdicts = scoreStories(front.stories, { graph });
const count = (b) => verdicts.filter((v) => v.bucket === b).length;
console.log(`2. Front page: ${front.stories.length} stories -> discover ${count("stretch")}, keep ${count("keep")}, maybe ${count("maybe")}, toss ${count("toss")}`);
const best = verdicts.map((v, i) => ({ v, s: front.stories[i] })).filter((x) => x.v.bucket !== "toss").sort((a, b) => b.v.score - a.v.score).slice(0, 4);
for (const { v, s } of best) {
  console.log(`   ${v.score.toFixed(2)}  ${v.bucket === "stretch" ? "discover" : v.bucket}  ${s.title}`);
  for (const r of v.reasons.slice(0, 2)) console.log(`         ${r.points > 0 ? "+" : ""}${r.points.toFixed(2)}  ${r.label}`);
}

// 3. Thread: crust removed by rule, comments scored, only the on-topic survivors would reach a model.
const thread = mergePages([read("fixtures/threads/50366117.html")], doc);
const prep = prepare(thread, graph, { budgetTokens: 30000 });
const f = prep.funnel;
console.log(`\n3. Thread "${thread.story.title}"`);
console.log(`   ${f.comments} comments -> ${f.afterCrust} after crust removal -> ${f.afterTags} on your topics -> ${f.sent} would be sent (${prep.tokens.toLocaleString()} tokens)`);
const removed = Object.entries(prep.result.stats.pruned).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ");
console.log(`   removed by rule: ${removed}`);
console.log("\n4. No model was called. A summary runs only when you press Summarise, on what survived.");
console.log("\nCode and runs are synthetic and for illustrative purposes only.");
