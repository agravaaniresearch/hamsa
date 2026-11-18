// 0.7: strands on real threads, HN history parsing and re-scoring (saved Algolia answers), health.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import { mergePages, prepare } from "../extension/lib/thread.js";
import { buildStrands, KINDS } from "../extension/lib/strands.js";
import * as hist from "../extension/lib/history.js";
import { emptyHealth, notePage, noteWrite, noteRequest, report, LIMITS } from "../extension/lib/health.js";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const doc = (h) => parseHTML(h).document;

test("strands on the 689-comment thread: few, labelled, with a kind, and sandboxing merges branches", () => {
  const t = mergePages([read("../fixtures/threads/50366117.html")], doc);
  const prep = prepare(t, null, {});
  const g = prep.strands.groups;
  assert.ok(g.length >= 4 && g.length <= 9, `strands ${g.length}`);
  for (const s of g) assert.ok(s.id === "other" || KINDS.includes(s.kind));
  const sandbox = g.find((s) => s.terms.some((w) => /sandbox|docker|nono/.test(w)));
  assert.ok(sandbox, "a sandboxing strand");
  assert.ok(sandbox.branches.length >= 2, "it merges separate top-level branches");
  for (const s of g.filter((x) => x.id !== "other")) assert.equal(s.ids.length, s.count);
});

test("strands are deterministic", () => {
  const a = buildStrands(mergePages([read("../fixtures/threads/50403097.html")], doc).comments);
  const b = buildStrands(mergePages([read("../fixtures/threads/50403097.html")], doc).comments);
  assert.deepEqual(a, b);
});

test("history: query words, and noisy Algolia hits are dropped unless they share words with the thread", () => {
  const q = hist.similarQuery("Ask HN: What's your current AI agentic setup?", [{ id: "s1", terms: ["sandbox"] }]);
  assert.match(q, /agentic/);
  assert.ok(!/\bask\b/.test(q));
  const json = JSON.parse(read("../fixtures/algolia/similar.json"));
  const terms = new Set(["agentic", "setup", "sandbox", "agent", "docker", "claude", "code"]);
  const out = hist.stories(json, { selfId: 50366117, threadTerms: terms, graph: null });
  assert.ok(out.length <= 6);
  for (const x of out) { assert.ok(x.score >= 0.2); assert.ok(x.shared.length >= 1); assert.notEqual(x.id, 50366117); }
  const u = hist.urls({ url: "https://example.org/a", title: "Show HN: Thing" }, []);
  assert.match(u.same, /restrictSearchableAttributes=url/);
  assert.ok(!/credentials|token|key=/i.test(JSON.stringify(u)));
});

test("history: earlier comments are plain text, short ones and this thread's own are left out", () => {
  const json = JSON.parse(read("../fixtures/algolia/strand.json"));
  const out = hist.comments(json, { selfId: 0, threadTerms: new Set(["sandbox", "nono", "docker", "container", "bubblewrap"]), graph: null });
  for (const c of out) { assert.ok(!/<[a-z]/i.test(c.excerpt)); assert.ok(c.excerpt.length >= 80); }
});

test("health: thresholds give healthy, watch and slow, each cause names a fix", () => {
  const now = Date.now();
  const h = emptyHealth(now);
  for (let i = 0; i < 10; i++) notePage(h, { kind: "thread", ms: 120 }, now);
  assert.equal(report(h, {}, now).status, "healthy");
  for (let i = 0; i < 20; i++) notePage(h, { kind: "thread", ms: LIMITS.watch.pageMs + 50 }, now);
  const w = report(h, {}, now);
  assert.equal(w.status, "watch");
  assert.ok(w.causes[0].fix.length > 10);
  for (let i = 0; i < LIMITS.slow.writesPerHour + 1; i++) noteWrite(h, "idb", 100, now);
  assert.equal(report(h, {}, now).status, "slow");
  for (let i = 0; i < 3; i++) noteRequest(h, "hacker-news.firebaseio.com", i !== 1, now);
  assert.deepEqual(report(h, {}, now).net["hacker-news.firebaseio.com"], { n: 3, fail: 1 });
});
