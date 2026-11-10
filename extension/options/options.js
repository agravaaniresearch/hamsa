import { api, getState, save, patchSettings, newProvider, PRESETS, applyTheme, DEFAULT_SETTINGS } from "../lib/store.js";
import { keySig, originPattern } from "../lib/providers.js";
import { normaliseBlocklist, emptyBlocklist } from "../lib/blocklist.js";
import { parseBookmarksFile } from "../lib/profile.js";
import { SCORING_DEFAULTS } from "../lib/score.js";
import { themeButton } from "../shared/ui.js";

const $ = (id) => document.getElementById(id);
let state;
const HN_ORIGIN = "https://news.ycombinator.com/*";

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
const send = async (msg) => { const r = await api.runtime.sendMessage(msg); if (r?.error) throw new Error(r.error); return r; };

// Parshva-style notice: an icon, a bold line and a detail line.
let toastTimer = null;
function notify(kind, title, detail = "") {
  const t = $("toast");
  t.className = `toast ${kind}`;
  t.replaceChildren(h("span", { class: "ticon" }, kind === "ok" ? "✓" : kind === "bad" ? "!" : "i"), h("div", { class: "tbody" }, h("strong", {}, title), detail), h("button", { class: "tclose", type: "button", "aria-label": "Close", onclick: () => { t.hidden = true; } }, "×"));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === "bad" ? 9000 : 3500);
}

// ---- appearance ----
function initAppearance() {
  const s = state.settings;
  const btn = themeButton($("btn-theme"), s.theme, (t) => setTheme(t));
  async function setTheme(t) {
    state.settings.theme = t;
    applyTheme(t, state.settings.font);
    btn.set(t);
    for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === t;
    await patchSettings({ theme: t });
  }
  for (const r of document.querySelectorAll('input[name="theme"]')) {
    r.checked = r.value === (s.theme || "auto");
    r.addEventListener("change", () => { setTheme(r.value); notify("ok", `Theme: ${r.value === "auto" ? "Auto" : r.value === "light" ? "Light" : "Dark"}`, r.value === "auto" ? "Following your system setting." : "Applied to Hacker News, the digest and this page."); });
  }
  $("layer").value = s.layer === false ? "off" : "on";
  $("layer").addEventListener("change", async (e) => { await patchSettings({ layer: e.target.value === "on" }); notify("ok", e.target.value === "on" ? "Hamsa is on for Hacker News" : "Hamsa is off: HN shows as normal"); });
  $("order").value = s.order || "hamsa";
  $("order").addEventListener("change", (e) => patchSettings({ order: e.target.value }));
  $("font").value = s.font || "system";
  $("font").addEventListener("change", async (e) => { await patchSettings({ font: e.target.value }); state.settings.font = e.target.value; applyTheme(state.settings.theme, e.target.value); });
}

async function checkPermission() {
  const ok = await api.permissions.contains({ origins: [HN_ORIGIN] });
  $("perm").hidden = ok;
  $("perm-grant").onclick = async () => {
    const granted = await api.permissions.request({ origins: [HN_ORIGIN, "https://api.raindrop.io/*"] }).catch(() => false);
    $("perm").hidden = granted;
    if (granted) notify("ok", "Hamsa can now run on Hacker News", "Reload any open HN tab.");
  };
}

