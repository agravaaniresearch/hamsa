// Parses HN listing pages (front page, newest, ask, show, best) into plain story records.
// Works on any DOM: linkedom in tests, DOMParser in the background page.

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
