// Prompt, output schema and checks for the one summary call. Provider-neutral: providers.js
// converts the JSON Schema to each provider's structured-output format.

export const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    gist: { type: "string" },
    relevance_note: { type: "string" },
    points: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          why_relevant: { type: "string" },
          basis: { type: "string", enum: ["first_hand", "data", "primary_source", "reasoning", "opinion"] },
          refs: { type: "array", items: { type: "string" } },
        },
        required: ["claim", "why_relevant", "basis", "refs"],
      },
    },
    disagreements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          sides: {
            type: "array",
            items: {
              type: "object",
              properties: { position: { type: "string" }, best_case: { type: "string" }, refs: { type: "array", items: { type: "string" } } },
              required: ["position", "best_case", "refs"],
            },
          },
        },
        required: ["question", "sides"],
      },
    },
    corrections: {
      type: "array",
      items: {
        type: "object",
        properties: { claim: { type: "string" }, correction: { type: "string" }, refs: { type: "array", items: { type: "string" } } },
        required: ["claim", "correction", "refs"],
      },
    },
    links: {
      type: "array",
      items: {
        type: "object",
        properties: { url: { type: "string" }, why: { type: "string" }, ref: { type: "string" } },
        required: ["url", "why", "ref"],
      },
    },
  },
  required: ["gist", "relevance_note", "points", "disagreements", "corrections", "links"],
};

export const LIMITS = { points: 5, disagreements: 3, corrections: 3, links: 4, gistWords: 40, pointWords: 40, whyWords: 20, totalWords: 250 };

export const SYSTEM_PROMPT = `You summarise Hacker News threads for one reader who wants signal only.
The thread was already cleaned: flame wars, one-line replies and downvoted comments were removed.
Comment lines look like: [path] @author (s640 r+0.4) re @parent [path]: "snippet", followed by the comment text. The number after s is HN's own ranking score (1000 is best). r is a keyword hint of relevance to the reader. Paths show reply nesting, so [1.2.1] replies to [1.2].

Rules:
- Return JSON matching the schema and nothing else.
- Hard length limits: gist at most 40 words; at most 5 points of at most 40 words each, each with a why_relevant of at most 20 words; at most 3 disagreements; at most 3 corrections; at most 4 links. The whole answer should stay near 250 words. Fewer items is better than padding.
- why_relevant must say why THIS point matters to THIS reader, tied to their stated interests. If the link is weak, say so plainly. The r hint is a keyword signal and not a verdict; do not repeat it.
- Rank points by value to the reader, not by popularity. Prefer first-hand experience, data, primary sources and corrections over opinion. Mark opinion as opinion.
- A disagreement needs substance on both sides. Skip tone fights and personal attacks entirely.
- Every point, disagreement side and correction must cite 1 to 3 comment paths that exist in the thread. Never invent a path.
- List a link only when a comment uses it as evidence.
- Do not editorialise and do not restate what the article itself says.
- relevance_note is one line on how relevant the thread is to the reader's interests, or why it is not.`;

// The reader's interests, stated from the tag graph: strongest tags first, with the extra instructions.
export function interestsText(graph, extra = "", n = 40) {
  const tags = graph ? graph.topTags(n).map((t) => t.tag) : [];
  const parts = [];
  if (tags.length) parts.push(`Topics the reader saves and tags, strongest first: ${tags.join(", ")}.`);
  const muted = graph?.state?.muted || [];
  if (muted.length) parts.push(`The reader has muted these topics: ${muted.join(", ")}.`);
  if (extra.trim()) parts.push(extra.trim());
  return parts.join("\n") || "No stated interests; judge relevance as general technical value.";
}

export function buildUserMessage(threadText, interests) {
  return `READER INTERESTS (use only to judge relevance; do not repeat them back):\n${interests.trim()}\n\nTHREAD:\n${threadText}`;
}

// Model output -> object. Tolerates code fences and leading prose.
export function parseModelJson(text) {
  const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a !== -1 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("The model did not return JSON.");
  }
}

const words = (s) => (String(s || "").match(/\S+/g) || []).length;
const cut = (s, n) => {
  const w = String(s || "").split(/\s+/);
  return w.length > n ? w.slice(0, n).join(" ").replace(/[,;:]$/, "") + "…" : String(s || "");
};

// Drops invented comment paths, trims over-long fields, and reports what it changed.
export function normalise(summary, comments) {
  const known = new Map(comments.map((c) => [c.path, c.id]));
  const notes = { bad_refs: [], trimmed: 0 };
  const clean = (refs = []) => (Array.isArray(refs) ? refs : []).filter((r) => (known.has(r) ? true : (notes.bad_refs.push(r), false)));
  const s = {
    gist: cut(summary.gist, LIMITS.gistWords),
    relevance_note: cut(summary.relevance_note, 30),
    points: (summary.points || []).slice(0, LIMITS.points).map((p) => ({
      claim: cut(p.claim, LIMITS.pointWords), why_relevant: cut(p.why_relevant, LIMITS.whyWords),
      basis: p.basis || "opinion", refs: clean(p.refs),
    })),
    disagreements: (summary.disagreements || []).slice(0, LIMITS.disagreements).map((d) => ({
      question: d.question, sides: (d.sides || []).slice(0, 3).map((x) => ({ position: cut(x.position, 12), best_case: cut(x.best_case, 30), refs: clean(x.refs) })),
    })),
    corrections: (summary.corrections || []).slice(0, LIMITS.corrections).map((c) => ({ claim: cut(c.claim, 25), correction: cut(c.correction, 30), refs: clean(c.refs) })),
    links: (summary.links || []).slice(0, LIMITS.links).filter((l) => (known.has(l.ref) ? true : (notes.bad_refs.push(l.ref), false))),
  };
  s.points = s.points.filter((p) => p.refs.length);
  const total = words([s.gist, s.relevance_note, ...s.points.flatMap((p) => [p.claim, p.why_relevant]), ...s.disagreements.flatMap((d) => [d.question, ...d.sides.flatMap((x) => [x.position, x.best_case])]), ...s.corrections.flatMap((c) => [c.claim, c.correction]), ...s.links.map((l) => l.why)].join(" "));
  return { summary: s, known, words: total, ...notes };
}
