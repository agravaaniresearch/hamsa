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
}

// ---- reading ----
const FAMILY = { system: "system-ui, sans-serif", inter: '"Hamsa Inter", sans-serif', "source-sans": '"Hamsa Source Sans", sans-serif', "plex-sans": '"Hamsa Plex Sans", sans-serif', literata: '"Hamsa Literata", serif', "source-serif": '"Hamsa Source Serif", serif', atkinson: '"Hamsa Atkinson", sans-serif', "plex-mono": '"Hamsa Plex Mono", monospace' };
const BOOL = new Set(["justify", "skin", "karma"]);
function initReading() {
  const s = state.settings;
  const sample = () => {
    const el = $("font-sample");
    el.replaceChildren(h("strong", { style: `font-family:${FAMILY[$("titleFont").value]};font-size:17px;display:block;margin-bottom:4px` }, "Why small language models fail quietly on rare clinical terms"),
      h("span", { style: `font-family:${FAMILY[$("font").value]}` }, "Recall dropped on gene symbol aliases, so we added an alias table before ranking and the gap closed. This is the text font at your chosen size."));
    el.style.textAlign = $("justify").value === "on" ? "justify" : "left";
  };
  for (const key of ["font", "titleFont", "textSize", "width", "justify", "density", "darkStyle", "skin", "linkTarget", "karma"]) {
    const el = $(key);
    el.value = BOOL.has(key) ? (s[key] === false || (key === "justify" && !s[key]) ? "off" : "on") : s[key];
    el.addEventListener("change", async () => {
      await patchSettings({ [key]: BOOL.has(key) ? el.value === "on" : el.value });
      state.settings[key] = BOOL.has(key) ? el.value === "on" : el.value;
      sample();
      notify("ok", "Saved", "Open HN tabs update straight away.");
    });
  }
  const PRESETS_FONT = { editorial: ["source-sans", "source-serif"], classic: ["inter", "literata"], modern: ["inter", "inter"], bookish: ["literata", "literata"], easy: ["atkinson", "atkinson"], plex: ["plex-sans", "plex-sans"] };
  $("fontPreset").addEventListener("change", async (e) => {
    const pair = PRESETS_FONT[e.target.value];
    if (!pair) return;
    $("font").value = pair[0]; $("titleFont").value = pair[1];
    await patchSettings({ font: pair[0], titleFont: pair[1] });
    state.settings.font = pair[0]; state.settings.titleFont = pair[1];
    sample();
    notify("ok", "Fonts paired", e.target.selectedOptions[0].textContent);
    e.target.value = "";
  });
  sample();
  initPreviews();
}

// ---- link previews ----
async function initPreviews() {
  const on = $("pv-on"), img = $("pv-img"), st = $("pv-status");
  const ALL = { origins: ["<all_urls>"] };
  const info = async () => {
    const i = await send({ type: "preview-info" }).catch(() => ({}));
    on.checked = !!(i.on && i.allowed);
    img.checked = i.images !== false;
    img.disabled = !on.checked;
    st.textContent = i.on && i.allowed ? `On. ${(i.cached || 0).toLocaleString()} previews saved.` : i.on ? "Waiting for your permission to read linked pages." : "Off.";
  };
  on.addEventListener("change", async () => {
    if (on.checked) {
      // The permission prompt has to come straight from the click.
      const ok = await api.permissions.request(ALL).catch(() => false);
      if (!ok) { on.checked = false; notify("warn", "Previews need permission", "Without it Hamsa cannot read the pages links point to."); return; }
      await patchSettings({ previews: true });
      notify("ok", "Link previews on", "Open a thread on HN to see them.");
    } else {
      await patchSettings({ previews: false });
      notify("ok", "Link previews off");
    }
    await info();
  });
  img.addEventListener("change", async () => { await patchSettings({ previewImages: img.checked }); notify("ok", img.checked ? "Pictures on" : "Text-only previews"); });
  $("pv-clear").addEventListener("click", async () => { await send({ type: "previews-clear" }); await info(); notify("ok", "Saved previews cleared"); });
  await info();
}

