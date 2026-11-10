// Shared helpers for Hamsa's in-page layer on Hacker News (front page and thread pages).
// Classic script: content scripts cannot import modules, so this file sets globalThis.HamsaUI.
// All text goes through textContent and every element is built with the DOM API, so nothing from
// a page, a story or a model can inject markup.
(() => {
  if (globalThis.HamsaUI) return;
  const api = globalThis.browser ?? globalThis.chrome;
  const SVGNS = "http://www.w3.org/2000/svg";

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.setAttribute("style", v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "value") el.value = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  // replaceChildren with the same flattening and null-skipping as h(), so arrays and empty slots are safe.
  function fill(el, ...kids) {
    el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false).map((k) => (k.nodeType ? k : document.createTextNode(String(k)))));
    return el;
  }

  // Inline stroke icons, built as SVG elements (Parshva's set for the theme button).
  const ICONS = {
    auto: [["circle", { cx: 12, cy: 12, r: 8 }], ["path", { d: "M12 4v16" }], ["path", { d: "M12 4a8 8 0 0 1 0 16z", fill: "currentColor" }]],
    light: [["circle", { cx: 12, cy: 12, r: 4 }], ["path", { d: "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" }]],
    dark: [["path", { d: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" }]],
    settings: [["path", { d: "M4 8h9M17 8h3M4 16h3M11 16h9" }], ["circle", { cx: 15, cy: 8, r: 2 }], ["circle", { cx: 9, cy: 16, r: 2 }]],
    original: [["path", { d: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" }], ["circle", { cx: 12, cy: 12, r: 3 }]],
    digest: [["path", { d: "M5 4h14v16H5z" }], ["path", { d: "M8 8h8M8 12h8M8 16h5" }]],
    up: [["path", { d: "M12 6l6 9H6z", fill: "currentColor", stroke: "none" }]],
    bg: [["rect", { x: 3, y: 7, width: 13, height: 13, rx: 2 }], ["path", { d: "M8 3h13v13" }], ["path", { d: "M14 10l7-7" }]],
    like: [["path", { d: "M7 11v9H4v-9zM7 11l4-7c1.3 0 2.3 1 2 2.4L12.4 10H18a2 2 0 0 1 2 2.4l-1.3 6A2 2 0 0 1 16.7 20H7" }]],
    dislike: [["path", { d: "M7 11v9H4v-9zM7 11l4-7c1.3 0 2.3 1 2 2.4L12.4 10H18a2 2 0 0 1 2 2.4l-1.3 6A2 2 0 0 1 16.7 20H7", transform: "rotate(180 12 12)" }]],
    compass: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M15.5 8.5l-2 5-5 2 2-5z", fill: "currentColor" }]],
  };
  function icon(name, size = 18) {
    const s = document.createElementNS(SVGNS, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) s.setAttribute(k, String(v));
    for (const [tag, attrs] of ICONS[name] || []) {
      const e = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      s.append(e);
    }
    return s;
  }

  // Retries while the background page is still starting (the usual first-load failure after an
  // install or a browser start). An error reported by a handler is not retried.
  async function send(msg, tries = 5) {
    for (let i = 0; ; i++) {
      let r;
      try {
        r = await api.runtime.sendMessage(msg);
      } catch (e) {
        if (i >= tries - 1) { logError(msg.type, e); throw new Error(`Hamsa's background page did not answer (${e.message}).`); }
        await new Promise((ok) => setTimeout(ok, 250 * (i + 1)));
        continue;
      }
      if (r === undefined && i < tries - 1) { await new Promise((ok) => setTimeout(ok, 250 * (i + 1))); continue; }
      if (r?.error) throw new Error(r.error);
      return r;
    }
  }
  function logError(where, e) {
    try { api.runtime.sendMessage({ type: "log-error", where, message: String(e?.message || e) }).catch(() => {}); } catch { /* nothing to report to */ }
  }

  // A visible failure with a way out, instead of a half-drawn page.
  function fail(message, where) {
    logError(where || "page", message);
    const root = mount();
    root.replaceChildren(h("div", { class: "h-wrap" }, h("main", { class: "h-main" },
      h("div", { class: "h-err" }, `Hamsa could not load this page: ${message}`),
      h("div", { class: "h-row" },
        h("button", { class: "h-btn primary", type: "button", onclick: () => location.reload() }, "Try again"),
        h("button", { class: "h-btn", type: "button", onclick: release }, "Show plain HN")),
      h("p", { class: "h-note" }, "The error is also listed in Hamsa settings, under Recent problems."))));
  }

  // ---- theme: Auto -> Light -> Dark, as in Parshva ----
  const THEME_NEXT = { auto: "light", light: "dark", dark: "auto" };
  const THEME_LABEL = { auto: "Auto (follows your system)", light: "Light", dark: "Dark" };
  // Theme and reading options live in boot.js (it runs first on every HN page); this passes changes on.
  function applyTheme(theme, font) {
    const T = globalThis.HamsaTheme;
    if (T) return T.apply({ ...T.current(), theme, ...(font ? { font } : {}) });
    const root = document.documentElement;
    if (theme === "light" || theme === "dark") root.setAttribute("data-hamsa-theme", theme); else root.removeAttribute("data-hamsa-theme");
  }

  // ---- layer on / off ----
  function release() {
    document.documentElement.classList.remove("hamsa-pending", "hamsa-on");
  }
  function showOriginal() {
    document.documentElement.classList.remove("hamsa-on");
    if (!document.getElementById("hamsa-back")) {
      const b = h("button", { id: "hamsa-back", type: "button", title: "Back to the Hamsa view" }, "Hamsa view");
      b.addEventListener("click", () => { document.documentElement.classList.add("hamsa-on"); b.remove(); window.scrollTo(0, 0); });
      document.body.append(b);
    }
    window.scrollTo(0, 0);
  }
  function mount() {
    let root = document.getElementById("hamsa-root");
    if (!root) {
      root = h("div", { id: "hamsa-root" });
      // HN's own page script inspects every click (and fails on SVG icons); clicks inside Hamsa are ours.
      root.addEventListener("click", (e) => e.stopPropagation());
      document.body.prepend(root);
    }
    document.documentElement.classList.add("hamsa-on");
    document.documentElement.classList.remove("hamsa-pending");
    return root;
  }

  const fmtNum = (n) => (n == null ? "0" : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString());
  function usageText(u) {
    if (!u || !u.runs) return "Today: 0 tokens";
    const usd = u.usd ? ` · $${u.usd < 0.01 ? u.usd.toFixed(3) : u.usd.toFixed(2)}` : "";
    return `Today: ${fmtNum(u.input)} in · ${fmtNum(u.output)} out${usd}`;
  }

  // Header bar with HN's own navigation, today's model usage, theme, settings and "Original".
  function header(ui, { active } = {}) {
    const here = location.pathname.replace(/^\//, "") || "news";
    const nav = [["news", "top"], ["newest", "new"], ["front", "past"], ["newcomments", "comments"], ["ask", "ask"], ["show", "show"], ["jobs", "jobs"], ["submit", "submit"]];
    const themeBtn = h("button", { class: "h-icon", type: "button" });
    const drawTheme = () => {
      themeBtn.replaceChildren(icon(ui.theme || "auto"));
      themeBtn.title = `Theme: ${THEME_LABEL[ui.theme || "auto"]}. Click to change.`;
      themeBtn.setAttribute("aria-label", themeBtn.title);
    };
    themeBtn.addEventListener("click", async () => {
      ui.theme = THEME_NEXT[ui.theme || "auto"];
      applyTheme(ui.theme, ui.font);
      drawTheme();
      toast(`Theme: ${THEME_LABEL[ui.theme]}`);
      await send({ type: "set-ui", patch: { theme: ui.theme } }).catch(() => {});
    });
    drawTheme();
    const pill = h("span", { class: "h-pill", id: "hamsa-usage", title: "Tokens your keys used today, across all threads" }, usageText(ui.usage));
    const me = document.querySelector("a#me");
    const login = document.querySelector('.pagetop a[href^="login"]');
    return h("header", { class: "h-top" },
      h("a", { class: "h-brand", href: "news", title: "Hamsa front page" }, h("img", { src: api.runtime.getURL("icons/icon-48.png"), alt: "" }), "Hamsa"),
      h("nav", { class: "h-nav", "aria-label": "Hacker News" }, nav.map(([p, label]) => h("a", { href: p, class: (active || here) === p ? "on" : null }, label))),
      h("span", { class: "h-grow" }),
      pill,
      me ? h("a", { class: "h-user", href: `user?id=${encodeURIComponent(me.textContent)}` }, me.textContent) : login ? h("a", { class: "h-user", href: login.getAttribute("href") }, "login") : null,
      h("button", { class: "h-icon", type: "button", title: "Daily digest", "aria-label": "Daily digest", onclick: () => send({ type: "open-digest" }) }, icon("digest")),
      themeBtn,
      h("button", { class: "h-icon", type: "button", title: "Show the original Hacker News page", "aria-label": "Show the original Hacker News page", onclick: showOriginal }, icon("original")),
      h("button", { class: "h-icon", type: "button", title: "Hamsa settings", "aria-label": "Hamsa settings", onclick: () => send({ type: "open-settings" }) }, icon("settings")));
  }
  function setUsage(u) {
    const el = document.getElementById("hamsa-usage");
    if (el) el.textContent = usageText(u);
  }

  let toastTimer = null;
  function toast(text) {
    let t = document.querySelector("#hamsa-root .h-toast");
    if (!t) { t = h("div", { class: "h-toast", role: "status" }); document.getElementById("hamsa-root")?.append(t); }
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ---- score pieces ----
  const BUCKET_LABEL = { keep: "KEEP", maybe: "MAYBE", stretch: "DISCOVER", toss: "TOSS", removed: "REMOVED" };
  const badge = (bucket, score) => h("span", { class: `h-badge ${bucket}` }, score != null && bucket !== "removed" ? `${score.toFixed(2)} · ${BUCKET_LABEL[bucket]}` : BUCKET_LABEL[bucket]);
  function bar(bucket, score) {
    const b = h("span", { class: `h-bar ${bucket}`, role: "img", "aria-label": `Relevance ${score.toFixed(2)} of 1` }, h("i"));
    b.firstChild.style.width = `${Math.round(Math.max(0.02, Math.min(1, score)) * 100)}%`;
    return b;
  }
  // The full reasoning: each signal with its points, the total and how it became 0 to 1.
  function whyPanel(v, scoring) {
    const sign = (p) => (p > 0 ? `+${p.toFixed(2)}` : p < 0 ? p.toFixed(2) : "");
    return h("div", { class: "h-why" },
      h("div", { class: "h-label" }, "Why this score"),
      v.reasons.length ? v.reasons.map((r) => h("div", { class: "h-kv" }, h("span", {}, r.label), h("span", { class: r.points < 0 ? "neg" : "" }, sign(r.points)))) : h("div", { class: "h-note" }, "No signal matched."),
      h("div", { class: "h-sep" }),
      h("div", { class: "h-kv" }, h("span", {}, `Total ${(v.total ?? 0).toFixed(2)}, scaled to 0 to 1 with ceiling ${scoring?.ceiling ?? 0.9} (provisional)`), h("span", {}, (v.score ?? 0).toFixed(2))),
      h("div", { class: "h-note" }, `Bucket: ${v.bucket === "stretch" ? "discover" : v.bucket}${v.rule ? ` (${v.rule.replace(/_/g, " ")})` : ""} · scoring rules v${v.rules || "?"} · keep at ${scoring?.keepAt ?? 0.55}, maybe at ${scoring?.maybeAt ?? 0.2}`));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Fetch further HN pages from the page itself, so your login (and vote links) carry over.
  async function fetchMore(startHref, max, onPage) {
    const pages = [];
    let href = startHref;
    for (let i = 0; i < max && href; i++) {
      await sleep(i ? 700 : 300);
      const url = new URL(href, location.href).href;
      let res = await fetch(url, { credentials: "include" });
      // HN answers 503 when pages are requested too quickly; wait and try that page once more.
      if (res.status === 503) { await sleep(2500); res = await fetch(url, { credentials: "include" }); }
      if (!res.ok) break;
      const html = await res.text();
      pages.push(html);
      const doc = new DOMParser().parseFromString(html, "text/html");
      if (onPage) onPage(doc, i);
      href = doc.querySelector("a.morelink")?.getAttribute("href") || null;
    }
    return pages;
  }

  // Theme or layer changed in settings or another tab.
  function watch(ui, onChange) {
    api.storage.onChanged.addListener((ch) => {
      if (!ch.settings) return;
      const s = ch.settings.newValue || {};
      ui.theme = s.theme;
      if (onChange) onChange(s);
    });
  }

  // ---- links: where they open, and what gets remembered ----
  // entry: { kind: story|thread|link, id, title, url, domain, tags, score, bucket, page }
  function track(a, entry, ui) {
    const log = (background) => send({ type: "opened", entry: { ...entry, url: entry.url || a.href, background } }, 2).catch(() => {});
    a.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      const modified = e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
      const target = ui?.linkTarget || "same";
      if (!modified && target !== "same" && /^https?:/i.test(a.href)) {
        e.preventDefault();
        openTab(a.href, target === "new", entry);
        return;
      }
      log(modified);
    });
    a.addEventListener("auxclick", (e) => { if (e.button === 1) log(true); });
    return a;
  }
  function openTab(url, active, entry) {
    return send({ type: "open-tab", url, active: !!active, entry }).then(() => { if (!active) toast("Opened in a background tab"); }).catch((e) => toast(e.message));
  }

  // Like / dislike: kept in this browser, used straight away in scoring.
  function thumbs(item, state, onChange) {
    const btns = [];
    const mk = (val, label) => {
      const b = h("button", { class: `h-ibtn ${val}`, type: "button", title: label, "aria-label": label, "aria-pressed": String(state.pref === val) }, icon(val, 16));
      b.addEventListener("click", async () => {
        const next = state.pref === val ? null : val;
        try {
          await send({ type: "pref", item, value: next });
          state.pref = next;
          for (const x of btns) x.setAttribute("aria-pressed", String(x.dataset.val === next));
          toast(next === "like" ? "Liked: more like this" : next === "dislike" ? "Disliked: less like this" : "Cleared");
          onChange?.(next);
        } catch (e) { toast(e.message); }
      });
      b.dataset.val = val;
      btns.push(b);
      return b;
    };
    return [mk("like", "Like: more like this"), mk("dislike", "Dislike: less like this")];
  }

  // ---- link previews: a card for a link, fetched by the background page when it scrolls near ----
  const linkId = (url) => "link:" + String(url).replace(/#.*$/, "").replace(/\/$/, "");
  const pv = { queue: [], busy: 0, blocked: false, off: false, io: null, ctx: {} };
  function pvObserver() {
    if (pv.io || typeof IntersectionObserver === "undefined") return pv.io;
    pv.io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { pv.io.unobserve(e.target); pv.queue.push(e.target); }
      pvPump();
    }, { rootMargin: "600px 0px" });
    return pv.io;
  }
  function pvPump() {
    while (pv.busy < 4 && pv.queue.length) {
      const batch = pv.queue.splice(0, 4);
      pv.busy++;
      send({ type: "previews", urls: batch.map((el) => el.dataset.url) }, 1).then((r) => {
        if (r.needPermission) { pv.blocked = true; for (const el of [...batch, ...pv.queue]) el.remove(); pv.queue = []; document.dispatchEvent(new CustomEvent("hamsa-previews-blocked")); return; }
        if (r.off) { pv.off = true; for (const el of [...batch, ...pv.queue]) el.remove(); pv.queue = []; return; }
        for (const el of batch) drawPreview(el, r.previews?.[el.dataset.url]);
      }).catch(() => { for (const el of batch) el.remove(); }).finally(() => { pv.busy--; pvPump(); });
    }
  }
  function previewSlot(url, ctx = {}) {
    if (pv.blocked || pv.off || !/^https?:/i.test(url || "")) return null;
    const el = h("div", { class: "h-pv loading", "data-url": url, "aria-busy": "true" }, h("div", { class: "h-pv-skel" }));
    el._ctx = ctx;
    const io = pvObserver();
    if (io) io.observe(el); else { pv.queue.push(el); pvPump(); }
    return el;
  }
  function drawPreview(el, p) {
    if (!p || p.error || p.skip || (!p.title && !p.description && !p.image)) { el.remove(); return; }
    const ctx = el._ctx || {};
    const url = el.dataset.url;
    const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
    const date = p.published ? (() => { const d = new Date(p.published); return isNaN(d) ? null : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); })() : null;
    const KIND = { pdf: "PDF", paper: "Paper", video: "Video", image: "Image" };
    const titleA = h("a", { class: "h-pv-title", href: url, rel: "noopener noreferrer" }, p.title || host);
    if (ctx.ui) track(titleA, { kind: "link", url, title: p.title || ctx.title || url, domain: host, page: ctx.page || "thread" }, ctx.ui);
    const img = p.image ? h("img", { class: "h-pv-img", src: p.image, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" }) : null;
    img?.addEventListener("error", () => { el.querySelector(".h-pv-media")?.remove(); el.classList.remove("has-img"); });
    const fav = p.icon ? h("img", { class: "h-pv-ico", src: p.icon, alt: "", width: "14", height: "14", referrerpolicy: "no-referrer" }) : null;
    fav?.addEventListener("error", () => fav.remove());
    const item = { id: linkId(url), kind: "link", title: p.title || ctx.title || url, url, domain: host, site: p.site, threadId: ctx.threadId, threadTitle: ctx.threadTitle, excerpt: p.description, author: ctx.author };
    const state = { pref: p.pref || null };
    el.classList.remove("loading");
    el.removeAttribute("aria-busy");
    if (img) el.classList.add("has-img");
    el.replaceChildren(...[
      img ? h("a", { class: "h-pv-media", href: url, rel: "noopener noreferrer", tabindex: "-1", "aria-hidden": "true" }, img) : null,
      h("div", { class: "h-pv-body" },
        h("div", { class: "h-pv-site" }, fav, h("span", {}, p.site || host), KIND[p.kind] ? h("span", { class: "h-pv-kind" }, KIND[p.kind]) : null, date ? h("span", {}, `· ${date}`) : null, p.author ? h("span", {}, `· ${p.author}`) : null),
        titleA,
        p.description ? h("p", { class: "h-pv-desc" }, p.description) : null),
      h("div", { class: "h-pv-act" }, thumbs(item, state))].filter(Boolean));
  }

  globalThis.HamsaUI = { api, h, fill, icon, send, fail, logError, track, openTab, thumbs, previewSlot, linkId, pv, applyTheme, release, mount, showOriginal, header, setUsage, toast, badge, bar, whyPanel, fetchMore, watch, usageText, fmtNum, sleep, BUCKET_LABEL };
})();
