import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import { parseFront, mergeFront } from "../extension/lib/front.js";
import { scoreStories, squash, bucketFor, SCORING_DEFAULTS } from "../extension/lib/score.js";
import { normaliseBlocklist, compileBlocklist, testBlocklist, patternToRegExp, suggestFromDismissals } from "../extension/lib/blocklist.js";
import { buildProfile, domainOf, bookmarkTreeToItems, parseBookmarksFile } from "../extension/lib/profile.js";
import { clusterStories } from "../extension/lib/cluster.js";
import { TagGraph, buildState } from "../extension/lib/graph.js";
import { mergePages, prepare, verdicts } from "../extension/lib/thread.js";

const doc = (f) => parseHTML(fs.readFileSync(new URL(f, import.meta.url), "utf8")).document;
const bm = JSON.parse(fs.readFileSync(new URL("../fixtures/synthetic/bookmarks.json", import.meta.url), "utf8"));

test("front pages parse into stories and merge without duplicates", () => {
  const p1 = parseFront(doc("../fixtures/front/news-p1.html"));
  const p2 = parseFront(doc("../fixtures/front/news-p2.html"));
  assert.equal(p1.stories.length, 30);
  assert.ok(p1.more);
  const s = p1.stories[0];
  assert.ok(s.id && s.title && s.url && s.points > 0 && s.by && s.comments >= 0);
  const merged = mergeFront([p1, p2, p1]);
  assert.equal(merged.stories.length, new Set([...p1.stories, ...p2.stories].map((x) => x.id)).size);
});

test("the 0 to 1 score is a squashed sum, and buckets follow the thresholds", () => {
  assert.equal(squash(0), 0);
  assert.ok(squash(0.9) > 0.85 && squash(0.9) < 0.87);
  assert.ok(squash(5) <= 1);
  assert.equal(bucketFor(0.6), "keep");
  assert.equal(bucketFor(0.3), "maybe");
  assert.equal(bucketFor(0.1), "toss");
});

test("stories score against tags, carry reasons, and blocked stories go to toss with the rule", () => {
  const graph = new TagGraph(buildState(bm, { params: { minTagCount: 1, minTermDocs: 1 } }));
  const stories = [
    { id: 1, title: "Obsidian vault templates for research notes", domain: "example.org", points: 100, comments: 40 },
    { id: 2, title: "Acme raises $40M series A for scheduling", domain: "techcrunch.com", points: 50, comments: 30 },
    { id: 3, title: "A history of lighthouse lenses", domain: "lighthouses.org", points: 300, comments: 160 },
  ];
  const blocks = compileBlocklist(normaliseBlocklist({ groups: [{ name: "Funding rounds", patterns: ["series a", "raises"], fields: ["title"] }] }));
  const v = scoreStories(stories, { graph, profile: buildProfile({}), blocks });
  assert.ok(v[0].score > 0 && v[0].reasons.some((r) => r.kind === "tag"));
  assert.equal(v[1].bucket, "toss");
  assert.ok(v[1].reasons[0].label.startsWith("Blocked: Funding rounds"));
  assert.equal(v[2].bucket, "stretch");
  assert.ok(v.every((x) => x.rules && x.score >= 0 && x.score <= 1));
});

test("with no interests synced every story is maybe, not toss", () => {
  const v = scoreStories([{ id: 1, title: "Anything", points: 10, comments: 2 }], {});
  assert.equal(v[0].bucket, "maybe");
});

test("blocklist patterns match whole words, regexes work, and bad files are rejected", () => {
  assert.ok(patternToRegExp("series a").test("Acme raises Series A"));
  assert.ok(!patternToRegExp("ai").test("Taiwan chips"));
  assert.ok(patternToRegExp("/\\(YC [SW]\\d{2}\\)/").test("Foo (YC S23) is hiring"));
  assert.throws(() => normaliseBlocklist({ schema: "other/1" }));
  const bl = normaliseBlocklist({ groups: [{ name: "X", patterns: ["foo"] }, { name: "", patterns: ["bar"] }] });
  assert.equal(bl.groups.length, 1);
  const t = testBlocklist(bl, [{ id: 1, title: "foo bar" }, { id: 2, title: "baz" }]);
  assert.equal(t[0].hits.length, 1);
});

test("dismissals suggest a rule only when a pattern repeats", () => {
  const d = Array.from({ length: 4 }, (_, i) => ({ id: i, title: `Startup ${i} funding announced`, domain: `s${i}.com` }));
  const s = suggestFromDismissals(d);
  assert.ok(s.some((x) => x.patterns[0] === "funding"));
  assert.equal(suggestFromDismissals(d.slice(0, 2)).length, 0);
});

test("profile collects domains, and bookmark folders become tags", () => {
  assert.equal(domainOf("https://www.example.com/a"), "example.com");
  assert.equal(domainOf("https://github.com/Foo/bar"), "github.com/foo");
  const items = bookmarkTreeToItems([{ title: "", children: [{ title: "Bookmarks Toolbar", children: [{ title: "Oncology", children: [{ title: "Glioma review", url: "https://nature.com/x" }] }] }] }]);
  assert.deepEqual(items[0].tags, ["oncology"]);
  const p = buildProfile({ items, favourites: [{ title: "A local-first literature search" }] });
  assert.equal(p.domains["nature.com"], 1);
  assert.equal(p.fav.length, 1);
  const f = parseBookmarksFile(parseHTML('<html><body><DL><DT><H3>Geopolitics</H3><DL><DT><A HREF="https://a.org/1" TAGS="india,navy">Indian Ocean</A></DL></DL></body></html>').document);
  assert.deepEqual(f[0].tags.sort(), ["geopolitics", "india", "navy"]);
});