// ---- interest sources ----
const OPTIONAL = { bookmarks: "bookmarks", history: "history" };
async function initSources() {
  const src = state.settings.sources;
  for (const key of ["raindrop", "highlights", "hnfav", "bookmarks", "history"]) {
    const box = $(`src-${key}`);
    box.checked = !!src[key];
    box.addEventListener("change", async () => {
      if (box.checked && OPTIONAL[key]) {
        const granted = await api.permissions.request({ permissions: [OPTIONAL[key]] }).catch(() => false);
        if (!granted) { box.checked = false; return notify("warn", "Permission not given", `Hamsa cannot read your ${key} without it.`); }
      }
      const { settings = {} } = await api.storage.local.get("settings");
      await patchSettings({ sources: { ...DEFAULT_SETTINGS.sources, ...(settings.sources || {}), [key]: box.checked } });
      notify("ok", `${box.closest(".src")?.querySelector("strong")?.textContent || "Highlights"} ${box.checked ? "on" : "off"}`, "Press Sync all sources to apply.");
    });
  }
  $("rd-token").value = state.raindropToken || "";
  $("rd-token").addEventListener("change", (e) => save({ raindropToken: e.target.value.trim() }));
  $("rd-eye").addEventListener("click", () => { const i = $("rd-token"); i.type = i.type === "password" ? "text" : "password"; $("rd-eye").textContent = i.type === "password" ? "Show" : "Hide"; });
  $("hn-user").value = state.settings.hnUser || "";
  $("hn-user").addEventListener("change", (e) => patchSettings({ hnUser: e.target.value.trim() }));

  $("bm-file").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const items = /\.json$/i.test(f.name) ? itemsFromJson(JSON.parse(text)) : parseBookmarksFile(new DOMParser().parseFromString(text, "text/html"));
      if (!items.length) throw new Error("No bookmarks found in that file.");
      await save({ importedItems: items.slice(0, 50000) });
      notify("ok", `Imported ${items.length.toLocaleString()} bookmarks`, "Press Sync all sources to use them.");
      await drawCounts();
    } catch (err) { notify("bad", "Import failed", err.message); }
    e.target.value = "";
  });
  $("bm-clear").addEventListener("click", async () => { await save({ importedItems: [] }); notify("ok", "Imported bookmarks removed", "Sync again to drop them from scoring."); drawCounts(); });

  $("sync").addEventListener("click", async (e) => {
    await save({ raindropToken: $("rd-token").value.trim() });
    await patchSettings({ hnUser: $("hn-user").value.trim() });
    e.target.disabled = true; e.target.textContent = "Syncing…";
    try {
      const r = await send({ type: "sync" });
      $("sync-status").textContent = `${r.items.toLocaleString()} bookmarks, ${r.tags.toLocaleString()} tags, ${r.domains.toLocaleString()} sites, ${r.favourites.toLocaleString()} favourites.`;
      notify(r.notes.length ? "warn" : "ok", "Sources synced", r.notes.join(" ") || "Scores on HN use the new interests from the next page you open.");
      await refreshGraph();
    } catch (err) { notify("bad", "Sync failed", err.message); }
    e.target.disabled = false; e.target.textContent = "Sync all sources";
  });
  api.runtime.onMessage.addListener((m) => { if (m?.type === "sync-progress") $("sync-status").textContent = `Reading ${m.source}… ${m.n.toLocaleString()}`; });
  await drawCounts();
}

// Pinboard and similar JSON exports: [{ href|url|link, description|title, tags: "a b" | [..] }]
function itemsFromJson(j) {
  const arr = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : [];
  return arr.map((x) => ({
    title: x.title || x.description || "", link: x.href || x.url || x.link || "",
    tags: Array.isArray(x.tags) ? x.tags : String(x.tags || "").split(/[\s,]+/).filter(Boolean),
    excerpt: x.extended || x.excerpt || x.note || "", created: x.time || x.created || "", source: "file",
  })).filter((x) => /^https?:/i.test(x.link));
}

async function drawCounts() {
  const { profile, importedItems = [] } = await api.storage.local.get(["profile", "importedItems"]);
  const s = profile?.sources || {};
  const set = (id, n) => { $(id).textContent = n ? n.toLocaleString() : ""; $(id).className = n ? "badge ok" : "badge"; $(id).hidden = !n; };
  set("n-raindrop", s.raindrop?.items);
  set("n-hnfav", s.hnfav?.items);
  set("n-bookmarks", s.bookmarks?.items);
  set("n-history", s.history?.items);
  set("n-file", importedItems.length);
}

function renderTags(info) {
  const box = $("top-tags");
  if (!info.ready) { box.replaceChildren(h("span", { class: "status" }, "No interests yet. Switch on a source and press Sync all sources.")); return; }
  box.replaceChildren(...info.top.map((t) => {
    const b = h("button", { class: "tg", type: "button", "data-s": info.muted.includes(t.tag) ? "2" : t.adj > 0 ? "1" : "0", title: `${t.count} bookmarks, weight ${t.weight}` }, t.tag);
    b.addEventListener("click", async () => {
      const s = (+b.dataset.s + 1) % 3;
      b.dataset.s = String(s);
      await send({ type: "feedback", kind: "tag", tag: t.tag, action: ["reset", "boost", "mute"][s] }).catch((e) => notify("bad", "Could not change the tag", e.message));
    });
    return b;
  }));
}
async function refreshGraph() {
  const info = await send({ type: "graph-info" });
  if (info.ready) $("sync-status").textContent = `${info.items.toLocaleString()} items, ${info.tags.toLocaleString()} tags in use, ${info.domains.toLocaleString()} sites, ${info.favourites.toLocaleString()} favourites${info.syncedAt ? `. Synced ${new Date(info.syncedAt).toLocaleString()}` : ""}.`;
  renderTags(info);
  await drawCounts();
}

