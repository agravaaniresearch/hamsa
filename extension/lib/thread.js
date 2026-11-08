// Fetch, merge, clean and render one HN thread. Environment-neutral: the caller supplies fetch and
// an HTML parser (DOMParser in the extension, linkedom in tests).
import { parseThread, nextPageHref } from "./parse.js";
import { prune } from "./prune.js";
import { renderThreadText } from "./render.js";
import { estTokens } from "./config.js";

export function itemIdFrom(input) {
  const m = String(input).match(/(?:item\?id=)?(\d{4,})/);
  return m ? Number(m[1]) : null;
}

export async function fetchPages(id, { fetchImpl = fetch, parseDoc, maxPages = 10 } = {}) {
  const pages = [];
  let url = `https://news.ycombinator.com/item?id=${id}`;
  for (let i = 0; i < maxPages && url; i++) {
    const res = await fetchImpl(url, { credentials: "omit" });
    if (!res.ok) throw new Error(`Hacker News returned ${res.status} for the thread.`);
    const html = await res.text();
    pages.push(html);
    const more = nextPageHref(parseDoc(html));
    url = more ? new URL(more, "https://news.ycombinator.com/").href : null;
  }
  return pages;
}

// Pages of one thread -> one thread with continuous comment paths.
export function mergePages(pages, parseDoc, cfg = {}) {
  let thread = null;
  for (const html of pages) {
    const t = parseThread(parseDoc(html), cfg);
    if (!thread) { thread = t; continue; }
    const seen = new Set(thread.comments.map((c) => c.id));
    const top = Math.max(...thread.comments.filter((c) => !c.parent_path).map((c) => Number(c.path)), 0);
    const shift = (p) => (p ? p.split(".").map((x, k) => (k === 0 ? String(Number(x) + top) : x)).join(".") : null);
    for (const c of t.comments) {
      if (seen.has(c.id)) continue;
      c.path = shift(c.path);
      c.parent_path = shift(c.parent_path);
      thread.comments.push(c);
    }
  }
  return thread;
}

// Clean and render. `graph` is a TagGraph or null. Returns everything the UI and the model call need.
export function prepare(thread, graph, cfg = {}) {
  const result = prune(thread, cfg, graph);
  const threadText = renderThreadText(thread, result.kept, result.stats, result.config);
  const tokens = estTokens(threadText);
  result.stats.est_tokens = tokens;
  const abs = result.kept.map((c) => c.relevance?.abs ?? 0).sort((a, b) => b - a);
  const strong = abs.slice(0, 10);
  const threadRelevance = strong.length ? strong.reduce((s, v) => s + v, 0) / strong.length : 0;
  return { result, threadText, tokens, threadRelevance };
}