test("clusters join stories that share a tag", () => {
  const stories = [{ id: 1, title: "A" }, { id: 2, title: "B" }, { id: 3, title: "C" }];
  const v = [{ bucket: "keep", score: 0.8, tags: ["rust"] }, { bucket: "maybe", score: 0.3, tags: ["rust"] }, { bucket: "toss", score: 0, tags: [] }];
  const c = clusterStories(stories, v);
  assert.equal(c.length, 2);
  assert.equal(c[0].items.length, 2);
  assert.equal(c[0].label, "rust");
});

test("every comment gets a verdict; rebuttals are protected; removed ones keep their rule", () => {
  const thread = mergePages([fs.readFileSync(new URL("../fixtures/threads/50403507.html", import.meta.url), "utf8")], (h) => parseHTML(h).document);
  const graph = new TagGraph(buildState(bm, { params: { minTagCount: 1, minTermDocs: 1 } }));
  const prep = prepare(thread, graph, { scoring: SCORING_DEFAULTS });
  const v = verdicts(thread);
  const all = Object.values(v);
  assert.equal(all.length, thread.comments.length);
  assert.ok(all.every((x) => ["keep", "maybe", "stretch", "toss", "removed"].includes(x.bucket)));
  assert.ok(all.filter((x) => x.bucket === "removed").every((x) => x.rule));
  assert.ok(all.filter((x) => x.rebuttal).every((x) => x.bucket !== "removed" && x.rule !== "below_floor"));
  const f = prep.funnel;
  assert.ok(f.comments >= f.afterCrust && f.afterCrust >= f.afterTags && f.afterTags >= f.sent);
});

import { normUrl, groupDuplicates } from "../extension/lib/front.js";
import { gravity, scoreComment } from "../extension/lib/score.js";
import { prune } from "../extension/lib/prune.js";

test("duplicate submissions group by normalised link or near-identical title", () => {
  assert.equal(normUrl("https://www.example.com/post/?utm_source=x"), normUrl("http://example.com/post"));
  assert.equal(normUrl("https://arxiv.org/pdf/2401.01234v2"), normUrl("https://arxiv.org/abs/2401.01234"));
  const g = groupDuplicates([
    { id: 1, title: "A", url: "https://example.com/a", external: true, points: 10 },
    { id: 2, title: "B", url: "https://www.example.com/a/", external: true, points: 50 },
    { id: 3, title: "Rust compiler gets faster incremental builds", url: "https://x.org/1", external: true, points: 5 },
    { id: 4, title: "The Rust compiler gets faster incremental builds", url: "https://y.org/2", external: true, points: 9 },
    { id: 5, title: "Unrelated", url: "https://z.org", external: true, points: 1 },
  ]);
  assert.deepEqual(g.map((x) => x.slice().sort()), [[1, 2], [3, 4]]);
  assert.equal(g[0][0], 2); // the best-voted submission leads
});

test("HN gravity decays with age", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  assert.ok(gravity(100, "2026-11-10T11:00:00", now) > gravity(100, "2026-11-09T12:00:00", now));
});

test("comments gain context, inheritance, karma and reply signals", () => {
  const v = scoreComment({ text: "x", tokens: new Set(["glioma"]), evidence: {}, score: 500, author: "a", subtree_size: 9 },
    { hasGraph: true, story: { tags: ["oncology"], score: 0.8, terms: new Set(["glioma"]) }, parentTagPoints: 0.3, karma: { a: 25000 } });
  const kinds = v.reasons.map((r) => r.kind);
  for (const k of ["context", "inherit", "karma", "replies"]) assert.ok(kinds.includes(k), k);
  assert.notEqual(v.bucket, "toss");
  assert.ok(v.quality > 0 && v.quality <= 1);
});

test("near-duplicate comments fold under the better-ranked one, and a thread keeps a minimum of survivors", () => {
  const mk = (id, text, parent = null, author = `u${id}`) => ({ id, path: String(id), parent_path: parent, depth: parent ? 1 : 0, author, downvotes: 0, subtree_size: 1, status: "ok", text, links: [], has_code: false });
  const same = "the scheduler starves long running jobs because the priority queue never ages entries so starvation happens under load";
  const thread = { story: { author: "op", title: "A scheduler story" }, comments: [mk(1, same), mk(2, same + " indeed"), ...Array.from({ length: 30 }, (_, i) => mk(10 + i, Array.from({ length: 22 }, (_, k) => `w${(i * 37 + k * 11) % 997}z`).join(" ")))] };
  const graph = new TagGraph(buildState(bm, { params: { minTagCount: 1, minTermDocs: 1 } }));
  const r = prune(thread, { minSurvivors: 10 }, graph);
  const two = thread.comments.find((c) => c.id === 2);
  assert.equal(two.dropped, "duplicate");
  assert.ok(thread.comments.find((c) => c.id === 1).dups.includes(2));
  assert.ok(r.kept.length >= 10, `kept ${r.kept.length}`);
  assert.ok(thread.comments.some((c) => c.verdict.reasons.some((x) => x.kind === "floor")));
});
