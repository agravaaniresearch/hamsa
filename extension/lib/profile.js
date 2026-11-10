// The interest profile: everything about you that is not a tag.
//   domains      sites you have bookmarked (Raindrop, browser bookmarks, imported files), with counts
//   histDomains  sites you read often (browser history, opt-in, never leaves the browser)
//   fav          titles of your HN favourites and upvoted stories, as stemmed terms
// Tagged items (Raindrop, browser bookmark folders) go to the tag graph in graph.js instead.
import { tokenize } from "./tokenize.js";

export const PROFILE_SCHEMA = "hamsa.profile/1";
const FAV_MAX = 600;

export function emptyProfile() {
  return { schema: PROFILE_SCHEMA, domains: {}, histDomains: {}, fav: [], sources: {}, built_at: 0 };
}

export function domainOf(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.replace(/^www\./, "");
    // HN shows github.com/user and similar for a few hosts; keep the first path segment there.
    if (/^(github\.com|gitlab\.com|twitter\.com|x\.com|medium\.com|substack\.com)$/.test(host)) {
      const seg = u.pathname.split("/").filter(Boolean)[0];
      return seg ? `${host}/${seg.toLowerCase()}` : host;
    }
    return host;
  } catch {
    return null;
  }
}

const bump = (m, k, n = 1) => { if (k) m[k] = (m[k] || 0) + n; };

// items: [{ link }] from any bookmark source. favourites: [{ title, url }]. history: [{ url, visitCount }].
export function buildProfile({ items = [], favourites = [], history = [], sources = {} } = {}) {
  const p = emptyProfile();
  for (const it of items) {
    const d = domainOf(it.link || it.url || "");
    if (!d || d === "news.ycombinator.com") continue;
    bump(p.domains, d);
    if (d.includes("/")) bump(p.domains, d.split("/")[0]);
  }
  for (const h of history) {
    const d = domainOf(h.url || "");
    if (!d || d === "news.ycombinator.com") continue;
    bump(p.histDomains, d, Math.min(20, h.visitCount || 1));
  }
  const seen = new Set();
  for (const f of favourites) {
    const key = f.id || f.title;
    if (!f.title || seen.has(key)) continue;
    seen.add(key);
    p.fav.push({ title: f.title, terms: [...new Set(tokenize(f.title))] });
    if (p.fav.length >= FAV_MAX) break;
  }
  p.sources = sources;
  p.built_at = Date.now();
  return p;
}

// Browser bookmarks tree -> items. Each folder on the path becomes a tag (folders named like
// "Bookmarks Toolbar" or "Other Bookmarks" are skipped), so a folder called Oncology acts like a tag.
const ROOTS = /^(bookmarks (toolbar|menu)|other bookmarks|mobile bookmarks|menu|toolbar|unfiled|unsorted|)$/i;
export function bookmarkTreeToItems(tree) {
  const items = [];
  const walk = (node, path) => {
    if (node.url) {
      if (/^https?:/i.test(node.url)) items.push({ title: node.title || "", link: node.url, tags: path.slice(-3), created: node.dateAdded ? new Date(node.dateAdded).toISOString() : "", source: "bookmarks" });
      return;
    }
    const name = (node.title || "").trim();
    const next = name && !ROOTS.test(name) ? [...path, name.toLowerCase()] : path;
    for (const c of node.children || []) walk(c, next);
  };
  for (const n of Array.isArray(tree) ? tree : [tree]) walk(n, []);
  return items;
}

// A Netscape bookmarks file (what every browser exports). Folder headings become tags, and a
// TAGS attribute (Pinboard, Raindrop, Firefox exports) is read when present.
export function parseBookmarksFile(doc) {
  const items = [];
  const tag = (el) => (el?.tagName || "").toUpperCase();
  const attr = (el, n) => el.getAttribute(n) ?? el.getAttribute(n.toUpperCase());
  // Exports wrap entries in <p> and parsers disagree on where a folder's <DL> lands, so look through both.
  const entries = (dl) => [...dl.children].flatMap((c) => (tag(c) === "P" ? [...c.children] : [c]));
  const walk = (dl, path) => {
    const list = entries(dl);
    list.forEach((dt, i) => {
      if (tag(dt) !== "DT") return;
      const kids = [...dt.children];
      const a = kids.find((x) => tag(x) === "A");
      const h3 = kids.find((x) => tag(x) === "H3");
      if (a) {
        const href = attr(a, "href") || "";
        if (!/^https?:/i.test(href)) return;
        const own = (attr(a, "tags") || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
        items.push({ title: (a.textContent || "").trim(), link: href, tags: [...new Set([...own, ...path.slice(-3)])], created: attr(a, "add_date") ? new Date(Number(attr(a, "add_date")) * 1000).toISOString() : "", source: "file" });
      } else if (h3) {
        const sub = kids.find((x) => tag(x) === "DL") || (tag(list[i + 1]) === "DL" ? list[i + 1] : null);
        const name = (h3.textContent || "").trim();
        if (sub) walk(sub, name && !ROOTS.test(name) ? [...path, name.toLowerCase()] : path);
        // Entries after the folder's list can be parsed into the folder's <DT>; they belong to this level.
        for (const p of kids.filter((x) => tag(x) === "P")) walk(p, path);
      }
    });
  };
  const top = doc.querySelector("dl");
  if (top) walk(top, []);
  return items;
}

// HN favourites or upvoted pages -> stories, with the next page link.
export function parseHnList(doc) {
  const items = [];
  for (const row of doc.querySelectorAll("tr.athing")) {
    if (row.classList.contains("comtr")) continue;
    const a = row.querySelector(".titleline > a");
    if (!a) continue;
    items.push({ id: Number(row.getAttribute("id")), title: (a.textContent || "").trim(), url: a.getAttribute("href") || "" });
  }
  return { items, more: doc.querySelector("a.morelink")?.getAttribute("href") || null };
}
