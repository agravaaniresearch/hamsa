import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import { mergePages, prepare, itemIdFrom, fetchPages } from "../extension/lib/thread.js";
import { normalise, parseModelJson, interestsText } from "../extension/lib/summarise.js";
import { TagGraph, buildState } from "../extension/lib/graph.js";
import { estimateCost, fmtInr } from "../extension/lib/pricing.js";
import { fetchAllItems } from "../extension/lib/raindrop.js";

const parseDoc = (h) => parseHTML(h).document;
const html = fs.readFileSync(new URL("../fixtures/threads/50403507.html", import.meta.url), "utf8");
const bm = JSON.parse(fs.readFileSync(new URL("../fixtures/synthetic/bookmarks.json", import.meta.url), "utf8"));

test("item ids come from ids and urls", () => {
  assert.equal(itemIdFrom("https://news.ycombinator.com/item?id=50366117"), 50366117);
  assert.equal(itemIdFrom("50366117"), 50366117);
  assert.equal(itemIdFrom("hello"), null);
});

test("a saved thread is cleaned within budget and keeps stable paths", () => {
  const thread = mergePages([html], parseDoc);
  assert.ok(thread.comments.length > 50);
  const { result, threadText, tokens } = prepare(thread, null, { budgetTokens: 8000 });
  assert.ok(result.kept.length < thread.comments.length);
  assert.ok(tokens <= 8000 * 1.05, `tokens ${tokens}`);
  assert.match(threadText, /^THREAD: /);
  assert.ok(result.kept.every((c) => thread.comments.find((x) => x.path === c.path)));
});

test("with a tag graph, relevance scores are attached and the thread gets an absolute score", () => {
  const thread = mergePages([html], parseDoc);
  const graph = new TagGraph(buildState(bm, { params: { minTagCount: 1, minTermDocs: 1 } }));
  const { result, threadRelevance } = prepare(thread, graph, {});
  assert.ok(result.kept.every((c) => typeof c.rel === "number"));
  assert.ok(threadRelevance >= 0 && threadRelevance <= 1);
});

test("pages are fetched until there is no More link", async () => {
  const urls = [];
  const pages = { "https://news.ycombinator.com/item?id=1111": '<a class="morelink" href="item?id=1111&p=2">More</a>', "https://news.ycombinator.com/item?id=1111&p=2": "<p>end</p>" };
  const fetchImpl = async (u) => { urls.push(u); return { ok: true, status: 200, text: async () => pages[u] }; };
  const out = await fetchPages(1111, { fetchImpl, parseDoc });
  assert.equal(out.length, 2);
  assert.deepEqual(urls, Object.keys(pages));
});

test("normalise drops invented paths, caps lengths and counts words", () => {
  const comments = [{ path: "1", id: 11 }, { path: "1.1", id: 12 }];
  const long = Array.from({ length: 80 }, (_, i) => `w${i}`).join(" ");
  const raw = {
    gist: long, relevance_note: "ok",
    points: [{ claim: long, why_relevant: long, basis: "data", refs: ["1", "9.9"] }, { claim: "x", why_relevant: "y", basis: "opinion", refs: ["7"] }],
    disagreements: [], corrections: [], links: [{ url: "u", why: "w", ref: "5" }],
  };
  const { summary, bad_refs, words } = normalise(raw, comments);
  assert.equal(summary.points.length, 1);
  assert.deepEqual(summary.points[0].refs, ["1"]);
  assert.deepEqual(bad_refs.sort(), ["5", "7", "9.9"]);
  assert.ok(summary.gist.split(/\s+/).length <= 41);
  assert.ok(words < 150);
  assert.equal(summary.links.length, 0);
});

test("parseModelJson accepts fenced output and leading prose", () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('Here you go: {"a":2} thanks'), { a: 2 });
  assert.throws(() => parseModelJson("no json"));
});

test("interests text comes from the strongest tags and lists muted ones", () => {
  const g = new TagGraph(buildState(bm, { params: { minTagCount: 1, minTermDocs: 1 } }));
  g.mute("energy");
  const t = interestsText(g, "Prefer clinical angles.");
  assert.match(t, /Topics the reader saves/);
  assert.match(t, /muted these topics: energy/);
  assert.match(t, /Prefer clinical angles/);
});

test("cost estimates use the price table, local is free, unknown is flagged", () => {
  const c = estimateCost("claude-sonnet-5-5", 30000, 1500);
  assert.ok(Math.abs(c.usd - (30000 * 2 + 1500 * 10) / 1e6) < 1e-9);
  assert.equal(fmtInr(estimateCost("anything", 1000, 100, { baseUrl: "http://localhost:11434/v1" })), "free (local)");
  assert.equal(fmtInr(estimateCost("mystery-model", 1000, 100)), "price unknown");
  assert.equal(estimateCost("claude-haiku-5-5", 1e6, 0).usd, 0.1);
});

test("Raindrop items are read page by page until a short page", async () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ _id: i, title: "t", tags: ["a"], highlights: [{ text: "h" }] }));
  const sizes = [50, 50, 7];
  let call = 0;
  const fetchImpl = async (url) => { assert.match(url, /raindrops\/0\?perpage=50&page=/); return { ok: true, status: 200, json: async () => ({ items: mk(sizes[call++]) }) }; };
  const items = await fetchAllItems("tok", { fetchImpl });
  assert.equal(items.length, 107);
  assert.equal(items[0].highlights[0].text, "h");
});
