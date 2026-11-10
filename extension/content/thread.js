// Hamsa on an HN thread: the comment tree, cleaned and scored with no model. Removed comments fold
// into one line that says why; rebuttals deep in a chain stay, with the comment they answer.
// The model is called only when you press Summarise, and the page shows what it was sent and cost.
(async () => {
  const H = globalThis.HamsaUI;
  const { h } = H;
  const id = Number(new URLSearchParams(location.search).get("id"));
  const fat = document.querySelector("table.fatitem");
  if (!id || !fat || !document.getElementById("hnmain")) return H.release();
  // A comment permalink (item?id= of a comment) has no story title: leave it as plain HN.
  if (!fat.querySelector(".titleline")) return H.release();
  let ui;
  try { ui = await H.send({ type: "ui-state" }); } catch { return H.release(); }
  if (!ui.layer) return H.release();
  H.applyTheme(ui.theme, ui.font);

  const RULES = {
    unavailable: "Dead, flagged or deleted", downvoted: "Heavily downvoted", abusive: "Insults or swearing",
    flame_chain: "Flame chain, same two people", meta: "About the site, title or paywall", quote_only: "Only quotes its parent",
    short: "Short, no evidence", below_floor: "Below your interest floor", budget: "Over the token budget",
  };

  const HELD = ["below_floor", "budget"];
  const root = H.mount();
  const status = h("div", { class: "h-loading" }, h("span", { class: "h-spin" }), "Reading the thread…");
  const main = h("main", { class: "h-main" }, status);
  const side = h("aside", { class: "h-side", "aria-label": "Hamsa panels" });
  root.replaceChildren(H.header(ui, { active: "" }), h("div", { class: "h-wrap" }, main, side));

  // ---- read every page of the thread ----
  const docs = [document];
  let data;
  try {
    const first = document.documentElement.outerHTML;
    const more = await H.fetchMore(document.querySelector("a.morelink")?.getAttribute("href"), 9, (doc) => docs.push(doc));
    status.lastChild.textContent = "Cleaning and scoring…";
    data = await H.send({ type: "thread", id, pages: [first, ...more] });
  } catch (e) {
    status.replaceWith(h("div", { class: "h-err" }, `Hamsa could not read this thread: ${e.message}`), h("button", { class: "h-btn", onclick: H.showOriginal }, "Show plain HN"));
    return;
  }
  const V = data.verdicts;
  const rows = [];
  const seen = new Set();
  for (const d of docs) {
    for (const row of d.querySelectorAll("tr.athing.comtr")) {
      const cid = Number(row.getAttribute("id"));
      if (seen.has(cid) || !V[cid]) continue;
      seen.add(cid);
      rows.push({ id: cid, row, v: V[cid] });
    }
  }
  const byPath = new Map(rows.map((r) => [r.v.path, r]));

  // ---- story head ----
  const titleA = fat.querySelector(".titleline > a");
  const sub = fat.querySelector(".subline, .subtext");
  const top = fat.querySelector(".toptext");
  const form = fat.querySelector('form[action="comment"]');
  const storyVote = fat.querySelector(`a#up_${id}`);
  const head = h("section", { class: "h-card h-story-head", style: "display:flex;flex-direction:column;gap:8px" },
    h("a", { class: "h-stitle", href: titleA?.getAttribute("href") || `item?id=${id}`, rel: "noopener noreferrer" }, data.title),
    h("div", { class: "h-meta" },
      voteBtn(storyVote),
      data.domain ? h("a", { href: `from?site=${encodeURIComponent(data.domain)}` }, data.domain) : null,
      h("span", {}, `· ${data.points} points`),
      data.author ? h("span", {}, "· by ", h("a", { href: `user?id=${encodeURIComponent(data.author)}` }, data.author)) : null,
      sub?.querySelector(".age") ? h("span", {}, `· ${sub.querySelector(".age").textContent.trim()}`) : null,
      h("span", {}, `· ${data.funnel.comments} comments`),
      h("span", {}, `· thread relevance ${data.threadRelevance.toFixed(2)}`)),
    top ? h("div", { class: "h-toptext" }, top.cloneNode(true)) : null);
  if (form) {
    const box = h("details", { class: "h-addc" }, h("summary", { class: "h-note", style: "cursor:pointer" }, "Add a comment"));
    box.append(form);
    head.append(box);
  }

  function voteBtn(a) {
    const href = a?.getAttribute("href");
    if (!href || !/auth=/.test(href)) return null;
    const b = h("button", { class: `h-vote${a.classList.contains("nosee") ? " on" : ""}`, type: "button", title: "Upvote on HN", "aria-label": "Upvote on HN" }, H.icon("up", 14));
    b.addEventListener("click", async () => {
      if (b.classList.contains("on")) return;
      try { await fetch(new URL(href, location.href).href, { credentials: "include" }); b.classList.add("on"); H.toast("Upvoted on HN"); } catch { H.toast("The vote did not go through."); }
    });
    return b;
  }

  // ---- summary card ----
  const sumCard = h("section", { class: "h-card h-sum", style: "display:flex;flex-direction:column;gap:10px" });
  const money = (c) => (!c || !c.known ? "price unknown" : c.usd === 0 ? "free (local)" : `$${c.usd < 0.01 ? c.usd.toFixed(4) : c.usd.toFixed(3)} · Rs ${c.inr < 1 ? c.inr.toFixed(2) : c.inr.toFixed(1)}`);
  let current = data.cached;

  function drawSumIdle(err) {
    const sel = h("select", { class: "h-select", "aria-label": "Model for this summary" });
    for (const m of ui.models || []) sel.append(h("option", { value: `${m.providerId}|${m.model}` }, `${m.provider} · ${m.model}`));
    if (ui.model) sel.value = `${ui.model.providerId}|${ui.model.model}`;
    sel.addEventListener("change", async () => {
      const [providerId, ...rest] = sel.value.split("|");
      ui.model = { providerId, model: rest.join("|") };
      await H.send({ type: "set-ui", patch: { active: { providerId, model: rest.join("|") } } }).catch(() => {});
    });
    const est = data.estimate;
    H.fill(sumCard, 
      h("div", { class: "h-row", style: "justify-content:space-between" }, h("div", { class: "h-label" }, "Summary, on request"),
        h("div", { class: "h-row" },
          h("span", { class: "h-tok", title: "Estimated at about four characters per token" }, `about ${H.fmtNum(est?.input ?? data.tokens)} tokens to send`),
          est ? h("span", { class: "h-tok" }, `up to ${H.fmtNum(est.output)} back`) : null,
          est ? h("span", { class: "h-tok" }, `est. ${money(est)}`) : null)),
      h("p", { class: "h-note", style: "margin:0" }, `Only the ${data.funnel.sent} comments that passed cleaning${data.graphReady ? " and your interest floor" : ""} are sent, out of ${data.funnel.comments}.`),
      err ? h("div", { class: "h-err" }, err) : null,
      (ui.models || []).length
        ? h("div", { class: "h-row" }, h("button", { class: "h-btn primary", type: "button", onclick: () => run(false) }, "Summarise"), sel)
        : h("div", { class: "h-row" }, h("span", { class: "h-note" }, "Add a provider and key in settings to summarise."), h("button", { class: "h-btn", onclick: () => H.send({ type: "open-settings" }) }, "Open settings")));
  }

  let busy = false;
  async function run(force) {
    if (busy) return;
    busy = true;
    H.fill(sumCard, h("div", { class: "h-loading", style: "padding:6px 0" }, h("span", { class: "h-spin" }), `Summarising with ${ui.model?.model || "your model"}…`));
    try {
      const r = await H.send({ type: "summarise", id, providerId: ui.model?.providerId, model: ui.model?.model, force });
      current = r;
      if (r.today) H.setUsage(r.today);
      drawSumResult();
    } catch (e) {
      drawSumIdle(e.message);
    } finally { busy = false; }
  }

  function refsRow(refs) {
    if (!refs?.length) return null;
    return h("div", { class: "h-refs h-note" }, "Comments ", refs.map((r, i) => [i ? ", " : "", h("button", { type: "button", title: "Show this comment", onclick: () => jump(current.ids[r]) }, r)]));
  }
  function tagButtons(tags) {
    return (tags || []).map((t) => {
      const b = h("button", { class: "h-tag", type: "button", "data-s": "0", title: "Tap to boost this tag, again to mute it, again to reset" }, t);
      b.addEventListener("click", async () => {
        const s = (+b.dataset.s + 1) % 3;
        b.dataset.s = String(s);
        const o = await H.send({ type: "feedback", kind: "tag", tag: t, action: ["reset", "boost", "mute"][s] }).catch((x) => ({ note: x.message }));
        H.toast(o.note || t);
      });
      return b;
    });
  }
  function toMarkdown(r) {
    const s = r.summary, L = [`# ${r.title}`, "", s.gist, "", `*Relevance: ${s.relevance_note}*`, ""];
    const link = (refs) => refs.map((x) => `[${x}](https://news.ycombinator.com/item?id=${r.ids[x]})`).join(", ");
    if (s.points.length) { L.push("## Points", ""); for (const p of s.points) L.push(`- **${p.basis.replace("_", " ")}:** ${p.claim} (${link(p.refs)})`, `  - *Why it matters to you:* ${p.why_relevant}`); L.push(""); }
    if (s.disagreements.length) { L.push("## Real disagreements", ""); for (const d of s.disagreements) { L.push(`- **${d.question}**`); for (const x of d.sides) L.push(`  - ${x.position}: ${x.best_case} (${link(x.refs)})`); } L.push(""); }
    if (s.corrections.length) { L.push("## Corrections", ""); for (const c of s.corrections) L.push(`- ${c.claim} → ${c.correction} (${link(c.refs)})`); L.push(""); }
    if (s.links.length) { L.push("## Links that carry evidence", ""); for (const l of s.links) L.push(`- ${l.url}: ${l.why}`); }
    return L.join("\n");
  }
  function drawSumResult() {
    const r = current, s = r.summary;
    const relB = (x) => (x >= 0.55 ? "keep" : x >= 0.2 ? "maybe" : "toss");
    H.fill(sumCard, 
      h("div", { class: "h-row", style: "justify-content:space-between" }, h("div", { class: "h-label" }, r.fromCache ? "Summary (saved copy, no new tokens used)" : "Summary"),
        h("div", { class: "h-row" },
          h("span", { class: "h-tok", title: `Hamsa estimated ${H.fmtNum(r.estimateIn)} before the call` }, `sent ${H.fmtNum(r.usage.input)} tokens`),
          h("span", { class: "h-tok", title: "Reported by the provider" }, `received ${H.fmtNum(r.usage.output)} tokens`),
          h("span", { class: "h-tok" }, money(r.cost)))),
      h("p", { class: "h-gist" }, s.gist),
      h("p", { class: "h-note", style: "margin:0" }, `Why it matters to you: ${s.relevance_note}`),
      s.points.map((p) => h("div", { class: "h-point" },
        h("div", { class: "h-row" }, H.badge(relB(p.rel ?? 0), p.rel ?? 0), h("span", { class: "h-flag plain" }, (p.basis || "").replace("_", " "))),
        h("p", {}, p.claim),
        h("p", { class: "why" }, "Why it matters to you: ", p.why_relevant),
        refsRow(p.refs),
        p.tags?.length ? h("div", { class: "h-row" }, h("span", { class: "h-note" }, "Matched on"), tagButtons(p.tags),
          h("button", { class: "h-btn ghost", type: "button", onclick: async (e) => { const o = await H.send({ type: "save-point", id, title: r.title, tags: p.tags, point: p.claim }).catch((x) => ({ note: x.message })); e.target.textContent = o.saved ? "Saved" : "Counted"; H.toast(o.note); } }, "Save to Raindrop")) : null)),
      s.disagreements.length ? h("div", {}, h("h3", {}, "Real disagreements"), s.disagreements.map((d) => h("div", { class: "h-point" }, h("strong", {}, d.question), d.sides.map((x) => h("div", {}, h("strong", {}, x.position.replace(/[.:;,\s]+$/, "")), ": ", x.best_case, " ", refsRow(x.refs)))))) : null,
      s.corrections.length ? h("div", {}, h("h3", {}, "Corrections"), s.corrections.map((c) => h("div", { class: "h-point" }, h("span", {}, c.claim, " → ", c.correction), refsRow(c.refs)))) : null,
      s.links.length ? h("div", {}, h("h3", {}, "Links that carry evidence"), s.links.map((l) => h("div", { class: "h-point" }, h("a", { href: l.url, rel: "noopener noreferrer", target: "_blank" }, l.url), h("span", { class: "h-note" }, l.why)))) : null,
      h("div", { class: "h-row" },
        h("button", { class: "h-btn", type: "button", onclick: async (e) => { await navigator.clipboard.writeText(toMarkdown(r)); e.target.textContent = "Copied"; } }, "Copy as Markdown"),
        h("button", { class: "h-btn", type: "button", onclick: () => run(true) }, "Summarise again"),
        h("span", { class: "h-note" }, `${r.provider} · ${r.model}`)));
  }

  // ---- comments ----
  const show = { keep: true, stretch: true, maybe: true, toss: false, removed: false };
  const forced = new Set();     // comments opened from a fold or a summary reference
  const collapsed = new Set();  // paths whose replies are hidden
  const bodies = new Map();
  const list = h("div", { class: "h-comments" });
  const chips = h("div", { class: "h-row" });

  const ancestors = (path) => { const out = []; const p = path.split("."); while (p.length > 1) { p.pop(); out.push(p.join(".")); } return out; };
  const isProtected = (v) => (v.rebuttal || v.answered) && v.bucket !== "removed";
  const baseVisible = (r) => show[r.v.bucket] || isProtected(r.v) || forced.has(r.id);

  function body(r) {
    if (!bodies.has(r.id)) {
      const t = r.row.querySelector(".commtext");
      bodies.set(r.id, t ? t.cloneNode(true) : h("span", { class: "h-note" }, r.v.bucket === "removed" ? "[dead or deleted]" : ""));
    }
    return bodies.get(r.id).cloneNode(true);
  }

  function card(r, mode) {
    const v = r.v;
    const who = r.row.querySelector('a.hnuser, .comhead a[href^="user?id="]')?.textContent || v.author || "[deleted]";
    const age = r.row.querySelector(".age")?.textContent?.trim() || "";
    const why = h("div", { hidden: true }, H.whyPanel(v, ui.scoring));
    const whyBtn = h("button", { type: "button" }, "why this score");
    whyBtn.addEventListener("click", () => { why.hidden = !why.hidden; whyBtn.textContent = why.hidden ? "why this score" : "hide reasons"; });
    const kids = rows.filter((x) => x.v.path.startsWith(`${v.path}.`)).length;
    const fold = kids ? h("button", { type: "button" }, collapsed.has(v.path) ? `show replies (${kids})` : `hide replies (${kids})`) : null;
    fold?.addEventListener("click", () => { collapsed.has(v.path) ? collapsed.delete(v.path) : collapsed.add(v.path); draw(); });
    const flags = [
      v.rebuttal ? h("span", { class: "h-flag" }, "rebuttal, protected") : null,
      v.answered && !v.rebuttal ? h("span", { class: "h-flag plain" }, "kept as parent of a rebuttal") : null,
      v.stretch ? h("span", { class: "h-flag stretch" }, "stretch pick") : null,
      v.rule && v.bucket !== "removed" ? h("span", { class: "h-flag plain" }, `not sent: ${RULES[v.rule]?.toLowerCase() || v.rule}`) : null,
      v.bucket === "removed" ? h("span", { class: "h-flag plain" }, `removed: ${RULES[v.rule]?.toLowerCase() || v.rule}`) : null,
      mode === "context" ? h("span", { class: "h-flag plain" }, "shown for context") : null,
    ];
    const reply = r.row.querySelector('a[href^="reply?"]')?.getAttribute("href") || `reply?id=${r.id}&goto=${encodeURIComponent(`item?id=${id}#${r.id}`)}`;
    const cls = ["h-c", v.depth ? "h-indent" : "", mode === "context" ? "h-context" : "", mode === "removed" || v.bucket === "removed" ? "h-removed" : ""].join(" ");
    return h("div", { class: cls, id: `hamsa-c-${r.id}`, style: `margin-left:${Math.min(v.depth, 8) * 20}px;padding-left:${v.depth ? 10 : 0}px` },
      h("div", { class: "h-card" },
        h("div", { class: "h-chead" },
          h("div", { class: "who" }, voteBtn(r.row.querySelector(`a#up_${r.id}`)), h("a", { href: `user?id=${encodeURIComponent(who)}` }, h("strong", {}, who)), who === data.author ? h("span", { class: "h-op" }, "OP") : null, h("span", { class: "when" }, age), flags),
          H.badge(v.bucket, v.score)),
        h("div", { class: "h-cbody" }, body(r)),
        v.tags.length ? h("div", { class: "h-row", style: "margin-bottom:6px" }, tagButtons(v.tags)) : null,
        why,
        h("div", { class: "h-cfoot" }, whyBtn, h("a", { href: reply }, "reply"), h("a", { href: `item?id=${r.id}` }, "link"), fold)));
  }

  function foldRow(group) {
    const counts = new Map();
    for (const r of group) { const k = r.v.rule || r.v.bucket; counts.set(k, (counts.get(k) || 0) + 1); }
    const label = [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${(RULES[k] || (k === "toss" ? "below your interest floor" : k)).toLowerCase()}`).join(", ");
    const minDepth = Math.min(...group.map((r) => r.v.depth));
    const b = h("button", { class: "h-btn", type: "button" }, "Show");
    b.addEventListener("click", () => { for (const r of group) forced.add(r.id); draw(); });
    return h("div", { class: "h-fold", style: `margin-left:${Math.min(minDepth, 8) * 20}px` }, h("span", {}, `${group.length} hidden: ${label}`), b);
  }

  function draw() {
    const visible = new Set(rows.filter(baseVisible).map((r) => r.v.path));
    const context = new Set();
    for (const p of visible) for (const a of ancestors(p)) if (!visible.has(a) && byPath.has(a)) context.add(a);
    const hiddenByCollapse = (p) => ancestors(p).some((a) => collapsed.has(a));
    const out = [];
    let group = [];
    const flush = () => { if (group.length) out.push(foldRow(group)); group = []; };
    for (const r of rows) {
      const p = r.v.path;
      if (hiddenByCollapse(p)) continue;
      if (visible.has(p)) { flush(); out.push(card(r, forced.has(r.id) && !show[r.v.bucket] && !isProtected(r.v) ? "removed" : "normal")); }
      else if (context.has(p)) { flush(); out.push(card(r, "context")); }
      else group.push(r);
    }
    flush();
    list.replaceChildren(...(out.length ? out : [h("div", { class: "h-note" }, "No comments yet.")]));
    const counts = { keep: 0, stretch: 0, maybe: 0, toss: 0, removed: 0 };
    for (const r of rows) counts[r.v.bucket]++;
    const label = { keep: "Keep", stretch: "Stretch", maybe: "Maybe", toss: "Below floor", removed: "Removed" };
    chips.replaceChildren(...Object.keys(counts).filter((b) => counts[b] || b === "keep").map((b) => {
      const c = h("button", { class: `h-chip ${b}`, type: "button", "aria-pressed": String(show[b]) }, `${label[b]} ${counts[b]}`);
      c.addEventListener("click", () => { show[b] = !show[b]; if (!show[b]) forced.clear(); draw(); });
      return c;
    }), h("span", { class: "h-grow" }), h("button", { class: "h-btn", type: "button", onclick: H.showOriginal }, "Show original thread"));
  }

  function jump(cid) {
    if (!cid) return;
    forced.add(cid);
    for (const a of ancestors(V[cid]?.path || "")) collapsed.delete(a);
    draw();
    const el = document.getElementById(`hamsa-c-${cid}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("h-flash");
    setTimeout(() => el.classList.remove("h-flash"), 2200);
  }

  // ---- side panels ----
  function drawSide() {
    const f = data.funnel, pct = (n) => `${Math.round((n / Math.max(1, f.comments)) * 100)}%`;
    const stage = (label, n, cls) => { const b = h("span", { class: `h-bar ${cls}` }, h("i")); b.firstChild.style.width = pct(n); return h("div", { class: "h-funnel" }, h("div", { class: "h-kv" }, h("span", {}, label), h("b", {}, String(n))), b); };
    const d = data.dropped;
    side.replaceChildren(
      h("section", { class: "h-panel" }, h("div", { class: "h-label" }, "What reaches the model"),
        stage("Comments in thread", f.comments, ""), stage("After crust removal", f.afterCrust, ""), stage("After tag match", f.afterTags, "tags"), stage("Sent to the model", f.sent, "sent"),
        h("div", { class: "h-note" }, data.graphReady ? "Comments below your interest floor stay on the page but are not sent." : "No interests synced, so nothing is held back by relevance.")),
      h("section", { class: "h-panel" }, h("div", { class: "h-label" }, "Removed, by rule"),
        Object.entries(RULES).filter(([k]) => d[k] && !HELD.includes(k)).map(([k, label]) => h("div", { class: "h-kv" }, h("span", {}, label), h("b", {}, String(d[k])))),
        Object.keys(RULES).some((k) => d[k] && !HELD.includes(k)) ? null : h("div", { class: "h-note" }, "Nothing was removed."),
        HELD.some((k) => d[k]) ? [h("div", { class: "h-sep" }), h("div", { class: "h-label" }, "Held back from the model, still shown"),
          HELD.filter((k) => d[k]).map((k) => h("div", { class: "h-kv" }, h("span", {}, RULES[k]), h("b", {}, String(d[k]))))] : null,
        h("div", { class: "h-sep" }), h("div", { class: "h-note" }, "Rebuttals, and the comments they answer, are never cut. Every cut is logged and can be shown from the fold where it happened.")),
      h("section", { class: "h-panel" }, h("div", { class: "h-label" }, "Score on every comment"),
        h("div", { class: "h-note" }, `Each comment carries its 0 to 1 score, the reasons behind it, its bucket and the rules version (v${data.rules}), so a re-score later needs no new fetching. Depth never lowers a score.`)));
  }

  status.replaceWith(head, sumCard, chips, list);
  current ? drawSumResult() : drawSumIdle();
  draw();
  drawSide();
  if (location.hash && /^#\d+$/.test(location.hash)) jump(Number(location.hash.slice(1)));
  H.watch(ui, (s) => { if (s.layer === false) location.reload(); });
})();
