// Hamsa on HN listing pages: several pages merged into one list, every story scored with no model,
// sorted into keep, maybe, stretch and toss. Tossed stories are hidden but never deleted.
(async () => {
  const H = globalThis.HamsaUI;
  const { h } = H;
  if (!document.getElementById("hnmain")) return H.release();
  let ui;
  try { ui = await H.send({ type: "ui-state" }); } catch (e) { return H.fail(e.message, "ui-state"); }
  if (!ui.layer) return H.release();
  H.applyTheme(ui.theme, ui.font);

  const path = location.pathname.replace(/^\//, "") || "news";
  const NAMES = { news: "Front page", "": "Front page", newest: "New stories", front: "Past front page", ask: "Ask HN", show: "Show HN", best: "Best stories", shownew: "New Show HN" };
  const name = NAMES[path] || "Stories";
  const want = Math.max(1, Math.min(6, ui.scoring?.pages || 5));

  const root = H.mount();
  const status = h("div", { class: "h-loading" }, h("span", { class: "h-spin" }), `Reading page 1 of ${want}…`);
  const main = h("main", { class: "h-main" }, h("h1", { class: "h-h1" }, `${name}, filtered`), status);
  const side = h("aside", { class: "h-side", "aria-label": "Hamsa panels" });
  root.replaceChildren(H.header(ui), h("div", { class: "h-wrap" }, main, side));

  let data;
  try {
    const first = document.documentElement.outerHTML;
    const startMore = document.querySelector("a.morelink")?.getAttribute("href");
    const more = await H.fetchMore(startMore, want - 1, (_, i) => { status.lastChild.textContent = `Reading page ${i + 2} of ${want}…`; });
    status.lastChild.textContent = "Scoring…";
    data = await H.send({ type: "front", pages: [first, ...more] });
  } catch (e) {
    return H.fail(e.message, "front");
    return;
  }
  const pagesRead = Math.max(1, new Set(data.stories.map((s) => Math.ceil((s.rank || 1) / 30))).size);

  const show = { keep: true, stretch: true, maybe: true, toss: false };
  let order = ui.order || "hamsa";
  const byId = new Map(data.stories.map((s, i) => [s.id, { s, v: data.verdicts[i] }]));
  const list = h("div", { class: "h-list", style: "display:flex;flex-direction:column;gap:var(--h-gap)" });

  // ---- one story ----
  function storyCard({ s, v }) {
    const why = h("div", { hidden: true }, H.whyPanel(v, data.scoring));
    const whyBtn = h("button", { class: "h-btn", type: "button", "aria-expanded": "false" }, "Why this score");
    whyBtn.addEventListener("click", () => { why.hidden = !why.hidden; whyBtn.setAttribute("aria-expanded", String(!why.hidden)); whyBtn.textContent = why.hidden ? "Why this score" : "Hide reasons"; });
    const tags = v.reasons.filter((r) => r.kind === "tag" || r.kind === "near").slice(0, 3);
    const more = v.reasons.length - tags.length;
    const vote = s.voteHref && /auth=/.test(s.voteHref) ? h("button", { class: `h-vote${s.voted ? " on" : ""}`, type: "button", title: "Upvote on HN", "aria-label": "Upvote on HN" }, H.icon("up", 14)) : null;
    vote?.addEventListener("click", async () => {
      if (vote.classList.contains("on")) return;
      try { await fetch(new URL(s.voteHref, location.href).href, { credentials: "include" }); vote.classList.add("on"); H.toast("Upvoted on HN"); } catch { H.toast("The vote did not go through."); }
    });
    const thumbs = H.thumbs({ id: s.id, kind: "story", title: s.title, domain: s.domain, url: s.url, threadId: s.id, points: s.points, author: s.by, tags: v.tags }, v, (next) => {
      const sc = data.scoring;
      if (next === "dislike") { v._was = v._was || v.bucket; v.bucket = "toss"; }
      else if (next === "like") { v._was = v._was || v.bucket; v.bucket = v.bucket === "stretch" ? "stretch" : "keep"; }
      else v.bucket = v._was || (v.score >= sc.keepAt ? "keep" : v.score >= sc.maybeAt ? "maybe" : "toss");
      draw();
    });
    const dismiss = h("button", { class: "h-btn ghost", type: "button" }, v.dismissed ? "Restore" : "Not for me");
    dismiss.addEventListener("click", async () => {
      const undo = v.dismissed;
      const r = await H.send({ type: "dismiss", story: { id: s.id, title: s.title, domain: s.domain }, undo }).catch((e) => ({ error: e.message }));
      if (r.error) return H.toast(r.error);
      v.dismissed = !undo;
      if (undo) { const sc = data.scoring; v.bucket = v._was || (!data.ready ? "maybe" : v.score >= sc.keepAt ? "keep" : v.score >= sc.maybeAt ? "maybe" : "toss"); v.reasons = v.reasons.filter((x) => x.label !== "You marked this not for you"); }
      else { v._was = v.bucket; v.bucket = "toss"; v.reasons.unshift({ kind: "note", label: "You marked this not for you", points: 0 }); }
      data.suggestions = r.suggestions || [];
      H.toast(undo ? "Restored" : "Moved to toss. It stays logged and can be restored.");
      draw();
    });
    const entry = (kind) => ({ kind, id: s.id, title: s.title, url: kind === "thread" ? `https://news.ycombinator.com/item?id=${s.id}` : s.url, domain: s.domain, tags: v.tags, score: v.score, bucket: v.bucket, page: "front" });
    const threadUrl = `https://news.ycombinator.com/item?id=${s.id}`;
    const comments = s.kind === "job" ? null : H.track(h("a", { href: `item?id=${s.id}` }, s.comments ? `${s.comments} comments` : "discuss"), entry("thread"), ui);
    const titleA = H.track(h("a", { class: "h-stitle", href: s.url, rel: s.external ? "noopener noreferrer" : null }, s.title), entry("story"), ui);
    const bgStory = h("button", { class: "h-ibtn", type: "button", title: "Open the story in a background tab", "aria-label": "Open the story in a background tab", onclick: () => H.openTab(s.url, false, entry("story")) }, H.icon("bg", 16));
    const bgThread = s.kind === "job" ? null : h("button", { class: "h-btn", type: "button", title: "Open the filtered thread in a background tab", onclick: () => H.openTab(threadUrl, false, entry("thread")) }, "Thread in background");
    const dups = (v.dups || []).map((id) => byId.get(id)).filter(Boolean);
    const also = dups.length ? h("div", { class: "h-also" }, h("span", {}, `Also submitted ${dups.length === 1 ? "once more" : `${dups.length} more times`}:`),
      dups.map(({ s: d }) => h("span", {}, H.track(h("a", { href: `item?id=${d.id}` }, d.title), { kind: "thread", id: d.id, title: d.title, url: `https://news.ycombinator.com/item?id=${d.id}`, domain: d.domain, page: "front" }, ui), ` · ${d.points} points · ${d.comments} comments${d.domain && d.domain !== s.domain ? ` · ${d.domain}` : ""}`))) : null;
    const preview = v.bucket === "stretch" && ui.previews !== false && s.external && s.url ? H.previewSlot(s.url, { ui, page: "front", title: s.title, threadId: s.id, threadTitle: s.title }) : null;
    return h("article", { class: `h-card${v.bucket === "toss" ? " h-dim" : ""}${v.bucket === "stretch" ? " h-stretch-card" : ""}`, id: `hamsa-s-${s.id}` },
      v.bucket === "stretch" ? h("div", { class: "h-ribbon" }, H.icon("compass", 13), "Discover") : null,
      h("div", { class: "h-story" },
        h("div", { class: "h-rank", title: "Rank on Hacker News" }, s.rank ? String(s.rank) : ""),
        h("div", { class: "h-sbody" },
          h("div", { class: "h-shead" },
            titleA,
            H.badge(v.bucket)),
          h("div", { class: "h-meta" },
            vote,
            s.domain ? h("a", { href: `from?site=${encodeURIComponent(s.domain)}` }, s.domain) : null,
            s.points ? h("span", {}, `· ${s.points} points`) : null,
            s.by ? h("span", {}, "· by ", h("a", { href: `user?id=${encodeURIComponent(s.by)}` }, s.by)) : null,
            s.ageText ? h("span", {}, `· ${s.ageText}`) : null,
            comments ? h("span", {}, "· ", comments) : null),
          h("div", { class: "h-score" },
            H.bar(v.bucket, v.score), h("span", { class: "h-num" }, v.score.toFixed(2)),
            tags.map((r) => h("span", { class: "h-tag", title: r.label }, r.tag)),
            v.blocked ? h("span", { class: "h-flag plain" }, `blocked: ${v.blocked.group}`) : null,
            v.bucket === "stretch" ? h("span", { class: "h-flag stretch" }, v.discover ? "new to you" : "outside your tags") : null,
            v.clusterOf ? h("span", { class: "h-flag plain" }, "same topic as a keep") : null,
            v.flame ? h("span", { class: "h-flag plain", title: "Many comments on few points usually means an argument" }, "flame war") : null,
            v.belowThreshold && !v.flame ? h("span", { class: "h-flag plain" }, "below your threshold") : null,
            v.topic && v.topic.size > 1 && v.topic.status === "returning" ? h("span", { class: "h-flag plain", title: `On the front page for ${v.topic.days} days` }, `returning topic · day ${v.topic.days}`) : null,
            more > 0 ? h("span", { class: "h-note" }, `+${more} more signal${more > 1 ? "s" : ""}`) : null),
          also,
          preview,
          why,
          h("div", { class: "h-row" }, whyBtn, comments ? H.track(h("a", { class: "h-btn", href: `item?id=${s.id}` }, "Open filtered thread"), entry("thread"), ui) : null, bgThread, s.external ? bgStory : null, thumbs, dismiss))));
  }

  // ---- topics: stories on one subject sit together, the best one in full and the rest as rows ----
  function grouped(part) {
    const seen = new Set(), out = [];
    for (const it of part) {
      if (seen.has(it.s.id)) continue;
      const t = it.v.topic;
      const mates = t && t.size > 1 ? part.filter((x) => x.v.topic?.id === t.id && x.s.id !== it.s.id && !seen.has(x.s.id)) : [];
      seen.add(it.s.id);
      if (!mates.length) { out.push(storyCard(it)); continue; }
      for (const m of mates) seen.add(m.s.id);
      const status = t.status === "new" ? "new today" : `returning · day ${t.days}`;
      out.push(h("div", { class: `h-topic${t.status === "new" ? " new" : ""}` },
        h("div", { class: "h-topic-head" }, h("span", { class: "h-label" }, "Topic"), h("strong", {}, t.label), h("span", { class: "h-note" }, `${mates.length + 1} stories · ${status}`)),
        storyCard(it),
        mates.map(topicRow)));
    }
    return out;
  }
  function topicRow(it) {
    const { s, v } = it;
    const full = h("div", { hidden: true });
    const open = h("button", { class: "h-btn ghost", type: "button", "aria-expanded": "false" }, "Details");
    open.addEventListener("click", () => {
      if (!full.firstChild) full.append(storyCard(it));
      full.hidden = !full.hidden; open.setAttribute("aria-expanded", String(!full.hidden)); open.textContent = full.hidden ? "Details" : "Hide";
    });
    const entry = { kind: "story", id: s.id, title: s.title, url: s.url, domain: s.domain, tags: v.tags, score: v.score, bucket: v.bucket, page: "front" };
    return h("div", { class: "h-trow", id: `hamsa-s-${s.id}` },
      h("div", { class: "h-trow-line" },
        H.bar(v.bucket, v.score),
        H.track(h("a", { class: "h-ttitle", href: s.url }, s.title), entry, ui),
        h("span", { class: "h-note" }, [s.domain, s.points ? `${s.points} points` : null].filter(Boolean).join(" · ")),
        s.kind === "job" ? null : H.track(h("a", { class: "h-note", href: `item?id=${s.id}` }, `${s.comments || 0} comments`), { ...entry, kind: "thread", url: `https://news.ycombinator.com/item?id=${s.id}` }, ui),
        open),
      full);
  }

  // ---- list, chips and panels ----
  const RANK = { keep: 0, stretch: 1, maybe: 2, toss: 3 };
  function draw() {
    const counts = { keep: 0, maybe: 0, stretch: 0, toss: 0 };
    for (const { v } of byId.values()) if (!v.dupOf) counts[v.bucket]++;
    // Duplicate submissions show inside the card that leads them.
    let items = [...byId.values()].filter(({ v }) => !v.dupOf);
    if (order === "hamsa") items.sort((a, b) => RANK[a.v.bucket] - RANK[b.v.bucket] || b.v.score - a.v.score || (b.v.gravity || 0) - (a.v.gravity || 0) || a.s.rank - b.s.rank);
    const visible = items.filter(({ v }) => show[v.bucket]);
    // In Hamsa's order the page is in sections, Discover first: what you would not have found yourself.
    const SECTION = {
      stretch: ["Discover", "What you would not have known: new to you, and worth a look by HN's own signals."],
      keep: ["Keep", "Matches what you save, open and like."],
      maybe: ["Maybe", "A weaker match. Held, and re-scored when your interests change."],
      toss: ["Toss", "Below the floor, blocked, disliked or dismissed. Logged, and restorable."],
    };
    const out = [];
    if (order === "hamsa") {
      for (const b of ["stretch", "keep", "maybe", "toss"]) {
        const part = visible.filter(({ v }) => v.bucket === b);
        if (!part.length) continue;
        out.push(h("div", { class: `h-section ${b}` }, b === "stretch" ? H.icon("compass", 18) : null, h("strong", {}, `${SECTION[b][0]} · ${part.length}`), h("span", {}, SECTION[b][1])));
        out.push(...grouped(part));
      }
    } else out.push(...visible.map(storyCard));
    list.replaceChildren(...(out.length ? out : [h("div", { class: "h-note" }, "Nothing in the buckets you chose. Switch on Maybe or Toss above.")]));
    const LABEL = { keep: "Keep", stretch: "Discover", maybe: "Maybe", toss: "Toss" };
    chips.replaceChildren(...["stretch", "keep", "maybe", "toss"].map((b) => {
      const c = h("button", { class: `h-chip ${b}`, type: "button", "aria-pressed": String(show[b]) }, `${LABEL[b]} ${counts[b]}`);
      c.addEventListener("click", () => { show[b] = !show[b]; draw(); });
      return c;
    }), h("span", { class: "h-grow" }), pagesSel, orderBtn);
    orderBtn.textContent = order === "hamsa" ? "Order: Hamsa" : "Order: HN";
    drawSide(counts);
    drawBanners();
  }
  const orderBtn = h("button", { class: "h-btn", type: "button", title: "Switch between Hamsa's ranking and HN's own order" });
  orderBtn.addEventListener("click", async () => { order = order === "hamsa" ? "hn" : "hamsa"; draw(); await H.send({ type: "set-ui", patch: { order } }).catch(() => {}); });
  const chips = h("div", { class: "h-row" });
  // How many HN pages to merge: more pages, more to choose from.
  const pagesSel = h("select", { class: "h-select", "aria-label": "Pages to merge", title: "How many HN pages to read and merge" },
    [1, 2, 3, 4, 5, 6].map((n) => h("option", { value: String(n) }, `${n} page${n > 1 ? "s" : ""}`)));
  pagesSel.value = String(want);
  pagesSel.addEventListener("change", async () => {
    await H.send({ type: "set-ui", patch: { pages: Number(pagesSel.value) } }).catch(() => {});
    location.reload();
  });
  const banners = h("div", { style: "display:flex;flex-direction:column;gap:10px" });

  function drawBanners() {
    const b = [];
    if (!data.ready) b.push(h("div", { class: "h-banner" }, h("p", {}, "No interests are synced yet, so every story sits in Maybe. Connect Raindrop, your browser bookmarks or your HN favourites in settings."), h("button", { class: "h-btn primary", onclick: () => H.send({ type: "open-settings" }) }, "Open settings")));
    for (const sug of (data.suggestions || []).slice(0, 1)) {
      b.push(h("div", { class: "h-banner" }, h("p", {}, `You dismissed ${sug.count} stories that share "${sug.patterns[0]}". Add a blocklist rule for them?`), h("button", { class: "h-btn", onclick: () => H.send({ type: "open-settings" }) }, "Review in settings")));
    }
    banners.replaceChildren(...b);
  }

  function drawSide(counts) {
    const src = (data.sources || []).filter((x) => x.id !== "graph");
    const tagsInUse = (data.sources || []).find((x) => x.id === "graph");
    side.replaceChildren(
      h("section", { class: "h-panel" }, h("div", { class: "h-label" }, "AI usage on this page"), h("div", { class: "h-big" }, "0 tokens"),
        h("div", { class: "h-note" }, `The cheap layer scored all ${data.stories.length} stories on this computer. The model is called only when you press Summarise on a thread.`),
        h("div", { class: "h-sep" }), h("div", { class: "h-kv" }, h("span", {}, "Your keys today"), h("b", {}, H.usageText(data.usage).replace("Today: ", "")))),
      h("section", { class: "h-panel" }, h("div", { class: "h-label" }, "Buckets"),
        h("div", { class: "h-kv" }, h("span", {}, "Keep"), h("b", {}, String(counts.keep))),
        h("div", { class: "h-kv" }, h("span", {}, "Discover (new to you)"), h("b", {}, String(counts.stretch))),
        h("div", { class: "h-kv" }, h("span", {}, "Maybe (held, re-scorable)"), h("b", {}, String(counts.maybe))),
        h("div", { class: "h-kv" }, h("span", {}, "Toss (logged, restorable)"), h("b", {}, String(counts.toss))),
        h("div", { class: "h-sep" }), h("div", { class: "h-note" }, `Scoring rules v${data.rules}. Ceiling ${data.scoring.ceiling} (provisional), keep at ${data.scoring.keepAt}, maybe at ${data.scoring.maybeAt}.`)),
      h("section", { class: "h-panel" }, h("div", { class: "h-label" }, "Interest sources"),
        src.map((x) => h("div", { class: "h-kv" }, h("span", {}, x.name), h("b", { style: `color:var(${x.on ? "--h-keep" : "--h-muted"})` }, x.on ? (x.n != null ? `on · ${H.fmtNum(x.n)}` : "on") : "off"))),
        tagsInUse ? h("div", { class: "h-note" }, `${H.fmtNum(tagsInUse.n)} tags in use for scoring.`) : null,
        h("button", { class: "h-btn", style: "align-self:flex-start", onclick: () => H.send({ type: "open-settings" }) }, "Edit sources and blocklist")),
      h("section", { class: "h-panel" }, h("div", { class: "h-label" }, "More"),
        h("button", { class: "h-btn", style: "align-self:flex-start", onclick: () => H.send({ type: "open-digest" }) }, "Open the daily digest")));
  }

  status.replaceWith(
    h("p", { class: "h-lede" }, `${data.stories.length} stories from ${pagesRead} page${pagesRead > 1 ? "s" : ""} scored on this computer${data.verdicts.some((x) => x.dupOf) ? `, ${data.verdicts.filter((x) => x.dupOf).length} duplicate submissions merged` : ""}. No AI call was made for this view.`),
    banners, chips, list);
  draw();
  H.watch(ui, (s) => { ui.linkTarget = s.linkTarget; if (s.layer === false) location.reload(); });
})().catch((e) => globalThis.HamsaUI?.fail(e?.message || String(e), "front"));
