import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import { scoreStories, SCORING_DEFAULTS } from "../extension/lib/score.js";
import { parsePreview, quickPreview, slimPreview } from "../extension/lib/preview.js";
import { emptyPrefs, setPref, reviewPref, dueLikes, likeScore, INTERVALS, linkId } from "../extension/lib/prefs.js";
import { subDiscussions } from "../extension/lib/subtopics.js";
import { mergePages, prepare, verdicts } from "../extension/lib/thread.js";
import { TagGraph, buildState } from "../extension/lib/graph.js";

const parseDoc = (h) => parseHTML(h).document;
const bm = JSON.parse(fs.readFileSync(new URL("../fixtures/synthetic/bookmarks.json", import.meta.url), "utf8"));
const graph = new TagGraph(buildState(bm, { params: { minTagCount: 1, minTermDocs: 1 } }));
const st = (id, title, points, comments, extra = {}) => ({ id, title, points, comments, domain: "example.com", url: `https://example.com/${id}`, age: 3, by: "x", kind: "story", ...extra });

test("flame wars go to toss, and never to Discover", () => {
  const stories = [st(1, "Why everyone is wrong about tabs versus spaces forever", 30, 240), st(2, "Quiet notes on the history of lighthouse lenses", 300, 80)];
  const v = scoreStories(stories, { graph, scoring: SCORING_DEFAULTS });
  assert.equal(v[0].flame, true);
  assert.equal(v[0].bucket, "toss");
  assert.ok(v[0].reasons.some((r) => r.kind === "threshold" && /flame war/i.test(r.label)));
  assert.notEqual(v[1].bucket, "toss");
});

test("a like keeps a story that looks like a flame war", () => {
  const stories = [st(1, "Why everyone is wrong about tabs versus spaces forever", 30, 240)];
  const prefs = { items: { 1: "like" }, likeTitles: [], dislikeTitles: [], likeDomains: {}, dislikeDomains: {}, likeTags: {} };
  const v = scoreStories(stories, { graph, scoring: SCORING_DEFAULTS, prefs });
  assert.notEqual(v[0].bucket, "toss");
});

test("points and comments thresholds are off by default and toss when set", () => {
  const stories = [st(1, "Small post about lighthouse lenses", 5, 1)];
  assert.ok(!scoreStories(stories, { graph, scoring: SCORING_DEFAULTS })[0].belowThreshold);
  const v = scoreStories(stories, { graph, scoring: { ...SCORING_DEFAULTS, minPoints: 20 } });
  assert.equal(v[0].belowThreshold, true);
  assert.equal(v[0].bucket, "toss");
});

test("topics on the page are new, or returning when seen on an earlier day", () => {
  const stories = [st(1, "Lighthouse lenses restored in Brittany museum", 100, 20), st(2, "Restored lighthouse lenses go on show in Brittany", 90, 15), st(3, "A compiler written in a weekend", 50, 10)];
  const fresh = scoreStories(stories, { graph, scoring: SCORING_DEFAULTS });
  const t = fresh.topics.find((x) => x.size === 2);
  assert.ok(t, "the two lighthouse stories form one topic");
  assert.equal(t.status, "new");
  const again = scoreStories(stories, { graph, scoring: SCORING_DEFAULTS, topics: [{ terms: t.terms, days: 2, first: 1 }] });
  assert.equal(again.topics.find((x) => x.size === 2).status, "returning");
  const sameDay = scoreStories(stories, { graph, scoring: SCORING_DEFAULTS, topics: [{ terms: t.terms, days: 1, first: 1, firstSeenToday: true }] });
  assert.equal(sameDay.topics.find((x) => x.size === 2).status, "new");
});

test("link previews read Open Graph, fall back to plain tags, and skip what needs no fetch", () => {
  const html = `<html><head><title>Plain title</title><meta property="og:title" content="The real title"><meta property="og:description" content="What the page is about."><meta property="og:image" content="/img/card.png"><meta property="og:site_name" content="Example Journal"><meta name="citation_doi" content="10.1/abc"></head><body></body></html>`;
  const p = parsePreview(html, "https://example.org/a/b", parseDoc);
  assert.equal(p.title, "The real title");
  assert.equal(p.description, "What the page is about.");
  assert.equal(p.image, "https://example.org/img/card.png");
  assert.equal(p.site, "Example Journal");
  assert.equal(p.kind, "paper");
  const q = parsePreview(`<title>Only a title</title><p>${"Words ".repeat(30)}</p>`, "https://example.org/", parseDoc);
  assert.equal(q.title, "Only a title");
  assert.ok(q.description.length > 40);
  assert.equal(quickPreview("https://example.org/paper.pdf").kind, "pdf");
  assert.equal(quickPreview("https://news.ycombinator.com/item?id=1").skip, true);
  assert.equal(quickPreview("https://www.youtube.com/watch?v=dQw4w9WgXcQ").kind, "video");
  assert.equal(quickPreview("https://example.org/x"), null);
  assert.deepEqual(Object.keys(slimPreview({ url: "u", title: "t", junk: 1, image: null })), ["url", "title"]);
});

