// The digest: built from your likes alone. Likes due for another look come back on a spaced schedule
// (1, 3, 7, 16, 35, 90 and 180 days); today's stories are ranked by how much they resemble what you liked;
// and everything you liked is kept by topic, as stories, comments and links. No model is called.
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
const HN = "https://news.ycombinator.com/";
const STEPS = 7;
let d = null;
let tab = "story";

const ago = (t) => {
  const days = Math.floor((Date.now() - t) / 864e5);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 30 ? `${days} days ago` : days < 365 ? `${Math.round(days / 30)} months ago` : `${Math.round(days / 365)} years ago`;
};
const threadUrl = (x) => (x.kind === "comment" ? x.url || `${HN}item?id=${x.id}` : x.threadId ? `${HN}item?id=${x.threadId}` : null);
const mainUrl = (x) => (x.kind === "comment" ? threadUrl(x) : x.url || threadUrl(x) || (/^\d+$/.test(x.id) ? `${HN}item?id=${x.id}` : null));
const source = (x) => (x.source === "hn" ? h("span", { class: "src hn", title: "You upvoted this on Hacker News" }, "HN upvote") : h("span", { class: "src you", title: "You gave this a thumbs up in Hamsa" }, "thumbs up"));

// One liked item, with the context that makes it worth coming back to.
function likeCard(x, { review } = {}) {
  const url = mainUrl(x);
  const kindLabel = { story: "Story", comment: "Comment", link: "Link" }[x.kind || "story"];
  const title = x.kind === "comment" ? (x.threadTitle ? `In “${x.threadTitle}”` : "A comment") : x.title || x.url;
  const meta = [
    kindLabel,
    x.kind === "comment" && x.author ? `by ${x.author}` : null,
    x.kind !== "comment" && (x.site || x.domain) ? x.site || x.domain : null,
    x.points ? `${x.points} points` : null,
    `liked ${ago(x.at)}`,
  ].filter(Boolean).join(" · ");
  const excerpt = x.kind === "comment" ? x.excerpt || x.title : x.excerpt;
  const el = h("article", { class: `like ${x.kind || "story"}` },
    h("div", { class: "lmeta" }, h("span", {}, meta), source(x)),
    url ? h("a", { class: "ltitle", href: url }, title) : h("span", { class: "ltitle" }, title),
    excerpt ? h("p", { class: "lex" }, excerpt) : null,
    x.links?.length ? h("div", { class: "llinks" }, "Links in it: ", x.links.slice(0, 3).map((u, i) => [i ? ", " : "", h("a", { href: u }, hostOf(u))])) : null,
    x.kind === "link" && x.threadId ? h("div", { class: "llinks" }, h("a", { href: `${HN}item?id=${x.threadId}` }, `Found in: ${x.threadTitle || "an HN thread"}`)) : null,
    x.kind === "story" && x.threadId && x.url && !x.url.startsWith(HN) ? h("div", { class: "llinks" }, h("a", { href: `${HN}item?id=${x.threadId}` }, "The discussion on HN")) : null,
    x.tags?.length ? h("div", { class: "ltags" }, x.tags.slice(0, 4).map((t) => h("span", { class: "tag" }, t))) : null,
    review ? reviewRow(x) : null);
  return el;
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

function reviewRow(x) {
  const step = Math.min(STEPS, (x.review?.step || 0) + 1);
  const act = (action, label, cls = "secondary") => h("button", { class: cls, type: "button", onclick: async (e) => {
    const card = e.target.closest(".like");
    try {
      await send({ type: "review", id: x.id, action });
      card.classList.add("done");
      card.querySelector(".rrow").replaceChildren(h("span", { class: "rdone" }, { keep: "Kept. It comes back later.", later: "Back tomorrow.", stop: "It won't come back for review.", unlike: "Like removed." }[action]));
      d.due = d.due.filter((y) => y.id !== x.id);
      $("due-count").textContent = d.due.length ? `${d.due.length} to look at` : "All done for today";
    } catch (err) { card.querySelector(".rrow").append(h("span", { class: "rdone" }, err.message)); }
  } }, label);
  return h("div", { class: "rrow" },
    h("span", { class: "rstep", title: "Each time you keep it, the next look comes later: 1, 3, 7, 16, 35, 90, then 180 days" }, h("i", { style: `width:${Math.round((step / STEPS) * 100)}%` }), `look ${step} of ${STEPS}`),
    act("keep", "Still useful", "primary"), act("later", "Remind me tomorrow"), act("stop", "Stop reminding"), act("unlike", "Unlike", "ghost"));
}

function todayCard(p) {
  const st = p.story;
  return h("article", { class: "pick" },
    h("div", { class: "phead" },
      h("a", { class: "ltitle", href: st.url || `${HN}item?id=${st.id}` }, st.title),
      h("span", { class: "score", title: "How much it resembles what you liked, 0 to 1" }, p.score.toFixed(2))),
    h("div", { class: "lmeta" }, [st.domain, st.points ? `${st.points} points` : null, st.by ? `by ${st.by}` : null, st.ageText].filter(Boolean).join(" · "),
      h("a", { href: `${HN}item?id=${st.id}` }, `${st.comments || 0} comments`)),
    h("ul", { class: "because" }, p.reasons.map((r) => h("li", {}, r.label))));
}

function render() {
  const date = new Date(d.built_at);
  $("title").textContent = date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  $("lede").textContent = d.likes
    ? `Made only from the ${d.likes.toLocaleString()} things you liked: your thumbs up in Hamsa and your upvotes on HN. Today's ${d.scanned} front-page stories were read at ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}.`
    : "This digest is made only from what you like, and you have not liked anything yet.";
  if (!d.likes) {
    $("body").replaceChildren(h("section", { class: "emptybox" },
      h("div", { class: "art" }),
      h("h2", {}, "Start with a thumbs up"),
      h("p", {}, "On Hacker News, press the thumbs up on any story, comment or link preview you find worth keeping. Stories you upvote on HN count too. Each like comes back here for another look a day later, then after 3, 7, 16, 35, 90 and 180 days while you still find it useful, and teaches the digest what to pick from tomorrow's front page."),
      h("a", { class: "btnlink primary", href: `${HN}news` }, "Go to Hacker News")));
    $("body").querySelector(".art").innerHTML = '<svg viewBox="0 0 80 60" width="96" height="72" aria-hidden="true"><path d="M14 30h10v22H14z" fill="#f3e5bd" stroke="#7d5a0c" stroke-width="2"/><path d="M24 50h24c4 0 6-3 7-6l5-14c1-4-1-7-5-7H42l2-9c1-4-2-7-5-7l-15 20z" fill="#fffaf3" stroke="#b4531a" stroke-width="2" stroke-linejoin="round"/><path d="M62 10l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#6e3561"/></svg>';
    return foot();
  }
  const lib = d.library;
  if (!lib[tab].count) tab = ["story", "comment", "link"].find((k) => lib[k].count) || tab;
  const tabs = [["story", "Stories"], ["comment", "Comments"], ["link", "Links"]];
  const groups = lib[tab].groups;
  $("body").replaceChildren(
    h("section", { class: "block" },
      h("div", { class: "bhead" }, h("h2", {}, "Look again"), h("span", { id: "due-count", class: "bnote" }, d.due.length ? `${d.due.length} to look at` : "Nothing due today")),
      h("p", { class: "bnote" }, "Likes come back on a growing gap, so what you found useful stays with you. Keep what still helps; stop what no longer does."),
      d.due.length ? h("div", { class: "list" }, d.due.map((x) => likeCard(x, { review: true }))) : h("p", { class: "empty" }, "Nothing is due. Liked items come back a day after you like them, then further apart.")),
    h("section", { class: "block" },
      h("div", { class: "bhead" }, h("h2", {}, "Today, because you liked…"), h("span", { class: "bnote" }, `${d.today.length} of ${d.scanned} stories`)),
      h("p", { class: "bnote" }, "Today's front pages scored only against what you liked: shared words (rarer ones count more), sites and tags. Each story says which like brought it here."),
      d.today.length ? h("div", { class: "list" }, d.today.map(todayCard)) : h("p", { class: "empty" }, "Nothing on today's front pages resembles what you liked. More likes make this sharper.")),
    h("section", { class: "block" },
      h("div", { class: "bhead" }, h("h2", {}, "Everything you liked"), h("span", { class: "bnote" }, "by topic")),
      h("div", { class: "seg", role: "tablist" }, tabs.map(([k, t]) => h("button", { type: "button", role: "tab", "aria-selected": String(tab === k), onclick: () => { tab = k; render(); } }, `${t} · ${lib[k].count}`))),
      groups.length ? groups.map((g) => h("details", { class: "topic", open: groups.length <= 3 ? true : null },
        h("summary", {}, h("strong", {}, g.label), h("span", { class: "bnote" }, `${g.items.length}`)),
        h("div", { class: "list" }, g.items.slice(0, 40).map((x) => likeCard(x))),
        g.items.length > 40 ? h("p", { class: "bnote" }, `and ${g.items.length - 40} more`) : null))
        : h("p", { class: "empty" }, { story: "No liked stories yet.", comment: "No liked comments yet. The thumbs up sits at the foot of every comment.", link: "No liked links yet. Link previews in threads carry a thumbs up." }[tab])));
  foot();
}
function foot() {
  $("foot").textContent = `Scoring rules v${d.rules}. Built with no AI call.`;
  $("usage").textContent = d.usage?.runs ? `Today: ${fmt(d.usage.input)} in · ${fmt(d.usage.output)} out` : "Today: 0 tokens";
}

async function load(force) {
  $("body").replaceChildren(h("div", { class: "empty" }, h("span", { class: "spin" }), force ? "Reading today's front page…" : "Loading the digest…"));
  try { d = await send({ type: "digest", force }); render(); }
  catch (e) { $("body").replaceChildren(h("div", { class: "err" }, `The digest could not be built: ${e.message}`)); }
}

const state = await getState();
applyTheme(state.settings.theme, state.settings.font);
themeButton($("btn-theme"), state.settings.theme, async (t) => { applyTheme(t, state.settings.font); await patchSettings({ theme: t }); });
$("btn-settings").addEventListener("click", () => api.runtime.openOptionsPage());
$("btn-rebuild").addEventListener("click", () => load(true));
load(false);
