// HN history through the public Algolia HN Search API (hn.algolia.com/api/v1): no key, read only, no
// cookies. Off until you switch it on in settings (it needs its own permission).
//
//   Same link        stories whose url is this story's url                 1 request, kept 7 days
//   Similar threads  stories matching the title's distinctive words and   1 request, kept 1 day
//                    the strongest strand words, with 50+ comments
//   Earlier on HN    comments matching one strand's words                  1 request, when you ask
//
// Algolia's keyword search is noisy, so every hit is re-scored here: a hit is shown only if it shares
// words with this thread (title and strands) or fires one of your tags. Text from Algolia is used as
// plain text only; links are rebuilt from ids.
import { tokenize } from "./tokenize.js";

export const ALGOLIA = "https://hn.algolia.com/api/v1";
export const HISTORY_TTL = { same: 7 * 864e5, similar: 864e5, strand: 864e5 };
const strip = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&#x2F;/g, "/").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const STOP = new Set(tokenize("ask show tell launch what your how why when does should would could best current today using with from into about"));

// The query words: distinctive title words first, then the top words of the two largest strands.
export function similarQuery(title, strands = []) {
  const t = tokenize(String(title || "").replace(/^(ask|show|tell|launch) hn:\s*/i, "")).filter((w) => w.length > 2 && !STOP.has(w));
  const extra = strands.filter((s) => s.id !== "other").slice(0, 2).flatMap((s) => s.terms.slice(0, 1));
  return [...new Set([...t.slice(0, 4), ...extra])].slice(0, 5).join(" ");
}

export function urls(story, strands) {
  const out = {};
  if (story.url) out.same = `${ALGOLIA}/search?tags=story&restrictSearchableAttributes=url&hitsPerPage=10&query=${encodeURIComponent(story.url.replace(/^https?:\/\//, ""))}`;
  const q = similarQuery(story.title, strands);
  if (q) out.similar = `${ALGOLIA}/search?tags=story&numericFilters=num_comments%3E50&hitsPerPage=20&query=${encodeURIComponent(q)}`;
  return out;
}

export function strandUrl(strand) {
  return `${ALGOLIA}/search?tags=comment&hitsPerPage=20&query=${encodeURIComponent(strand.terms.slice(0, 3).join(" "))}`;
}

// Overlap between a text and this thread's words, plus your tags: the re-score.
function rescore(text, threadTerms, graph) {
  const toks = new Set(tokenize(text).filter((w) => w.length > 2));
  const shared = [...threadTerms].filter((t) => toks.has(t));
  // Shared words count 0.18 each; each of your tags that fires adds its strength (weight x activation).
  const contribs = graph?.size ? graph.scoreTitles([text])[0].contribs.filter((x) => !x.via) : [];
  const tagScore = contribs.reduce((a, x) => a + Math.min(0.4, x.value), 0);
  const score = Math.min(1, shared.length * 0.18 + tagScore);
  return { score: Math.round(score * 100) / 100, shared: shared.slice(0, 4), tags: contribs.slice(0, 3).map((x) => x.tag) };
}

export function stories(json, { selfId, threadTerms, graph, min = 0.2, max = 6 } = {}) {
  const out = [];
  for (const h of json?.hits || []) {
    const id = Number(h.objectID);
    if (!id || id === selfId || !h.title) continue;
    const r = rescore(h.title, threadTerms, graph);
    if (r.score < min) continue;
    out.push({ id, title: strip(h.title), year: new Date((h.created_at_i || 0) * 1000).getUTCFullYear(), at: h.created_at_i, comments: h.num_comments || 0, points: h.points || 0, ...r });
  }
  return out.sort((a, b) => b.score - a.score || b.comments - a.comments).slice(0, max);
}

export function comments(json, { selfId, threadTerms, graph, min = 0.2, max = 4 } = {}) {
  const out = [];
  for (const h of json?.hits || []) {
    if (Number(h.story_id) === selfId) continue;
    const text = strip(h.comment_text);
    if (text.length < 80) continue;
    const r = rescore(text, threadTerms, graph);
    if (r.score < min) continue;
    out.push({ id: Number(h.objectID), storyId: Number(h.story_id), storyTitle: strip(h.story_title || ""), author: h.author, at: h.created_at_i, excerpt: text.length > 280 ? `${text.slice(0, 280)}…` : text, ...r });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}
