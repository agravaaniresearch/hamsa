// The blocklist: a plain, shareable JSON file of topic groups. Nothing in it deletes anything:
// a match moves a story to the toss bucket with the rule written next to it, and a strong
// match on your own tags overrides the block.
//
// {
//   "schema": "hamsa.blocklist/1",
//   "groups": [
//     { "id": "saas", "name": "SaaS companies", "enabled": true, "fields": ["title", "domain"],
//       "patterns": ["saas", "/\\bB2B\\b/"], "note": "", "source": "manual" }
//   ]
// }
//
// A plain pattern matches as whole words, case-insensitively. A pattern written /like this/ is a
// regular expression. Drafted and suggested groups arrive switched off until you approve them.
import { tokenize, words } from "./tokenize.js";

export const BLOCK_SCHEMA = "hamsa.blocklist/1";
const SOURCES = new Set(["manual", "drafted", "suggested", "imported"]);

export function emptyBlocklist() {
  return { schema: BLOCK_SCHEMA, groups: [] };
}

const slug = (s) => String(s || "group").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "group";
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function patternToRegExp(p) {
  const s = String(p || "").trim();
  if (!s) return null;
  const m = /^\/(.+)\/([a-z]*)$/.exec(s);
  try {
    if (m) return new RegExp(m[1], m[2].includes("i") ? m[2] : m[2] + "i");
    const words = s.split(/\s+/).map(escapeRe).join("\\s+");
    return new RegExp(`(^|[^a-z0-9])${words}($|[^a-z0-9])`, "i");
  } catch {
    return null;
  }
}

// Validates and cleans a blocklist from storage, a file or a model. Throws with a readable message.
export function normaliseBlocklist(obj, { source } = {}) {
  if (!obj || typeof obj !== "object") throw new Error("That is not a blocklist file.");
  if (obj.schema && obj.schema !== BLOCK_SCHEMA) throw new Error(`Unknown blocklist format: ${obj.schema}.`);
  const groups = Array.isArray(obj.groups) ? obj.groups : [];
  const ids = new Set();
  const out = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const name = String(g.name || "").trim().slice(0, 60);
    const patterns = (Array.isArray(g.patterns) ? g.patterns : []).map((p) => String(p).trim()).filter((p) => p && patternToRegExp(p)).slice(0, 40);
    if (!name || !patterns.length) continue;
    let id = slug(g.id || name);
    while (ids.has(id)) id += "-2";
    ids.add(id);
    const fields = (Array.isArray(g.fields) ? g.fields : ["title", "domain"]).filter((f) => f === "title" || f === "domain");
    out.push({
      id, name, patterns,
      fields: fields.length ? fields : ["title", "domain"],
      enabled: g.enabled !== false,
      note: String(g.note || "").slice(0, 200),
      source: SOURCES.has(source || g.source) ? source || g.source : "manual",
    });
  }
  return { schema: BLOCK_SCHEMA, groups: out };
}

export function compileBlocklist(bl) {
  return (bl?.groups || []).filter((g) => g.enabled).map((g) => ({
    name: g.name, fields: g.fields,
    rules: g.patterns.map((p) => ({ pattern: p, re: patternToRegExp(p) })).filter((r) => r.re),
  }));
}

// Which stories each group would have blocked. Used by the "test on today's front page" button.
export function testBlocklist(bl, stories) {
  const out = [];
  for (const g of bl.groups) {
    const res = g.patterns.map(patternToRegExp).filter(Boolean);
    const hits = stories.filter((s) => res.some((re) => (g.fields.includes("title") && re.test(s.title || "")) || (g.fields.includes("domain") && re.test(s.domain || ""))));
    out.push({ id: g.id, name: g.name, enabled: g.enabled, hits: hits.map((s) => ({ id: s.id, title: s.title, domain: s.domain })) });
  }
  return out;
}

// ---- drafting rules from plain words (one model call, your key) ----
export const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          fields: { type: "array", items: { type: "string", enum: ["title", "domain"] } },
          patterns: { type: "array", items: { type: "string" } },
          note: { type: "string" },
        },
        required: ["name", "fields", "patterns", "note"],
      },
    },
  },
  required: ["groups"],
};

export const DRAFT_PROMPT = `You turn a reader's plain description of Hacker News stories they do not want to see into blocklist rules.
Rules:
- Return JSON matching the schema and nothing else.
- One group per topic the reader names, at most 6 groups. Name each group in a few plain words.
- patterns are words or short phrases matched as whole words in the story title (and the domain if "domain" is listed). Prefer distinctive phrases that appear in such titles, such as "raises", "series a", "seed round" for funding news. At most 12 patterns per group.
- Use a regular expression, written between slashes, only when a plain phrase cannot express it.
- Avoid patterns so broad they would block unrelated stories. Do not add topics the reader did not ask for.
- note says in one short line what the group catches.`;

// ---- suggestions from what you dismissed ----
export function suggestFromDismissals(dismissals = [], bl = emptyBlocklist(), { ownTags = [], minDomain = 3, minTerm = 4 } = {}) {
  const covered = compileBlocklist({ groups: bl.groups.map((g) => ({ ...g, enabled: true })) });
  const isCovered = (d) => covered.some((g) => g.rules.some(({ re }) => re.test(d.title || "") || re.test(d.domain || "")));
  const open = dismissals.filter((d) => !isCovered(d));
  const own = new Set(ownTags.flatMap((t) => tokenize(t)));
  const out = [];
  const byDomain = new Map();
  for (const d of open) if (d.domain) byDomain.set(d.domain, [...(byDomain.get(d.domain) || []), d]);
  for (const [dom, list] of byDomain) if (list.length >= minDomain) out.push({ name: `Stories from ${dom}`, fields: ["domain"], patterns: [dom], count: list.length, sample: list.slice(0, 3).map((x) => x.title) });
  const byTerm = new Map();
  // Plain words, not stems, so the suggested pattern matches the titles it came from.
  for (const d of open) for (const t of new Set(words(d.title || ""))) if (!own.has(tokenize(t)[0]) && t.length > 3) byTerm.set(t, [...(byTerm.get(t) || []), d]);
  for (const [t, list] of [...byTerm].sort((a, b) => b[1].length - a[1].length)) {
    if (list.length < minTerm) break;
    out.push({ name: `Stories about ${t}`, fields: ["title"], patterns: [t], count: list.length, sample: list.slice(0, 3).map((x) => x.title) });
    if (out.length >= 3) break;
  }
  return out;
}