// ---- blocklist ----
let bl = emptyBlocklist();
async function saveBl(note) {
  try {
    const r = await send({ type: "blocklist-save", blocklist: bl });
    bl = r.blocklist;
    if (note) notify("ok", note);
  } catch (e) { notify("bad", "Blocklist not saved", e.message); }
  drawGroups();
}

function drawGroups() {
  const box = $("groups");
  if (!bl.groups.length) { box.replaceChildren(h("p", { class: "status" }, "No groups yet. Add one by hand, or describe what you do not want and press Draft rules.")); return; }
  box.replaceChildren(...bl.groups.map((g, i) => {
    const enabled = h("input", { type: "checkbox", checked: g.enabled, "aria-label": `Use ${g.name}` });
    enabled.addEventListener("change", () => { g.enabled = enabled.checked; saveBl(`${g.name}: ${g.enabled ? "on" : "off"}`); });
    const name = h("input", { type: "text", value: g.name, "aria-label": "Group name" });
    name.addEventListener("change", () => { g.name = name.value.trim() || g.name; saveBl(); });
    const pats = h("textarea", { rows: 3, spellcheck: "false", "aria-label": `Patterns for ${g.name}` });
    pats.value = g.patterns.join("\n");
    pats.addEventListener("change", () => { g.patterns = pats.value.split("\n").map((x) => x.trim()).filter(Boolean); saveBl("Patterns saved"); });
    const field = (f) => {
      const c = h("input", { type: "checkbox", checked: g.fields.includes(f) });
      c.addEventListener("change", () => { g.fields = c.checked ? [...new Set([...g.fields, f])] : g.fields.filter((x) => x !== f); if (!g.fields.length) g.fields = [f === "title" ? "domain" : "title"]; saveBl(); });
      return h("label", {}, c, f === "title" ? "Titles" : "Domains");
    };
    return h("div", { class: `group${g.enabled ? "" : " off"}` },
      h("div", { class: "ghead" }, h("label", { class: "switch" }, enabled, h("span")), name,
        g.source !== "manual" ? h("span", { class: "badge warn" }, g.source) : null,
        h("button", { class: "danger", type: "button", onclick: () => { bl.groups.splice(i, 1); saveBl(`${g.name} removed`); } }, "Remove")),
      h("div", { class: "gbody" },
        h("div", { class: "gfields" }, h("span", { class: "status" }, "Match in"), field("title"), field("domain")),
        h("label", { class: "field" }, h("span", {}, "Patterns, one per line. Plain words match whole words; write /like this/ for a regular expression."), pats),
        g.note ? h("small", {}, g.note) : null));
  }));
}

async function initBlocklist() {
  bl = state.blocklist || emptyBlocklist();
  drawGroups();
  $("add-group").addEventListener("click", () => { bl.groups.push({ id: `group-${Date.now()}`, name: "New group", patterns: ["example phrase"], fields: ["title", "domain"], enabled: false, source: "manual" }); saveBl("Group added (off until you switch it on)"); });
  $("draft").addEventListener("click", async (e) => {
    e.target.disabled = true; $("bl-status").textContent = "Drafting…";
    try {
      const r = await send({ type: "blocklist-draft", text: $("draft-text").value });
      bl.groups.push(...r.groups);
      await saveBl();
      $("bl-status").textContent = `${r.groups.length} groups drafted with ${r.model} (${r.usage.input + r.usage.output} tokens). They are off until you switch them on.`;
    } catch (err) { $("bl-status").textContent = ""; notify("bad", "Drafting failed", err.message); }
    e.target.disabled = false;
  });
  $("test").addEventListener("click", async (e) => {
    if (!bl.groups.length) return notify("warn", "Nothing to test", "Add or draft a group first.");
    e.target.disabled = true; $("bl-status").textContent = "Reading today's front page…";
    try {
      const r = await send({ type: "blocklist-test", blocklist: bl });
      $("bl-status").textContent = `Tested against ${r.tested} stories.`;
      $("test-out").replaceChildren(...r.groups.map((g) => h("div", { class: "testgroup" },
        h("strong", {}, `${g.name}${g.enabled ? "" : " (off)"}: ${g.hits.length} would be blocked`),
        g.hits.length ? h("ul", { class: "hits" }, g.hits.slice(0, 12).map((x) => h("li", {}, x.title, x.domain ? ` (${x.domain})` : ""))) : null)));
    } catch (err) { $("bl-status").textContent = ""; notify("bad", "Test failed", err.message); }
    e.target.disabled = false;
  });
  $("bl-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(bl, null, 2)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: "hamsa-blocklist.json" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $("bl-import").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const incoming = normaliseBlocklist(JSON.parse(await f.text()), { source: "imported" });
      const names = new Set(bl.groups.map((g) => g.name.toLowerCase()));
      const add = incoming.groups.filter((g) => !names.has(g.name.toLowerCase())).map((g) => ({ ...g, enabled: false }));
      bl.groups.push(...add);
      await saveBl(`${add.length} groups imported (off until you switch them on)`);
    } catch (err) { notify("bad", "Import failed", err.message); }
    e.target.value = "";
  });
  await drawSuggestions();
}

