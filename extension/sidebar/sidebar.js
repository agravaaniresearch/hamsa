import { api, getState, patchSettings, applyTheme } from "../lib/store.js";
import { isUsable } from "../lib/providers.js";
import { fmtInr } from "../lib/pricing.js";

const $ = (s) => document.querySelector(s);
const main = $("#main");
let tabId = null, threadId = null, state = null, current = null, busy = false;
const logLines = [];

// Small DOM helper. Text always goes through textContent, so model output can never inject markup.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}

const send = async (msg) => {
  const r = await api.runtime.sendMessage(msg);
  if (r?.error) throw new Error(r.error);
  return r;
};

function note(text) {
  logLines.unshift(text);
  logLines.length = Math.min(logLines.length, 3);
  const box = $("#log");
  if (box) box.replaceChildren(...logLines.map((l) => h("div", {}, l)));
}

// ---- header: provider and model picker ----
function fillPicker() {
  const sel = $("#model");
  sel.replaceChildren();
  const usable = state.providers.filter(isUsable);
  for (const p of usable) {
    const models = p.models?.length ? p.models : [];
    const g = h("optgroup", { label: p.name });
    for (const m of models) g.append(h("option", { value: `${p.id}|${m}` }, m));
    if (models.length) sel.append(g);
  }
  if (!sel.children.length) sel.append(h("option", { value: "" }, "No model set"));
  const a = state.settings.active;
  if (a.providerId && a.model) sel.value = `${a.providerId}|${a.model}`;
}
$("#model").addEventListener("change", async (e) => {
  const [providerId, ...rest] = e.target.value.split("|");
  await patchSettings({ active: { providerId, model: rest.join("|") } });
  state = await getState();
  if (threadId && !current) renderReady();
});
$("#open-options").addEventListener("click", () => api.runtime.openOptionsPage());

function chosen() {
  const v = $("#model").value;
  if (!v) return {};
  const [providerId, ...rest] = v.split("|");
  return { providerId, model: rest.join("|") };
}

// ---- screens ----
function renderEmpty() {
  current = null;
  main.replaceChildren(h("div", { class: "empty" }, h("h2", {}, "Open a Hacker News thread"), h("p", {}, "Go to a thread page, then press the button below or the Summarise button on the page."), h("button", { class: "btn", onclick: refresh }, "Check this tab again")));
}

function setupHint() {
  const need = [];
  if (!state.providers.some(isUsable)) need.push("add a provider and test its key");
  if (!state.graph) need.push("sync your Raindrop tags");
  if (!need.length) return null;
  return h("div", { class: "card" }, h("div", { class: "title" }, "Finish setup"), h("p", { class: "sub" }, `In settings, ${need.join(" and ")}. ${state.graph ? "" : "Without tags, Hamsa still cleans and summarises but cannot rank by your interests."}`), h("button", { class: "btn small", onclick: () => api.runtime.openOptionsPage() }, "Open settings"));
}

async function renderReady() {
  main.replaceChildren(h("div", { class: "empty" }, h("span", { class: "spin" }), "Reading the thread…"));
  let info, cost = null;
  try {
    info = await send({ type: "prepare", id: threadId });
    const { providerId, model } = chosen();
    if (providerId && model) cost = await send({ type: "cost", id: threadId, providerId, model }).catch(() => null);
  } catch (e) {
    return main.replaceChildren(h("div", { class: "err" }, e.message), h("button", { class: "btn", onclick: renderReady }, "Try again"));
  }
  const dropped = info.dropped;
  const hint = setupHint();
  main.replaceChildren(
    ...(hint ? [hint] : []),
    h("div", { class: "card" },
      h("div", { class: "title" }, info.title),
      h("div", { class: "sub" }, [info.domain, `${info.points} points`].filter(Boolean).join(" · ")),
      h("div", { class: "strip", style: "margin-top:8px" },
        h("span", {}, `${info.kept} of ${info.rows} comments kept`),
        h("span", {}, `about ${info.tokens.toLocaleString()} tokens`),
        h("span", {}, cost ? `cost ${fmtInr(cost)}` : "cost unknown")),
      h("details", { style: "margin-top:6px" }, h("summary", {}, "What was left out"),
        h("ul", { class: "plain" },
          h("li", {}, `${dropped.short} short replies`),
          h("li", {}, `${dropped.flame_chain} flame-chain replies`),
          h("li", {}, `${dropped.downvoted} downvoted`),
          h("li", {}, `${dropped.unavailable} dead, deleted or collapsed`),
          h("li", {}, `${dropped.budget} cut for the token budget, lowest priority first`))),
      h("div", { class: "row" },
        h("button", { class: "btn primary", onclick: () => run(false) }, info.cached ? "Show saved summary" : "Summarise"),
        info.cached ? h("button", { class: "btn", onclick: () => run(true) }, "Run again") : null)));
}

