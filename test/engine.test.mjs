// Relevance engine, rules 0.6: the inverted index gives the same numbers as the v0.5 full scan
// (test/reference/graph-v05.js, frozen), and the 0.6 changes behave as SCHEMA.md says.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import { TagGraph, buildState, recency } from "../extension/lib/graph.js";
import * as OLD from "./reference/graph-v05.js";
import { mergePages } from "../extension/lib/thread.js";
import { scoreStories } from "../extension/lib/score.js";
import { shortWords } from "../extension/lib/tokenize.js";

const parseDoc = (h) => parseHTML(h).document;
const bm = JSON.parse(fs.readFileSync(new URL("../fixtures/synthetic/bookmarks.json", import.meta.url), "utf8"));
const threadDir = new URL("../fixtures/threads/", import.meta.url);
const comments = fs.readdirSync(threadDir).flatMap((f) => mergePages([fs.readFileSync(new URL(f, threadDir), "utf8")], parseDoc).comments.map((c) => c.text));
const frontDir = new URL("../fixtures/front/", import.meta.url);
const titles = fs.readdirSync(frontDir).flatMap((f) => [...parseDoc(fs.readFileSync(new URL(f, frontDir), "utf8")).querySelectorAll(".titleline > a")].map((a) => a.textContent));
const OFF = { halfLifeDays: 0 }; // recency off: the v0.5 weights
const noShort = (items) => items.map((it) => ({ ...it, tags: it.tags.filter((t) => !shortWords(t).length) }));

// A synthetic library with thousands of tags whose terms are real words from the fixture threads, so the
// fixture comments hit many tags (the hard case for an index).
function bigLibrary() {
  let s = 11; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const words = [...new Set(comments.join(" ").toLowerCase().match(/[a-z]{4,}/g))];
  const pick = () => words[Math.floor(Math.pow(rnd(), 1.6) * words.length)];
  const tagNames = Array.from({ length: 3400 }, () => (rnd() < 0.5 ? pick() : `${pick()} ${pick()}`));
  const vocab = tagNames.map(() => Array.from({ length: 25 }, pick));
  return Array.from({ length: 4400 }, () => {
    const tags = Array.from({ length: 3 + Math.floor(rnd() * 4) }, () => Math.floor(Math.pow(rnd(), 1.15) * 3400));
    const w = tags.flatMap((t) => Array.from({ length: 4 }, () => vocab[t][Math.floor(rnd() * 25)]));
    return { title: w.join(" "), excerpt: w.slice().reverse().join(" "), tags: tags.map((t) => tagNames[t]), created: "2024-01-01" };
  });
}

function same(items, params, texts, heads, adj = {}) {
  const st = buildState(items, { params: { ...params, ...OFF } });
  st.adj = adj;
  const a = new TagGraph(structuredClone(st)), b = new OLD.TagGraph(structuredClone(st));
  assert.deepEqual(a.scoreBatch(texts), b.scoreBatch(texts));
  assert.deepEqual(a.scoreTitles(heads), b.scoreTitles(heads));
  return a;
}

test("the index gives the v0.5 numbers exactly on the fixtures", () => {
  assert.ok(comments.length > 300 && titles.length >= 30);
  same(noShort(bm), { minTagCount: 1, minTermDocs: 1 }, comments, [...titles, ...comments.slice(0, 50)]);
});

test("the index gives the v0.5 numbers exactly on a library of thousands of tags, with taught adjustments", () => {
  const items = bigLibrary();
  const g = same(items, {}, comments.slice(0, 400), [...titles, ...comments.slice(0, 120).map((c) => c.split(/\s+/).slice(0, 10).join(" "))],
    { [items[0].tags[0]]: 1.3, [items[1].tags[0]]: -0.9 });
  assert.ok(g.size > 2000, `compiled ${g.size}`);
});

