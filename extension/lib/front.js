// Parses HN listing pages (front page, newest, ask, show, best) into plain story records.
// Works on any DOM: linkedom in tests, DOMParser in the background page.
import { tokenize } from "./tokenize.js";

const num = (s) => parseInt(String(s || "").replace(/[^\d]/g, ""), 10) || 0;

export function parseFront(doc) {
  const stories = [];
  for (const row of doc.querySelectorAll("tr.athing")) {
    if (row.classList.contains("comtr")) continue;
    const id = Number(row.getAttribute("id"));
    if (!id) continue;
    const a = row.querySelector(".titleline > a");
    if (!a) continue;
    const sub = row.nextElementSibling;
    const href = a.getAttribute("href") || "";
    const url = /^https?:/i.test(href) ? href : `https://news.ycombinator.com/${href.replace(/^\//, "")}`;
    const title = (a.textContent || "").trim();
    const commentsA = sub ? [...sub.querySelectorAll("a")].find((x) => /comment|discuss/i.test(x.textContent || "")) : null;
    const by = sub?.querySelector('a.hnuser, a[href^="user?id="]')?.textContent?.trim() || null;
    const kind = !by ? "job" : /^ask hn/i.test(title) ? "ask" : /^show hn/i.test(title) ? "show" : /^tell hn/i.test(title) ? "tell" : "story";
    stories.push({
      id,
      rank: num(row.querySelector(".rank")?.textContent),
      title,
      url,
      external: /^https?:/i.test(href),
      domain: row.querySelector(".sitestr")?.textContent?.trim() || null,
      points: num(sub?.querySelector(".score")?.textContent),
      by,
      age: sub?.querySelector(".age")?.getAttribute("title")?.split(" ")[0] || null,
      ageText: sub?.querySelector(".age a")?.textContent?.trim() || sub?.querySelector(".age")?.textContent?.trim() || "",
      comments: commentsA && /comment/i.test(commentsA.textContent) ? num(commentsA.textContent) : 0,
      voteHref: row.querySelector(`a#up_${id}`)?.getAttribute("href") || null,
      voted: !!row.querySelector(`a#up_${id}.nosee`) || !!row.querySelector(`#up_${id}.nosee`),
      kind,
    });
  }
  const more = doc.querySelector("a.morelink")?.getAttribute("href") || null;
  const me = doc.querySelector("a#me")?.textContent?.trim() || null;
  return { stories, more, me };
}

// Several pages -> one list, first appearance wins (a story can move between pages while they load).
export function mergeFront(pages) {
  const seen = new Set();
  const out = [];
  let me = null;
  for (const p of pages) {
    me = me || p.me;
    for (const s of p.stories) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
  }
  return { stories: out, me };
}

// ---- duplicates ----
// The same link submitted twice, or near-identical titles, become one card: the best-voted submission
// leads and lists the others.

export function normUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "news.ycombinator.com") return null; // Ask HN and similar have no shared link
    const host = u.hostname.replace(/^(www|m|mobile|amp)\./, "");
    let path = u.pathname.replace(/\/(index\.html?)?$/, "").replace(/\/amp$/, "");
    if (/arxiv\.org$/.test(host)) path = path.replace(/^\/(pdf|abs)\//, "/abs/").replace(/v\d+$/, "").replace(/\.pdf$/, "");
    const keep = [...u.searchParams].filter(([k]) => !/^(utm_|ref$|ref_|source$|fbclid|gclid|mc_|s$|share)/i.test(k));
    if (/youtube\.com$/.test(host)) return `youtube/${u.searchParams.get("v") || path}`;
    if (host === "youtu.be") return `youtube/${path.slice(1)}`;
    keep.sort();
    return `${host}${path}${keep.length ? "?" + keep.map(([k, v]) => `${k}=${v}`).join("&") : ""}`.toLowerCase();
  } catch {
    return null;
  }
}

export function groupDuplicates(stories) {
  const n = stories.length;
  const parent = [...Array(n).keys()];
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byUrl = new Map();
  const terms = stories.map((s) => new Set(tokenize(s.title)));
  stories.forEach((s, i) => {
    const k = s.external ? normUrl(s.url) : null;
    if (!k) return;
    if (byUrl.has(k)) parent[find(i)] = find(byUrl.get(k)); else byUrl.set(k, i);
  });
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let shared = 0;
      for (const t of terms[i]) if (terms[j].has(t)) shared++;
      if (shared >= 3 && shared / (terms[i].size + terms[j].size - shared) >= 0.6) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (stories[b].points || 0) - (stories[a].points || 0));
    out.push(g.map((i) => stories[i].id));
  }
  return out; // [[leadId, otherId, ...], ...]
}
