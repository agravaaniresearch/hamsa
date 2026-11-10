// Runs at document_start: hides the plain HN page until the Hamsa layer has drawn, and applies the
// theme before first paint. If the layer is off, or anything fails, HN shows as normal.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const root = document.documentElement;
  root.classList.add("hamsa-pending");
  const fallback = setTimeout(() => root.classList.remove("hamsa-pending"), 5000);
  api.storage.local.get("settings").then(({ settings = {} }) => {
    if (settings.layer === false) { clearTimeout(fallback); root.classList.remove("hamsa-pending"); return; }
    if (settings.theme === "light" || settings.theme === "dark") root.setAttribute("data-hamsa-theme", settings.theme);
  }).catch(() => root.classList.remove("hamsa-pending"));
})();