async function initReadingLog() {
  const box = $("readingLog");
  box.checked = state.settings.readingLog !== false;
  box.addEventListener("change", async () => { await patchSettings({ readingLog: box.checked }); notify("ok", box.checked ? "Hamsa will remember what you open" : "Reading log paused", box.checked ? "It stays in this browser." : "Nothing new is recorded; what is there stays until you clear it."); });
  const count = async () => {
    const { readingLog = [], impressions = {} } = await api.storage.local.get(["readingLog", "impressions"]);
    $("log-count").textContent = `${readingLog.length.toLocaleString()} opened, ${Object.keys(impressions).length.toLocaleString()} stories seen.`;
  };
  await count();
  $("log-export").addEventListener("click", async () => {
    const r = await send({ type: "export-log" });
    const blob = new Blob([r.jsonl + "\n"], { type: "application/x-ndjson" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `hamsa-reading-${new Date().toISOString().slice(0, 10)}.jsonl` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    notify("ok", `Exported ${r.rows.toLocaleString()} rows`, "One JSON object per line: what Hamsa scored, and what you opened or dismissed.");
  });
  $("log-clear").addEventListener("click", async () => { await send({ type: "log-clear" }); await count(); notify("ok", "Reading log cleared"); });
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
    if (!$(`sc-${k}`)) continue;
    const box = $(`sc-${k}`).type === "checkbox";
    if (box) $(`sc-${k}`).checked = !!sc[k]; else $(`sc-${k}`).value = sc[k];
    $(`sc-${k}`).addEventListener("change", async (e) => {
      const { settings = {} } = await api.storage.local.get("settings");
      const v = box ? e.target.checked : Number(e.target.value);
      if (!box && !Number.isFinite(v)) return;
      await patchSettings({ scoring: { ...SCORING_DEFAULTS, ...(settings.scoring || {}), [k]: v } });
      notify("ok", "Scoring saved", "Applies from the next HN page you open.");
    });
  }
  $("gate").value = state.settings.gate === false ? "off" : "on";
  $("gate").addEventListener("change", (e) => patchSettings({ gate: e.target.value === "on" }));
  $("sc-reset").addEventListener("click", async () => {
    await patchSettings({ scoring: { ...SCORING_DEFAULTS } });
    for (const k of keys) if ($(`sc-${k}`)) { if ($(`sc-${k}`).type === "checkbox") $(`sc-${k}`).checked = !!SCORING_DEFAULTS[k]; else $(`sc-${k}`).value = SCORING_DEFAULTS[k]; }
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

// ---- hero status and checklist ----
async function drawStatus() {
  const [info, sync, { prefs }, perm] = await Promise.all([
    send({ type: "graph-info" }).catch(() => ({ ready: false })),
    send({ type: "sync-info" }).catch(() => ({})),
    api.storage.local.get("prefs"),
    api.permissions.contains({ origins: [HN_ORIGIN] }),
  ]);
  state = await getState();
  const usable = state.providers.filter((p) => p.keyStatus && (p.keyStatus.state === "ok" || p.keyStatus.state === "unverified"));
  const likes = Object.values(prefs?.items || {});
  const set = (id, on, text, warn) => { const el = $(id); el.className = `stat${on ? " on" : warn ? " warn" : ""}`; el.lastChild.textContent = text; };
  set("st-interests", info.ready, info.ready ? `Interests: ${info.tags.toLocaleString()} topics` : "Interests: not synced yet", !info.ready);
  set("st-model", usable.length, usable.length ? `AI: ${usable[0].name}` : "AI summaries: off");
  const syncOn = state.settings.syncFirefox || sync.gist?.id;
  set("st-sync", syncOn, state.settings.syncFirefox && sync.gist?.id ? "Sync: Firefox and GitHub" : state.settings.syncFirefox ? "Sync: Firefox" : sync.gist?.id ? "Sync: GitHub" : "Sync: off");
  set("st-likes", likes.length, `${likes.filter((x) => x.v === "like").length} likes · ${likes.filter((x) => x.v === "dislike").length} dislikes`);
  const done = (id, ok) => $(id).classList.toggle("done", !!ok);
  done("ck-perm", perm); done("ck-src", info.ready); done("ck-ai", usable.length); done("ck-sync", syncOn || sync.backupAt);
}

// Highlight the section in view.
function initNav() {
  const links = new Map([...document.querySelectorAll(".nav a")].map((a) => [a.getAttribute("href").slice(1), a]));
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { for (const a of links.values()) a.classList.remove("on"); links.get(e.target.id)?.classList.add("on"); }
  }, { rootMargin: "-30% 0px -60% 0px" });
  for (const id of links.keys()) { const el = document.getElementById(id); if (el) io.observe(el); }
  if (/^#s-[a-z]+$/.test(location.hash)) setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" }), 50);
}

// ---- likes and dislikes ----
async function drawLikes() {
  const { prefs } = await api.storage.local.get("prefs");
  const items = Object.entries(prefs?.items || {}).sort((a, b) => b[1].at - a[1].at);
  const nl = items.filter(([, x]) => x.v === "like").length, nd = items.length - nl;
  $("likes-count").textContent = items.length ? `${nl} liked, ${nd} disliked${items.some(([, x]) => x.source === "hn") ? `, ${items.filter(([, x]) => x.source === "hn").length} of them read from your HN votes` : ""}.` : "None yet. Use the thumbs on any story or comment.";
  $("likes-list").replaceChildren(...items.slice(0, 80).map(([id, x]) => h("div", { class: "like-row" },
    h("span", { class: `pill ${x.v}` }, x.v === "like" ? "LIKE" : "DISLIKE"),
    h("a", { class: "lt", href: `https://news.ycombinator.com/item?id=${id}`, target: "_blank", rel: "noopener noreferrer", title: x.title }, x.title || `${x.kind} ${id}`),
    h("span", { class: "status" }, x.source === "hn" ? "from HN" : x.kind),
    h("button", { type: "button", title: "Forget this", "aria-label": "Forget this", onclick: async () => { await send({ type: "pref", item: { id, kind: x.kind }, value: null }); drawLikes(); drawStatus(); } }, "×"))));
  $("likes-clear").onclick = async () => { await send({ type: "prefs-clear" }); notify("ok", "Likes and dislikes cleared"); drawLikes(); drawStatus(); };
}

// ---- backup and sync ----
function download(name, text, type = "application/json") {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function initBackupSync() {
  $("bk-export").addEventListener("click", async () => {
    const r = await send({ type: "backup-export", includeKeys: $("bk-keys").checked, includeLog: $("bk-log").checked });
    download(`hamsa-backup-${new Date().toISOString().slice(0, 10)}.json`, r.json);
    await api.storage.local.set({ syncInfo: { ...((await api.storage.local.get("syncInfo")).syncInfo || {}), backupAt: Date.now() } });
    notify("ok", "Backup downloaded", `${(r.size / 1024).toFixed(0)} KB, format hamsa.backup/1.${$("bk-keys").checked ? " It contains your keys: keep it private." : " Keys are not included."}`);
    drawStatus();
  });
  $("bk-import").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const r = await send({ type: "backup-import", json: await f.text() });
      notify("ok", "Backup restored", `Merged ${r.merged.length} kinds of data from Hamsa ${r.from || "?"}. Nothing here was thrown away.`);
      setTimeout(() => location.reload(), 1200);
    } catch (err) { notify("bad", "Could not restore", err.message); }
    e.target.value = "";
  });

  const ff = $("sync-firefox");
  ff.checked = !!state.settings.syncFirefox;
  const ffStatus = async () => {
    const i = await send({ type: "sync-info" }).catch(() => ({}));
    $("sync-firefox-status").textContent = i.firefoxPushedAt ? `Last sent ${new Date(i.firefoxPushedAt).toLocaleString()} (${((i.firefoxBytes || 0) / 1024).toFixed(0)} KB of about 100 KB allowed).` : state.settings.syncFirefox ? "On. Nothing sent yet." : "Off.";
    const g = i.gist || {};
    $("gist-status").textContent = g.id ? `Gist ${g.id.slice(0, 8)}…${g.pushedAt ? ` · pushed ${new Date(g.pushedAt).toLocaleString()}` : ""}${g.pulledAt ? ` · pulled ${new Date(g.pulledAt).toLocaleString()}` : ""}` : "Not set up.";
    if (g.id && !$("gist-id").value) $("gist-id").value = g.id;
    $("gist-auto").checked = !!g.auto; $("gist-keys").checked = !!g.includeKeys;
    if (g.hasToken && !$("gist-token").value) $("gist-token").placeholder = "Token saved (hidden)";
  };
  ff.addEventListener("change", async () => {
    await patchSettings({ syncFirefox: ff.checked });
    state.settings.syncFirefox = ff.checked;
    if (ff.checked) { try { await send({ type: "sync-firefox-now" }); notify("ok", "Firefox Sync is on", "Settings, likes and blocklist now follow you to every Firefox where you are signed in."); } catch (e) { notify("bad", "Firefox Sync failed", e.message); } }
    ffStatus(); drawStatus();
  });
  $("sync-firefox-now").addEventListener("click", async () => {
    try { await send({ type: "sync-firefox-now" }); notify("ok", "Synced with Firefox"); } catch (e) { notify("bad", "Sync failed", e.message); }
    ffStatus();
  });

  const gcfg = (patch) => send({ type: "gist-config", patch });
  $("gist-eye").addEventListener("click", () => { const i = $("gist-token"); i.type = i.type === "password" ? "text" : "password"; $("gist-eye").textContent = i.type === "password" ? "Show" : "Hide"; });
  $("gist-token").addEventListener("change", (e) => gcfg({ token: e.target.value.trim() }));
  $("gist-id").addEventListener("change", (e) => gcfg({ id: e.target.value.trim().replace(/^.*\//, "") || undefined }));
  $("gist-auto").addEventListener("change", (e) => gcfg({ auto: e.target.checked }));
  $("gist-keys").addEventListener("change", (e) => gcfg({ includeKeys: e.target.checked }));
  const askGithub = () => api.permissions.request({ origins: ["https://api.github.com/*", "https://gist.githubusercontent.com/*"] }).catch(() => false);
  $("gist-push").addEventListener("click", async (e) => {
    if (!(await askGithub())) return notify("warn", "Permission not given", "Hamsa needs to reach api.github.com to use a gist.");
    e.target.disabled = true;
    try { const r = await send({ type: "gist-push" }); notify("ok", "Pushed to GitHub", `Private gist ${r.id.slice(0, 8)}…, ${(r.bytes / 1024).toFixed(0)} KB.`); } catch (err) { notify("bad", "Push failed", err.message); }
    e.target.disabled = false; ffStatus(); drawStatus();
  });
  $("gist-pull").addEventListener("click", async (e) => {
    if (!(await askGithub())) return notify("warn", "Permission not given", "Hamsa needs to reach api.github.com to use a gist.");
    e.target.disabled = true;
    try { const r = await send({ type: "gist-pull" }); notify("ok", "Pulled from GitHub", `Merged ${r.merged.length} kinds of data.`); setTimeout(() => location.reload(), 1200); } catch (err) { notify("bad", "Pull failed", err.message); }
    e.target.disabled = false;
  });
  await ffStatus();
}

async function renderErrors() {
  const { errors = [] } = await api.storage.local.get("errors");
  $("errors").replaceChildren(errors.length
    ? h("ul", { class: "hits" }, errors.map((e) => h("li", {}, `${new Date(e.at).toLocaleString()} · ${e.where} · v${e.version || "?"}: ${e.message}`)))
    : h("p", { class: "status" }, "None."));
  $("err-copy").onclick = async () => { await navigator.clipboard.writeText(errors.map((e) => `${new Date(e.at).toISOString()} ${e.where} v${e.version}: ${e.message}`).join("\n") || "None"); notify("ok", "Copied"); };
  $("err-clear").onclick = async () => { await send({ type: "errors-clear" }); renderErrors(); };
}

async function init() {
  state = await getState();
  applyTheme(state.settings.theme, state.settings.font);
  initAppearance();
  initReading();
  await initReadingLog();
  await checkPermission();
  await initSources();
  await initBlocklist();
  initScoring();
  $("preset").replaceChildren(...PRESETS.map((p, i) => h("option", { value: i }, p.name)));
  $("add-provider").addEventListener("click", async () => { state.providers.push(newProvider(PRESETS[+$("preset").value])); await persistProviders(); renderProviders(); });
  renderProviders();
  initSummary();
  renderUsage();
  await renderErrors();
  await refreshGraph();
  await drawLikes();
  await initBackupSync();
  $("version").textContent = api.runtime.getManifest().version;
  initNav();
  await drawStatus();
}
init();
