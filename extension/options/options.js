import { api, getState, save, patchSettings, newProvider, PRESETS, applyTheme } from "../lib/store.js";
import { keySig, originPattern } from "../lib/providers.js";

const $ = (s) => document.querySelector(s);
let state;
const flash = (t) => { $("#saved").textContent = t; setTimeout(() => { if ($("#saved").textContent === t) $("#saved").textContent = ""; }, 2500); };
const send = async (msg) => { const r = await api.runtime.sendMessage(msg); if (r?.error) throw new Error(r.error); return r; };

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}

async function persistProviders() { await save({ providers: state.providers }); }

function renderProviders() {
  const box = $("#providers");
  box.replaceChildren(...state.providers.map((p) => {
    const ks = p.keyStatus && p.keyStatus.sig === keySig(p) ? p.keyStatus : null;
    const status = h("span", { class: `status ${ks ? (ks.state === "ok" || ks.state === "unverified" ? "ok" : "bad") : ""}` }, ks ? ks.message : "Not tested");
    const models = h("div", { class: "models" }, (p.knownModels || p.models || []).slice(0, 80).map((m) =>
      h("label", {}, h("input", { type: "checkbox", checked: (p.models || []).includes(m), onchange: async (e) => { p.models = e.target.checked ? [...new Set([...(p.models || []), m])] : (p.models || []).filter((x) => x !== m); await persistProviders(); } }), m)));
    const custom = h("input", { placeholder: "Add a model id by hand", onkeydown: async (e) => { if (e.key === "Enter" && e.target.value.trim()) { const m = e.target.value.trim(); p.knownModels = [...new Set([...(p.knownModels || []), m])]; p.models = [...new Set([...(p.models || []), m])]; await persistProviders(); renderProviders(); } } });
    return h("div", { class: "prov" },
      h("div", { class: "head" }, h("strong", {}, p.name), status, h("button", { class: "btn danger", onclick: async () => { state.providers = state.providers.filter((x) => x.id !== p.id); await persistProviders(); renderProviders(); } }, "Remove")),
      h("div", { class: "grid" },
        h("label", {}, "Name", h("input", { value: p.name, onchange: async (e) => { p.name = e.target.value; await persistProviders(); } })),
        h("label", {}, `Base URL (${p.kind})`, h("input", { value: p.baseUrl, onchange: async (e) => { p.baseUrl = e.target.value.trim(); await persistProviders(); renderProviders(); } })),
        h("label", {}, "API key", h("input", { type: "password", value: p.apiKey || "", autocomplete: "off", spellcheck: "false", onchange: async (e) => { p.apiKey = e.target.value.trim(); await persistProviders(); renderProviders(); } }))),
      h("div", { class: "row" }, h("button", { class: "btn", onclick: async (e) => {
        e.target.textContent = "Testing…";
        try {
          if (p.baseUrl && !/localhost|127\.0\.0\.1/.test(p.baseUrl)) { try { await api.permissions.request({ origins: [originPattern(p.baseUrl)] }); } catch { /* ignore */ } }
          const r = await send({ type: "test-key", id: p.id });
          state = await getState();
          const t = state.providers.find((x) => x.id === p.id);
          if (t && r.models?.length) { t.knownModels = r.models; if (!(t.models || []).length) t.models = r.models.slice(0, 3); await persistProviders(); }
        } catch (err) { flash(err.message); }
        renderProviders();
      } }, "Test key and load models")),
      models, h("div", { class: "row" }, custom));
  }));
}

function renderTags(info) {
  const box = $("#top-tags");
  if (!info.ready) { box.replaceChildren(h("span", { class: "hint" }, "No graph yet. Add your token and sync.")); return; }
  box.replaceChildren(...info.top.map((t) => {
    const b = h("button", { class: "tg", "data-s": info.muted.includes(t.tag) ? "2" : t.adj > 0 ? "1" : "0", title: `${t.count} bookmarks` }, t.tag);
    b.addEventListener("click", async () => {
      const s = (+b.dataset.s + 1) % 3;
      b.dataset.s = String(s);
      await send({ type: "feedback", kind: "tag", tag: t.tag, action: ["reset", "boost", "mute"][s] }).catch((e) => flash(e.message));
    });
    return b;
  }));
}

async function refreshGraph() {
  const info = await send({ type: "graph-info" });
  $("#rd-status").textContent = info.ready ? `${info.items.toLocaleString()} bookmarks, ${info.tags.toLocaleString()} tags${info.syncedAt ? `, synced ${new Date(info.syncedAt).toLocaleString()}` : ""}.` : "Not synced yet.";
  renderTags(info);
}

function renderUsage() {
  const rows = Object.entries(state.usage || {});
  $("#usage").replaceChildren(...(rows.length ? rows.map(([k, u]) => h("div", {}, `${k.replace("::", " / ")}: ${u.requests} runs, ${u.input.toLocaleString()} in, ${u.output.toLocaleString()} out`)) : ["No runs yet."]));
}

async function init() {
  state = await getState();
  applyTheme(state.settings.theme, state.settings.font);
  $("#preset").replaceChildren(...PRESETS.map((p, i) => h("option", { value: i }, p.name)));
  $("#add-provider").addEventListener("click", async () => { state.providers.push(newProvider(PRESETS[+$("#preset").value])); await persistProviders(); renderProviders(); });
  renderProviders();

  $("#rd-token").value = state.raindropToken || "";
  $("#rd-save").addEventListener("click", async () => { await save({ raindropToken: $("#rd-token").value.trim() }); flash("Token saved."); });
  $("#rd-sync").addEventListener("click", async (e) => {
    await save({ raindropToken: $("#rd-token").value.trim() });
    e.target.disabled = true; e.target.textContent = "Syncing…";
    try { await send({ type: "sync" }); flash("Synced."); await refreshGraph(); } catch (err) { flash(err.message); }
    e.target.disabled = false; e.target.textContent = "Sync tags";
  });
  api.runtime.onMessage.addListener((m) => { if (m?.type === "sync-progress") $("#rd-status").textContent = `Reading bookmarks… ${m.n.toLocaleString()}`; });

  const s = state.settings;
  $("#excluded").value = (s.excludedTags || []).join("\n");
  $("#excluded").addEventListener("change", (e) => patchSettings({ excludedTags: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) }).then(() => flash("Saved. Resync to apply.")));
  $("#extra").value = s.extraInterests || "";
  $("#extra").addEventListener("change", (e) => patchSettings({ extraInterests: e.target.value }).then(() => flash("Saved.")));
  const num = (id, key) => { $(id).value = s[key]; $(id).addEventListener("change", (e) => patchSettings({ [key]: Number(e.target.value) }).then(() => flash("Saved."))); };
  num("#budget", "budgetTokens"); num("#maxout", "maxOutputTokens"); num("#fx", "fx");
  $("#prices").value = JSON.stringify(s.priceOverrides || {}, null, 1);
  $("#prices").addEventListener("change", (e) => { try { patchSettings({ priceOverrides: JSON.parse(e.target.value || "{}") }).then(() => flash("Saved.")); } catch { flash("That is not valid JSON."); } });
  for (const [id, key] of [["#learning", "learning"], ["#theme", "theme"], ["#font", "font"]]) {
    $(id).value = s[key];
    $(id).addEventListener("change", async (e) => { await patchSettings({ [key]: e.target.value }); state = await getState(); applyTheme(state.settings.theme, state.settings.font); flash("Saved."); });
  }
  renderUsage();
  await refreshGraph();
}
init();
