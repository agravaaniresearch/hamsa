// The daily digest: pages 1 to 4 of HN scored, grouped into topics, and ranked. Built with no model.
import { api, getState, patchSettings, applyTheme } from "../lib/store.js";
import { themeButton } from "../shared/ui.js";

const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
const send = async (msg) => { const r = await api.runtime.sendMessage(msg); if (r?.error) throw new Error(r.error); return r; };
const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : (n || 0).toLocaleString());
const LABEL = { keep: "KEEP", maybe: "MAYBE", stretch: "STRETCH" };
let digest = null;

function render() {
  const showMaybe = $("show-maybe").checked;
  const list = digest.clusters.filter((c) => c.bucket === "keep" || c.bucket === "stretch" || (showMaybe && c.bucket === "maybe"));
  const d = new Date(digest.built_at);
  $("title").textContent = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  $("lede").textContent = `Built ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}. ${digest.stories} stories from pages 1 to ${digest.pages} grouped into ${digest.clusters.length} topics; ${list.length} shown below.${digest.ready ? "" : " No interests are synced yet, so nothing is ranked: open settings to connect your sources."}`;
  $("clusters").replaceChildren(...(list.length ? list.map((c) => {
    const n = c.items.length;
    const top = c.items[0];
    const why = c.bucket === "stretch" ? (top.verdict.reasons || []).filter((r) => r.points > 0).map((r) => r.label).slice(0, 2).join(" · ") : c.tags.length ? `tags: ${c.tags.join(", ")}` : (top.verdict.reasons || []).slice(0, 2).map((r) => r.label).join(" · ");
    return h("section", { class: `cluster ${c.bucket}` },
      h("div", { class: "chead" }, n > 1 ? h("h2", {}, c.label) : h("h2", {}, h("a", { href: top.story.url, class: "tlink" }, top.story.title)), h("span", { class: `badge ${c.bucket}` }, `${c.score.toFixed(2)} · ${LABEL[c.bucket]}`)),
      h("div", { class: "cmeta" }, `${n > 1 ? `${n} stories on the same topic · ` : ""}${why}`),
      n === 1 ? h("div", { class: "items" }, h("div", {}, h("a", { href: `https://news.ycombinator.com/item?id=${top.story.id}` }, "Open the filtered thread"), h("div", { class: "im" }, [top.story.domain, `${top.story.points} points`, `${top.story.comments} comments`].filter(Boolean).join(" · ")))) :
      h("div", { class: "items" }, c.items.slice(0, 5).map(({ story, verdict }) => h("div", {},
        h("a", { href: `https://news.ycombinator.com/item?id=${story.id}` }, story.title),
        h("div", { class: "im" }, [story.domain, `${story.points} points`, `${story.comments} comments`, `score ${verdict.score.toFixed(2)}`].filter(Boolean).join(" · ")))),
        n > 5 ? h("div", { class: "im" }, `and ${n - 5} more`) : null));
  }) : [h("div", { class: "empty" }, "Nothing cleared the keep bar today. Tick Include maybe to see the held stories.")]));
  $("foot").textContent = `Scoring rules v${digest.rules}. The digest was built with no AI call. It is rebuilt the first time the browser starts each day.`;
  $("usage").textContent = digest.usage?.runs ? `Today: ${fmt(digest.usage.input)} in · ${fmt(digest.usage.output)} out` : "Today: 0 tokens";
}

async function load(force) {
  $("clusters").replaceChildren(h("div", { class: "empty" }, h("span", { class: "spin" }), force ? "Rebuilding from Hacker News…" : "Loading today's digest…"));
  try { digest = await send({ type: "digest", force }); render(); }
  catch (e) { $("clusters").replaceChildren(h("div", { class: "err" }, `The digest could not be built: ${e.message}`)); }
}

const state = await getState();
applyTheme(state.settings.theme, state.settings.font);
themeButton($("btn-theme"), state.settings.theme, async (t) => { applyTheme(t, state.settings.font); await patchSettings({ theme: t }); });
$("btn-settings").addEventListener("click", () => api.runtime.openOptionsPage());
$("btn-rebuild").addEventListener("click", () => load(true));
$("show-maybe").addEventListener("change", () => digest && render());
load(false);
