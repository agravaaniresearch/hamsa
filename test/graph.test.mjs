import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { TagGraph, buildState, isStructural, explain } from "../extension/lib/graph.js";

const items = JSON.parse(fs.readFileSync(new URL("../fixtures/synthetic/bookmarks.json", import.meta.url), "utf8"));
const P = { params: { minTagCount: 1, minTermDocs: 1 } };
const mk = () => new TagGraph(buildState(items, P));

const OBS = "I run everything from Obsidian with QuickAdd templates and macros, one vault per project, linking notes together.";
const LOCAL = "Qwen runs locally on two consumer GPUs with llama.cpp at 53 tokens per second, quantised open weight models work fine on a laptop.";
const OFF = "My landlord replaced the boiler last winter and the heating bill went down quite a lot compared with the old one.";

test("structural tags are excluded from the graph", () => {
  assert.ok(isStructural("to-read"));
  assert.ok(isStructural("2026"));
  const g = mk();
  assert.equal(g.state.tags["to-read"], undefined);
  assert.equal(g.state.tags["2026"], undefined);
  assert.ok(g.state.tags["obsidian"]);
});

test("on-profile text outscores off-profile text and names the tags", () => {
  const [a, b, c] = mk().scoreBatch([OBS, LOCAL, OFF]);
  assert.ok(a.score > 0.4, `obsidian ${a.score}`);
  assert.ok(b.score > 0.4, `local ${b.score}`);
  assert.equal(c.score, 0);
  assert.ok(a.terms.matched.includes("obsidian"));
  assert.match(explain(a), /matches your tags: .*obsidian/);
});

test("a single stray word does not activate a tag", () => {
  const [r] = mk().scoreBatch(["I keep notes in a drawer."]);
  assert.equal(r.score, 0);
});

test("activation spreads to a neighbouring tag through co-occurrence", () => {
  const g = mk();
  const [r] = g.scoreBatch(["Federated learning lets hospitals train models without moving patient data between sites."]);
  const names = r.tags.map((t) => t.tag);
  assert.ok(names.includes("sovereign ai") || names.includes("health data"), names.join());
  const reached = r.tags.filter((t) => t.via);
  assert.ok(reached.every((t) => t.a > 0 && t.a < 0.5));
});

test("muting a tag turns its matches negative and boosting raises them", () => {
  const g = mk();
  const base = g.score(OBS).score;
  g.mute("obsidian"); g.mute("pkm");
  assert.ok(g.score(OBS).score < 0, "muted should demote");
  g.reset("obsidian"); g.reset("pkm");
  g.boost("local models");
  g.boost("local models");
  assert.ok(g.score(LOCAL).score >= g.score(OBS).score);
  assert.ok(Math.abs(g.score(OBS).score - base) < 0.2);
});

test("thumbs nudge only the tags that fired and persist through JSON", () => {
  const g = mk();
  const before = g.score(OBS).score;
  g.nudge(["obsidian", "pkm"], -0.6);
  const down = g.score(OBS).score;
  assert.ok(down < before);
  const copy = new TagGraph(JSON.parse(JSON.stringify(g.toJSON())));
  assert.equal(copy.score(OBS).score, down);
  assert.equal(g.adj("local models"), 0);
});

test("saving a new item teaches the graph a new tag", () => {
  const g = mk();
  const text = "Kubernetes operators reconcile desired state with custom controllers and watch loops in the cluster.";
  assert.equal(g.score(text).score, 0);
  g.add({ title: "Writing Kubernetes operators", excerpt: "custom controllers reconcile loops cluster", tags: ["kubernetes"], created: "2026-11-01" });
  assert.ok(g.score(text).score > 0.3);
});