test("size counts tags that can score; a library of one-off tags is not ready", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ title: `rust borrow checker ${i}`, tags: [`tag${i}`] }));
  const g = new TagGraph(buildState(items));
  assert.equal(g.stored, 10);
  assert.equal(g.size, 0);
  const [v] = scoreStories([{ id: 1, title: "Rust borrow checker explained", points: 50, comments: 10 }], { graph: g });
  assert.equal(v.bucket, "maybe");
  assert.ok(v.reasons.some((r) => /No interests synced/.test(r.label)));
});

test("a short word in a tag's name must be in the title too", () => {
  const items = [];
  for (let i = 0; i < 6; i++) items.push({ title: `AI safety alignment research ${i}`, excerpt: "alignment evaluation frontier models", tags: ["ai safety"] });
  for (let i = 0; i < 6; i++) items.push({ title: `ML ops pipelines ${i}`, excerpt: "pipelines deployment monitoring", tags: ["ml"] });
  const g = new TagGraph(buildState(items));
  const fired = (t) => g.scoreTitles([t])[0].contribs.map((c) => c.tag);
  assert.deepEqual(fired("Warehouse safety rules tightened"), []);
  assert.deepEqual(fired("A new AI safety benchmark"), ["ai safety"]);
  assert.deepEqual(fired("An ML library for pipelines"), ["ml"]);
  assert.deepEqual(shortWords("Of AI and ML in the UK"), ["ai", "ml", "uk"]);
});

test("recency fades a tag you stopped using, down to the floor, and leaves undated or fresh tags alone", () => {
  const mk = (tag, dates) => dates.map((d, i) => ({ title: `${tag} item ${i} kernel scheduler`, excerpt: "kernel scheduler latency", tags: [tag], created: d }));
  const items = [...mk("fresh", ["2026-10-01", "2026-10-05", "2026-11-01", "2026-11-10"]),
    ...mk("old", ["2019-01-01", "2019-02-01", "2019-03-01", "2019-04-01"]),
    ...mk("undated", ["", "", "", ""]), ...mk("mixed", ["2019-01-01", "2019-06-01", "2020-01-01", "2026-11-01"])];
  const g = new TagGraph(buildState(items));
  const rec = (t) => g.c.tags.get(t).recency;
  assert.equal(rec("fresh"), 1);
  assert.equal(rec("undated"), 1);
  assert.ok(Math.abs(rec("old") - 0.5) < 0.01, `old ${rec("old")}`);
  assert.ok(rec("mixed") > 0.6 && rec("mixed") < 0.75, `mixed ${rec("mixed")}`); // one recent bookmark of 3 needed
  const off = new TagGraph(buildState(items, { params: { halfLifeDays: 0 } }));
  assert.equal(off.c.tags.get("old").recency, 1);
  // a graph stored by 0.5 has no rc and is not faded until the next sync rebuilds it
  assert.equal(recency({ last: Date.parse("2019-01-01"), count: 9 }, Date.parse("2026-11-01")), 1);
  // adding one bookmark keeps rc consistent with a fresh build
  const inc = new TagGraph(buildState(items.slice(0, -1)));
  inc.add(items[items.length - 1]);
  assert.ok(Math.abs(inc.c.tags.get("mixed").recency - rec("mixed")) < 0.01);
});

test("an unreadable stored adjustment counts as none, and a numeric one loads as before", () => {
  const g = new TagGraph({ ...buildState(bm, { params: { minTagCount: 1, minTermDocs: 1 } }), adj: { obsidian: "x", pkm: null, rust: 1 } });
  assert.equal(g.adj("obsidian"), 0);
  assert.equal(g.adj("pkm"), 0);
  assert.equal(g.adj("rust"), 1);
  const r = g.score("I run everything from Obsidian with QuickAdd templates, one vault per project.");
  assert.ok(Number.isFinite(r.score) && r.score > 0);
  g.nudge(["obsidian"], NaN);
  assert.equal(g.state.adj.obsidian, "x");
});
