# Changelog

All notable changes to Hamsa. Versions follow the signed builds: the committed manifest carries major.minor.patch, and CI builds add the run number as the patch.

## 0.3.0 (2026-11-10)

### Fixed
- **First load could fail after an install or a browser start.** Every request read the whole tag graph from storage (several megabytes for a large library), and the page gave up while the background page was still starting. The graph now stays compiled in memory and only the keys a request needs are read; page requests retry while the background page wakes; a failure shows a card with *Try again* instead of a half-drawn page.
- **"Show original" did not show the original page.** HN's page was un-hidden but Hamsa's layer stayed on top of it. The layer now hides properly.
- A comment answered by a rebuttal could be removed as "quote only". It is now protected like the rebuttal.
- `scoreFront` could be left synchronous while awaiting the graph; every script is now parse-checked by `npm test`.

### Relevance and ranking
- **Thread context.** A comment on the subject of a story you care about counts as on-topic even when it does not repeat your tag words ("On the thread's topic", up to 0.15).
- **Reply inheritance.** A reply to a relevant comment carries part of its relevance ("Continues a relevant comment", up to 0.12).
- **Author karma**, read from HN's public API and cached for a week, within a 1.2 second budget per thread; missing values keep loading for next time. Can be switched off.
- **Replies drawn** as a signal, and a separate *quality* figure (HN's vote-driven position, karma, replies) used for ordering.
- **Minimum survivors.** A long thread is never cut below 15 comments, or 8 percent of it, by the interest floor; the best-ranked held-back comments return as maybe and say why.
- **What you open is a signal**: sites you open, titles like ones you opened, and tags you click most.
- **HN's published gravity formula**, `(points - 1) / (hours + 2)^1.8`, breaks ties on the front page.
- Scoring rules are now v0.3; cached summaries from v0.2 are re-run on request.

### Duplicates
- **Duplicate submissions** (the same link, after removing tracking parameters, or near-identical titles) merge into one card led by the best-voted submission, with the others listed.
- **Near-duplicate comments** (the same point, by word-shingle overlap) fold under the better-ranked comment as "+n similar".

### Reading threads
- **Survivors view** (the new default): one scroll of what survived, ordered Best (relevance and quality), Relevance or Thread order. Each reply says what it answers, and can show it. **Rebuttals sit directly under the comment they answer.**
- Every comment collapses to one line, smoothly; *Collapse all* and *Expand all*; **j / k** move between comments and **c** collapses.
- **Tree view** keeps the thread in place, with folds that say what was hidden; **Collapse tossed threads** removes the folds entirely.

### Reading options
- **Five bundled fonts** (Inter, Literata, Source Serif 4, Atkinson Hyperlegible, IBM Plex Mono; SIL OFL), chosen separately for text and titles.
- **Better dark mode**: a refined warm charcoal, plus neutral grey and black (OLED) styles. Hamsa works out light or dark itself, so it follows the system instantly.
- In the spirit of Modern for Hacker News: text size, page width, justified comment text, density, and a **skin** that themes the HN pages Hamsa does not redraw (profiles, reply and submit pages, and the Original view).
- **Open in background**: buttons for the story and the filtered thread, and a setting for where story links open (this tab, a new tab, a background tab).
- **Reading log** in this browser: stories, threads and links you open, and the stories you were shown. *Download reading log (JSONL)* gives one row per story with Hamsa's score and what you did, ready for tuning a local model.
- Settings has a **Recent problems** list for anything that goes wrong.

## 0.2.0 (2026-11-10)

Replaced the sidebar with an in-page layer on Hacker News.

- Front page: pages 1 to 4 merged into one list; every story scored 0 to 1 with its reasons; keep, stretch, maybe and toss buckets; *Not for me* with restore; HN order toggle.
- Threads: crust removal (dead, downvoted, abusive, flame chains, meta, quote-only, short), protected rebuttals, an interest floor that keeps off-topic comments away from the model, folds that say what was hidden and why.
- Summary card with tokens sent and received, the cost, and a daily total in the header.
- Daily digest, clustered by topic, built once a day with no model.
- Blocklist: shareable JSON groups, drafted by the model from plain words, suggested from dismissals, tested against today's front page.
- Interest sources: Raindrop, browser bookmarks, HN favourites and upvotes, browser history, bookmark files.
- Parshva's theme system with an Auto, Light and Dark toggle; a swan icon.

## 0.1.0 (2026-11-08)

First version: a Firefox sidebar that summarises one HN thread relevance-first, with deterministic cleaning, a tag graph built from Raindrop, and bring-your-own-key providers.