test("likes keep their context and come back on a spaced schedule", () => {
  let p = emptyPrefs();
  p = setPref(p, { id: 9, kind: "comment", title: "t", excerpt: "A long and useful comment", author: "ann", threadId: 1, threadTitle: "Thread", url: "https://news.ycombinator.com/item?id=9", links: ["https://a.org"] }, "like");
  const x = p.items["9"];
  assert.equal(x.author, "ann"); assert.equal(x.threadTitle, "Thread"); assert.deepEqual(x.links, ["https://a.org"]);
  assert.equal(x.review.step, 0);
  const now = Date.now();
  assert.equal(dueLikes(p, now).length, 0, "not due on the day it was liked");
  const later = now + 2 * 864e5;
  assert.equal(dueLikes(p, later).length, 1);
  reviewPref(p, "9", "keep", later);
  assert.equal(p.items["9"].review.step, 1);
  assert.equal(p.items["9"].review.due, later + INTERVALS[1] * 864e5);
  reviewPref(p, "9", "stop", later);
  assert.equal(dueLikes(p, later + 400 * 864e5).length, 0);
  reviewPref(p, "9", "unlike", later);
  assert.equal(p.items["9"], undefined);
  assert.equal(linkId("https://a.org/x/#top"), "link:https://a.org/x");
});

test("today's picks come from likes alone, and say which like", () => {
  let p = emptyPrefs();
  p = setPref(p, { id: 1, kind: "story", title: "Restoring lighthouse lenses by hand", domain: "lights.org" }, "like");
  const picks = likeScore([st(5, "The last lighthouse lenses maker in France", 80, 10, { domain: "lights.org" }), st(6, "A compiler written in a weekend", 50, 10)], p);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].id, 5);
  assert.ok(picks[0].reasons.some((r) => /lighthouse/.test(r.label)));
  assert.equal(picks[0].because.id, "1");
});

test("thread Discover marks substantial off-topic comments, with reasons", () => {
  const html = fs.readFileSync(new URL("../fixtures/threads/50366117.html", import.meta.url), "utf8");
  const thread = mergePages([html], parseDoc);
  const prep = prepare(thread, graph, {});
  const v = Object.values(verdicts(thread)).filter((x) => x.stretch);
  for (const x of v) {
    assert.equal(x.bucket, "stretch");
    assert.ok(x.reasons.some((r) => r.kind === "discover"));
    assert.ok(!x.reasons.some((r) => r.kind === "tag"));
  }
  assert.ok(prep.subtopics && Array.isArray(prep.subtopics.groups));
});

test("sub-discussions group branches that share their words", () => {
  const c = (path, text) => ({ path, status: "ok", text });
  const comments = [
    c("1", "Battery chemistry matters: lithium iron phosphate cells last longer than nickel cells."), c("1.1", "Phosphate cells also handle heat better, lithium iron is safer."),
    c("2", "Lithium iron phosphate battery packs in cars are cheaper too."), c("2.1", "Phosphate battery cells are heavier per kilowatt hour."),
    c("3", "The licence for the firmware is the real problem, nobody can repair it."), c("3.1", "Firmware licence terms block third party repair shops."),
    c("4", "Repair shops cannot get the firmware without the licence."), c("4.1", "Right to repair laws would fix the firmware licence issue."),
    c("5", "Unrelated note about the weather in Lisbon this week."),
  ];
  const out = subDiscussions(comments, { minComments: 3 });
  assert.ok(out.groups.length >= 2, JSON.stringify(out.groups));
  assert.equal(out.byBranch["1"], out.byBranch["2"]);
  assert.equal(out.byBranch["3"], out.byBranch["4"]);
  assert.notEqual(out.byBranch["1"], out.byBranch["3"]);
});
