// Runs on HN thread pages. Adds one small button and can scroll to a comment on request.
// It never reads or changes comment text, so restyling add-ons (Modern for Hacker News) are not affected:
// the thread itself is fetched fresh from HN by the background page.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const subtext = document.querySelector(".fatitem .subtext, .fatitem .subline, table.fatitem td.subtext");
  const title = document.querySelector(".fatitem .titleline, .fatitem .toptext, .fatitem");
  const host = subtext || title;
  if (host && !document.getElementById("hamsa-open")) {
    const b = document.createElement("button");
    b.id = "hamsa-open";
    b.type = "button";
    b.textContent = "Summarise with Hamsa";
    b.addEventListener("click", () => api.runtime.sendMessage({ type: "open-sidebar" }).catch(() => {}));
    host.appendChild(document.createTextNode(" "));
    host.appendChild(b);
  }

  api.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "jump") return;
    const row = document.getElementById(String(msg.id));
    if (!row) return Promise.resolve({ found: false });
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("hamsa-flash");
    setTimeout(() => row.classList.remove("hamsa-flash"), 2200);
    return Promise.resolve({ found: true });
  });
})();
