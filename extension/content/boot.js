// Runs at document_start on every HN page. Applies theme, fonts and reading options before first paint,
// themes the pages Hamsa does not redraw (the skin), and hides the pages it does redraw until the
// layer has drawn. If the layer is off, or anything fails, HN shows as normal.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const root = document.documentElement;
  const path = location.pathname;
  const layerPage = /^\/(|news|front|newest|best\w*|ask\w*|show\w*|item)$/.test(path);
  if (layerPage) root.classList.add("hamsa-pending");
  const fallback = setTimeout(() => root.classList.remove("hamsa-pending"), 8000);
  const media = matchMedia("(prefers-color-scheme: dark)");
  let last = {};

  // Bundled fonts, loaded only when a bundled family is chosen.
  const FONTS = [["Hamsa Inter", "inter-latin-400-normal", "inter-latin-600-normal"], ["Hamsa Literata", "literata-latin-400-normal", "literata-latin-600-normal"],
    ["Hamsa Source Serif", "source-serif-4-latin-400-normal", "source-serif-4-latin-600-normal"], ["Hamsa Atkinson", "atkinson-hyperlegible-latin-400-normal", "atkinson-hyperlegible-latin-700-normal"],
    ["Hamsa Plex Mono", "ibm-plex-mono-latin-400-normal", "ibm-plex-mono-latin-600-normal"], ["Hamsa Source Sans", "source-sans-3-latin-400-normal", "source-sans-3-latin-600-normal"],
    ["Hamsa Plex Sans", "ibm-plex-sans-latin-400-normal", "ibm-plex-sans-latin-600-normal"]];
  let fontsIn = false;
  function fonts() {
    if (fontsIn) return;
    fontsIn = true;
    const css = FONTS.map(([fam, r, b]) => `@font-face{font-family:"${fam}";font-weight:400;font-display:swap;src:url("${api.runtime.getURL(`fonts/${r}.woff2`)}") format("woff2")}@font-face{font-family:"${fam}";font-weight:600 700;font-display:swap;src:url("${api.runtime.getURL(`fonts/${b}.woff2`)}") format("woff2")}`).join("");
    const st = document.createElement("style");
    st.id = "hamsa-fonts";
    st.textContent = css;
    (document.head || root).append(st);
  }

  function apply(s = last) {
    last = s;
    const theme = s.theme || "auto";
    const mode = theme === "dark" || (theme !== "light" && media.matches) ? "dark" : "light";
    const set = (k, v) => (v == null ? root.removeAttribute(k) : root.setAttribute(k, v));
    set("data-hamsa-theme", theme === "auto" ? null : theme);
    set("data-hamsa-mode", mode);
    set("data-hamsa-dark", s.darkStyle || "warm");
    set("data-hamsa-font", s.font || "system");
    set("data-hamsa-title-font", s.titleFont || "system");
    set("data-hamsa-size", s.textSize || "m");
    set("data-hamsa-width", s.width || "normal");
    set("data-hamsa-justify", s.justify ? "on" : "off");
    set("data-hamsa-density", s.density || "comfortable");
    root.classList.toggle("hamsa-skin", s.skin !== false);
    if ([s.font, s.titleFont].some((f) => f && f !== "system")) fonts();
  }
  globalThis.HamsaTheme = { apply, current: () => last };

  api.storage.local.get("settings").then(({ settings = {} }) => {
    apply(settings);
    if (settings.layer === false || !layerPage) { clearTimeout(fallback); root.classList.remove("hamsa-pending"); }
  }).catch(() => { clearTimeout(fallback); root.classList.remove("hamsa-pending"); });
  media.addEventListener("change", () => apply());
  api.storage.onChanged.addListener((ch) => { if (ch.settings) apply(ch.settings.newValue || {}); });
})();