async function run(force) {
  if (busy) return;
  const { providerId, model } = chosen();
  if (!providerId || !model) return main.prepend(h("div", { class: "err" }, "Choose a provider and model first: open settings, add a provider, test its key and pick a model."));
  busy = true;
  main.replaceChildren(h("div", { class: "empty" }, h("span", { class: "spin" }), "Summarising with ", model, "…"));
  try {
    current = await send({ type: "summarise", id: threadId, providerId, model, force });
    renderResult();
  } catch (e) {
    main.replaceChildren(h("div", { class: "err" }, e.message), h("button", { class: "btn", onclick: renderReady }, "Back"));
  } finally {
    busy = false;
  }
}

const relClass = (r) => (r >= 0.5 ? "high" : r >= 0.2 ? "medium" : "low");
const relLabel = (r) => (r >= 0.5 ? "High" : r >= 0.2 ? "Medium" : "Low");

function refsRow(refs, tags = []) {
  return h("div", { class: "refs" }, refs.length ? "Comments " : "", refs.map((r, i) => [i ? ", " : "", h("button", { title: "Scroll to this comment", onclick: () => jump(r, tags) }, r)]));
}

const used = new Set();
async function jump(path, tags = []) {
  const id = current.ids[path];
  // Opening a cited comment is a quiet signal of interest, counted once per comment.
  if (tags.length && state.settings.learning !== "off" && !used.has(path)) {
    used.add(path);
    send({ type: "feedback", kind: "implicit", tags, delta: 0.1 }).then((o) => note(o.note)).catch(() => {});
  }
  const r = await send({ type: "jump", tabId, id }).catch(() => ({ found: false }));
  if (!r?.found) api.tabs.create({ url: `https://news.ycombinator.com/item?id=${id}`, active: false });
}

function pointCard(p, idx) {
  const mode = state.settings.learning;
  const tags = p.tags || [];
  const reasonsBox = h("div", { class: "reasons", hidden: true });
  const up = h("button", { class: "btn small thumb", "aria-label": "More like this", onclick: () => thumb("up") }, "More like this");
  const dn = h("button", { class: "btn small thumb", "aria-label": "Less like this", onclick: () => thumb("down") }, "Less");
  async function thumb(dir) {
    up.className = "btn small thumb" + (dir === "up" ? " on-up" : "");
    dn.className = "btn small thumb" + (dir === "down" ? " on-dn" : "");
    reasonsBox.hidden = false;
    reasonsBox.replaceChildren(
      h("div", {}, dir === "up" ? "What made it good? Optional." : "What was wrong? Optional."),
      ...(dir === "up" ? ["Right topic", "Useful detail", "Good source"] : ["Wrong topic", "Already know this", "Too shallow", "Wrong reason shown"]).map((r) =>
        h("button", { class: "btn small", onclick: async (e) => { reasonsBox.querySelectorAll("button").forEach((b) => b.classList.remove("sel")); e.target.classList.add("sel"); const o = await send({ type: "feedback", kind: "thumb", dir, tags, reason: r }).catch((x) => ({ note: x.message })); note(o.note || r); } }, r)));
    const o = await send({ type: "feedback", kind: "thumb", dir, tags }).catch((x) => ({ note: x.message }));
    note(`${p.claim.slice(0, 28)}…: ${o.note || ""}`);
  }
  const tagButtons = tags.map((t) => {
    const b = h("button", { class: "tg", "data-s": "0", title: "Tap to boost, again to mute, again to reset" }, t);
    b.addEventListener("click", async () => {
      const s = (+b.dataset.s + 1) % 3;
      b.dataset.s = String(s);
      const o = await send({ type: "feedback", kind: "tag", tag: t, action: ["reset", "boost", "mute"][s] }).catch((x) => ({ note: x.message }));
      note(o.note || t);
    });
    return b;
  });
  const save = h("button", { class: "btn small", onclick: async (e) => {
    const o = await send({ type: "save-point", id: threadId, title: current.title, tags, point: p.claim }).catch((x) => ({ note: x.message }));
    e.target.textContent = o.saved ? "Saved" : "Counted";
    note(o.note);
  } }, "Save to Raindrop");
  const rel = p.rel ?? 0;
  return h("div", { class: "card point" },
    h("div", {}, h("span", { class: `chip ${relClass(rel)}` }, relLabel(rel)), h("span", { class: "chip basis" }, (p.basis || "").replace("_", " "))),
    h("p", {}, p.claim),
    h("p", { class: "why" }, "Why it matters to you: ", p.why_relevant),
    refsRow(p.refs, tags),
    mode === "off" ? null : h("div", { class: "row" }, tags.length ? h("span", { class: "sub" }, "Matched on") : null, tagButtons),
    mode === "off" ? null : h("div", { class: "row" }, mode === "thumbs" ? [up, dn] : null, save),
    reasonsBox);
}