async function drawSuggestions() {
  const r = await send({ type: "suggestions" }).catch(() => ({ suggestions: [] }));
  const box = $("suggest");
  box.hidden = !r.suggestions.length;
  box.replaceChildren(h("strong", {}, "Suggested from what you dismissed"), ...r.suggestions.map((s) => h("div", { class: "row" },
    h("span", { style: "flex:1;min-width:220px" }, `${s.name}: ${s.count} dismissed, such as "${s.sample[0]}"`),
    h("button", { class: "secondary", type: "button", onclick: async () => { bl.groups.push({ id: `sug-${Date.now()}`, name: s.name, patterns: s.patterns, fields: s.fields, enabled: false, source: "suggested" }); await saveBl("Added as a group (off until you switch it on)"); drawSuggestions(); } }, "Review rule"))));
}

// ---- scoring ----
function initScoring() {
  const sc = { ...SCORING_DEFAULTS, ...state.settings.scoring };
  const keys = Object.keys(SCORING_DEFAULTS);
  for (const k of keys) {
    $(`sc-${k}`).value = sc[k];
    $(`sc-${k}`).addEventListener("change", async (e) => {
      const { settings = {} } = await api.storage.local.get("settings");
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      await patchSettings({ scoring: { ...SCORING_DEFAULTS, ...(settings.scoring || {}), [k]: v } });
      notify("ok", "Scoring saved", "Applies from the next HN page you open.");
    });
  }
  $("gate").value = state.settings.gate === false ? "off" : "on";
  $("gate").addEventListener("change", (e) => patchSettings({ gate: e.target.value === "on" }));
  $("sc-reset").addEventListener("click", async () => {
    await patchSettings({ scoring: { ...SCORING_DEFAULTS } });
    for (const k of keys) $(`sc-${k}`).value = SCORING_DEFAULTS[k];
    notify("ok", "Scoring reset to starting values");
  });
}

// ---- providers ----
async function persistProviders() { await save({ providers: state.providers }); }
function renderProviders() {
  const box = $("providers");
  if (!state.providers.length) { box.replaceChildren(h("p", { class: "status" }, "No providers yet. Pick one below and add your key.")); return; }
  box.replaceChildren(...state.providers.map((p) => {
    const ks = p.keyStatus && p.keyStatus.sig === keySig(p) ? p.keyStatus : null;
    const status = h("span", { class: `badge ${ks ? (ks.state === "ok" || ks.state === "unverified" ? "ok" : "bad") : ""}` }, ks ? ks.message : "Not tested");
    const models = h("div", { class: "models" }, (p.knownModels || p.models || []).slice(0, 80).map((m) =>
      h("label", {}, h("input", { type: "checkbox", checked: (p.models || []).includes(m), onchange: async (e) => { p.models = e.target.checked ? [...new Set([...(p.models || []), m])] : (p.models || []).filter((x) => x !== m); await persistProviders(); } }), m)));
    const custom = h("input", { type: "text", placeholder: "Add a model id by hand, then press Enter", onkeydown: async (e) => { if (e.key === "Enter" && e.target.value.trim()) { const m = e.target.value.trim(); p.knownModels = [...new Set([...(p.knownModels || []), m])]; p.models = [...new Set([...(p.models || []), m])]; await persistProviders(); renderProviders(); } } });
    const key = h("input", { type: "password", value: p.apiKey || "", autocomplete: "off", spellcheck: "false", "aria-label": `${p.name} API key`, onchange: async (e) => { p.apiKey = e.target.value.trim(); await persistProviders(); renderProviders(); } });
    return h("div", { class: "prov" },
      h("div", { class: "head" }, h("strong", {}, p.name), status, h("button", { class: "danger", type: "button", onclick: async () => { state.providers = state.providers.filter((x) => x.id !== p.id); await persistProviders(); renderProviders(); } }, "Remove")),
      h("div", { class: "grid", style: "margin-top:0" },
        h("label", { class: "field" }, h("span", {}, "Name"), h("input", { type: "text", value: p.name, onchange: async (e) => { p.name = e.target.value; await persistProviders(); } })),
        h("label", { class: "field" }, h("span", {}, `Base URL (${p.kind})`), h("input", { type: "text", value: p.baseUrl, onchange: async (e) => { p.baseUrl = e.target.value.trim(); await persistProviders(); renderProviders(); } }))),
      h("div", { class: "keyrow" }, key, h("button", { class: "secondary eye", type: "button", onclick: (e) => { key.type = key.type === "password" ? "text" : "password"; e.target.textContent = key.type === "password" ? "Show" : "Hide"; } }, "Show")),
      h("div", { class: "row" }, h("button", { class: "secondary", type: "button", onclick: async (e) => {
        e.target.textContent = "Testing…";
        try {
          if (p.baseUrl && !/localhost|127\.0\.0\.1/.test(p.baseUrl)) { try { await api.permissions.request({ origins: [originPattern(p.baseUrl)] }); } catch { /* already granted */ } }
          const r = await send({ type: "test-key", id: p.id });
          state = await getState();
          const t = state.providers.find((x) => x.id === p.id);
          if (t && r.models?.length) { t.knownModels = r.models; if (!(t.models || []).length) t.models = r.models.slice(0, 3); await persistProviders(); }
          notify(r.state === "ok" || r.state === "unverified" ? "ok" : "bad", r.message);
        } catch (err) { notify("bad", "Test failed", err.message); }
        renderProviders();
      } }, "Test key and load models")),
      models, custom);
  }));
}

