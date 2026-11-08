// Raindrop.io REST client: reads the library to build the tag graph, and saves points back.
// Auth is a personal API token from Raindrop's developer settings (kept in storage.local only).
const BASE = "https://api.raindrop.io/rest/v1";

const headers = (token) => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" });

export async function fetchAllItems(token, { fetchImpl = fetch, onProgress, maxPages = 200 } = {}) {
  const items = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchImpl(`${BASE}/raindrops/0?perpage=50&page=${page}`, { headers: headers(token) });
    if (res.status === 401) throw new Error("Raindrop rejected the token.");
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500)); page--; continue; }
    if (!res.ok) throw new Error(`Raindrop returned ${res.status}.`);
    const j = await res.json();
    const batch = j.items || [];
    if (!batch.length) break;
    for (const b of batch) {
      items.push({
        id: b._id, title: b.title || "", excerpt: b.excerpt || "", note: b.note || "",
        tags: b.tags || [], created: b.created || "", link: b.link || "",
        highlights: (b.highlights || []).map((h) => ({ text: h.text || "", note: h.note || "" })),
      });
    }
    if (onProgress) onProgress(items.length);
    if (batch.length < 50) break;
  }
  return items;
}

// Saves a link with tags. The bulk endpoint is used because its body shape is documented.
export async function saveBookmark(token, { link, title, tags = [], note = "" }, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${BASE}/raindrops`, {
    method: "POST", headers: headers(token),
    body: JSON.stringify({ items: [{ link, title, tags, note, pleaseParse: {} }] }),
  });
  if (!res.ok) throw new Error(`Raindrop returned ${res.status} while saving.`);
  return true;
}