function toMarkdown(r) {
  const s = r.summary, L = [`# ${r.title}`, "", s.gist, "", `*Relevance: ${s.relevance_note}*`, ""];
  const link = (refs) => refs.map((x) => `[${x}](https://news.ycombinator.com/item?id=${r.ids[x]})`).join(", ");
  if (s.points.length) { L.push("## Points", ""); for (const p of s.points) L.push(`- **${p.basis.replace("_", " ")}:** ${p.claim} (${link(p.refs)})`, `  - *Why it matters to you:* ${p.why_relevant}`); L.push(""); }
  if (s.disagreements.length) { L.push("## Real disagreements", ""); for (const d of s.disagreements) { L.push(`- **${d.question}**`); for (const x of d.sides) L.push(`  - ${x.position}: ${x.best_case} (${link(x.refs)})`); } L.push(""); }
  if (s.corrections.length) { L.push("## Corrections", ""); for (const c of s.corrections) L.push(`- ${c.claim} → ${c.correction} (${link(c.refs)})`); L.push(""); }
  if (s.links.length) { L.push("## Links that carry evidence", ""); for (const l of s.links) L.push(`- ${l.url}: ${l.why} (${link([l.ref])})`); L.push(""); }
  return L.join("\n");
}

function renderResult() {
  const r = current, s = r.summary;
  const d = r.stats.dropped;
  main.replaceChildren(...[
    h("div", { class: "card" },
      h("div", { class: "title" }, r.title),
      h("p", { class: "gist" }, s.gist),
      h("p", { class: "note" }, `Relevance to you: ${s.relevance_note}`),
      h("div", { class: "strip", style: "margin-top:8px" },
        h("span", {}, `${r.stats.kept} of ${r.stats.rows} comments read`),
        h("span", {}, `${r.words} words`),
        h("span", {}, `${r.model} · ${fmtInr(r.cost)}${r.fromCache ? " · saved copy" : ""}`))),
    ...s.points.map(pointCard),
    s.disagreements.length ? h("div", { class: "card" }, h("h3", {}, "Real disagreements"), ...s.disagreements.map((x) => h("div", {}, h("div", { class: "title" }, x.question), h("ul", { class: "plain" }, x.sides.map((side) => h("li", {}, h("strong", {}, side.position.replace(/[.:;,\s]+$/, "")), ": ", side.best_case, " ", refsRow(side.refs))))))) : null,
    s.corrections.length ? h("div", { class: "card" }, h("h3", {}, "Corrections"), h("ul", { class: "plain" }, s.corrections.map((c) => h("li", {}, c.claim, " → ", c.correction, " ", refsRow(c.refs))))) : null,
    s.links.length ? h("div", { class: "card" }, h("h3", {}, "Links that carry evidence"), h("ul", { class: "plain" }, s.links.map((l) => h("li", {}, h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.url), ": ", l.why)))) : null,
    h("div", { class: "card" },
      h("div", { class: "sub" }, `Left out: ${d.short} short replies, ${d.flame_chain} flame-chain replies, ${d.downvoted} downvoted, ${d.budget} over budget.`),
      h("div", { class: "sub", style: "margin-top:8px" }, "Learning from you"),
      h("div", { class: "seg", role: "group", "aria-label": "Learning mode" }, [["implicit", "Implicit"], ["thumbs", "Implicit and thumbs"], ["off", "Off"]].map(([v, label]) =>
        h("button", { class: state.settings.learning === v ? "on" : "", onclick: async () => { await patchSettings({ learning: v }); state = await getState(); renderResult(); } }, label))),
      h("div", { class: "log", id: "log", style: "margin-top:8px" }, logLines.length ? logLines.map((l) => h("div", {}, l)) : h("div", {}, "Tap a tag, save a point or use a thumb. What changed shows here."))),
    h("div", { class: "row" },
      h("button", { class: "btn small", onclick: async (e) => { await navigator.clipboard.writeText(toMarkdown(r)); e.target.textContent = "Copied"; } }, "Copy as Markdown"),
      h("button", { class: "btn small", onclick: () => run(true) }, "Run again"),
      h("button", { class: "btn small", onclick: renderReady }, "Back")),
  ].filter(Boolean));
}

// ---- tab tracking ----
async function refresh() {
  state = await getState();
  applyTheme(state.settings.theme, state.settings.font);
  fillPicker();
  const t = await send({ type: "active-thread" }).catch(() => ({ id: null }));
  tabId = t.tabId;
  if (t.id === threadId && (current || busy)) return;
  threadId = t.id;
  if (!threadId) return renderEmpty();
  current = null;
  renderReady();
}

api.tabs.onActivated.addListener(refresh);
api.tabs.onUpdated.addListener((id, change) => { if (change.url || change.status === "complete") refresh(); });
api.storage.onChanged.addListener((ch) => { if (ch.providers || ch.settings) getState().then((s) => { state = s; fillPicker(); }); });
refresh();
