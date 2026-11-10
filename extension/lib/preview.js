// Link previews: the title, description, image and site name a page declares about itself (Open Graph,
// Twitter cards, plain meta tags), read from the first part of its HTML. Environment-neutral: the caller
// supplies the parser. Nothing here runs the page's scripts.

const clean = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t;
};
const abs = (u, base) => { try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

// Links that need no fetch, or that a fetch would not help.
export function quickPreview(url) {
  let u;
  try { u = new URL(url); } catch { return { url, error: "bad-url" }; }
  const host = u.hostname.replace(/^www\./, "");
  if (/\.pdf($|\?)/i.test(u.pathname)) return { url, kind: "pdf", site: host, title: decodeURIComponent(u.pathname.split("/").pop() || "PDF"), description: "PDF document" };
  if (host === "news.ycombinator.com") return { url, kind: "hn", site: "Hacker News", skip: true };
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(u.pathname)) return { url, kind: "image", site: host, image: url, title: u.pathname.split("/").pop() };
  const yt = host === "youtu.be" ? u.pathname.slice(1) : /(^|\.)youtube\.com$/.test(host) ? u.searchParams.get("v") : null;
  if (yt && /^[\w-]{6,}$/.test(yt)) return { url, kind: "video", site: "YouTube", image: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`, needsTitle: true };
  return null;
}

export function parsePreview(html, url, parseDoc) {
  const doc = parseDoc(html);
  const meta = (...keys) => {
    for (const k of keys) {
      const el = doc.querySelector(`meta[property="${k}"], meta[name="${k}"], meta[itemprop="${k}"]`);
      const v = el?.getAttribute("content");
      if (v && v.trim()) return v.trim();
    }
    return "";
  };
  const base = doc.querySelector("base[href]")?.getAttribute("href") || url;
  const canonical = abs(meta("og:url") || doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || "", base);
  const title = clean(meta("og:title", "twitter:title") || doc.querySelector("title")?.textContent || doc.querySelector("h1")?.textContent, 160);
  let description = clean(meta("og:description", "twitter:description", "description"), 300);
  if (!description) {
    const p = [...doc.querySelectorAll("article p, main p, p")].map((x) => x.textContent.trim()).find((t) => t.length > 80);
    description = clean(p, 300);
  }
  const imgRaw = meta("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src", "image");
  const image = imgRaw ? abs(imgRaw, base) : null;
  const icon = abs(doc.querySelector('link[rel~="icon"]')?.getAttribute("href") || "/favicon.ico", base);
  const site = clean(meta("og:site_name", "application-name") || hostOf(canonical || url), 60);
  const published = meta("article:published_time", "datePublished", "date", "dc.date", "citation_publication_date");
  const author = clean(meta("author", "article:author", "citation_author", "twitter:creator"), 80);
  const type = meta("og:type");
  const doi = meta("citation_doi", "dc.identifier");
  return {
    url, final: canonical || url, title, description, image, icon, site,
    published: published || null, author: author && !/^https?:/.test(author) ? author : null,
    kind: doi || meta("citation_title") ? "paper" : /video/.test(type) ? "video" : type === "article" ? "article" : "page",
    doi: doi || null,
  };
}

// Only what is shown is kept, so the cache stays small.
export function slimPreview(p) {
  if (!p) return p;
  const out = {};
  for (const k of ["url", "final", "title", "description", "image", "icon", "site", "published", "author", "kind", "doi", "error", "status"]) if (p[k] != null && p[k] !== "") out[k] = p[k];
  return out;
}