function initSummary() {
  const s = state.settings;
  const num = (id, key) => { $(id).value = s[key]; $(id).addEventListener("change", (e) => patchSettings({ [key]: Number(e.target.value) }).then(() => notify("ok", "Saved"))); };
  num("budget", "budgetTokens"); num("maxout", "maxOutputTokens"); num("fx", "fx");
  $("learning").value = s.learning;
  $("learning").addEventListener("change", (e) => patchSettings({ learning: e.target.value }));
  $("excluded").value = (s.excludedTags || []).join("\n");
  $("excluded").addEventListener("change", (e) => patchSettings({ excludedTags: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) }).then(() => notify("ok", "Saved", "Sync again to apply.")));
  $("extra").value = s.extraInterests || "";
  $("extra").addEventListener("change", (e) => patchSettings({ extraInterests: e.target.value }).then(() => notify("ok", "Saved")));
  $("prices").value = JSON.stringify(s.priceOverrides || {}, null, 1);
  $("prices").addEventListener("change", (e) => { try { patchSettings({ priceOverrides: JSON.parse(e.target.value || "{}") }).then(() => notify("ok", "Saved")); } catch { notify("bad", "That is not valid JSON."); } });
}

function renderUsage() {
  const rows = Object.entries(state.usage || {});
  const days = Object.entries(state.usageDaily || {}).sort().slice(-7).reverse();
  const table = (head, body) => h("table", { class: "usage-table" }, h("tr", {}, head.map((x) => h("th", {}, x))), body);
  $("usage").replaceChildren(...[
    rows.length ? table(["Provider and model", "Runs", "Tokens in", "Tokens out"], rows.map(([k, u]) => h("tr", {}, h("td", {}, k.replace("::", " · ")), h("td", {}, String(u.requests)), h("td", {}, u.input.toLocaleString()), h("td", {}, u.output.toLocaleString())))) : h("p", { class: "status" }, "No model calls yet."),
    days.length ? table(["Day", "Runs", "Tokens in", "Tokens out", "Cost (USD)"], days.map(([d, u]) => h("tr", {}, h("td", {}, d), h("td", {}, String(u.runs)), h("td", {}, u.input.toLocaleString()), h("td", {}, u.output.toLocaleString()), h("td", {}, u.usd ? u.usd.toFixed(4) : "0")))) : null].filter(Boolean));
}

async function init() {
  state = await getState();
  applyTheme(state.settings.theme, state.settings.font);
  initAppearance();
  await checkPermission();
  await initSources();
  await initBlocklist();
  initScoring();
  $("preset").replaceChildren(...PRESETS.map((p, i) => h("option", { value: i }, p.name)));
  $("add-provider").addEventListener("click", async () => { state.providers.push(newProvider(PRESETS[+$("preset").value])); await persistProviders(); renderProviders(); });
  renderProviders();
  initSummary();
  renderUsage();
  await refreshGraph();
}
init();
