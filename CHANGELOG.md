# Changelog

All notable changes to Hamsa. Versions follow the signed builds: the committed manifest carries major.minor.patch, and CI builds add the run number as the patch.

## 0.5.1 (2026-11-10)

### Fixed
- The Discover ribbon no longer sits on top of the story title.
- A preview whose picture fails to load closes the empty space it left.
- Labels use plain capitals again; the synthesised small capitals rendered some letters oddly.

## 0.5.0 (2026-11-10)

### Link previews
- **A preview card for links**: the page's own title, summary, picture, site and date, read from the first part of the page (Open Graph, Twitter cards and plain meta tags) with no cookies and no scripts run. On the thread's story, on links inside comments (up to two per comment, each page once per thread), and on Discover stories on the front page.
- Cards load as you scroll near them, four at a time, and are kept for two weeks. PDFs, images and YouTube links are recognised without a full fetch.
- **A thumbs up on a preview likes the link** itself, kept with the thread it came from.
- Off until you allow it: one switch in settings asks Firefox once for permission to read the pages links point to. Pictures can be switched off, and load without telling the site where you came from.

### Threads that read like a conversation
- **Quotes become quote blocks** in the colour of the person quoted, with their name, found by searching the comments above. Tap a quote to jump to the comment it came from.
- **Every person has one bright colour** for the whole thread: on their name, on quotes of their words, and on the "reply to" line, which now reads as a quote too. Blue is left out; amber takes its place.
- **Typography**: comment text kept to about 72 characters a line, curly quotes, proper dashes and ellipses (never inside code), small capitals for labels, old-style figures with the serif fonts.
- **Sub-discussions**: branches that share their distinctive words are grouped and labelled ("piracy, donations, emulator · 38"). Chips at the top show one at a time; the tree view marks where each begins.

### Discover, sharper
- **In threads**: a "You wouldn't have found these" strip at the top, and the same comments highlighted in place. A comment qualifies when it sits outside your usual topics, has 40 or more words, and is worth reading by HN's own signals: its place in HN's order, its author's karma, the replies it drew, evidence, and first-hand experience ("I worked on…", "at my company…"). Each says why.
- **On the front page**: Discover stays at the top and is now highlighted: a plum band, a tint and a ribbon, in HN's own order too.

### Topics on the front page
- Stories on one subject are **grouped**: the best one in full, the others as rows beneath it, scored as one topic.
- **Topic memory**: Hamsa remembers the topics it has seen for 30 days, so a topic is marked **new today** or **returning · day n**. Only new topics count as *emerging* for Discover.

### Thresholds
- **Flame wars are left out by default**: 40 or more comments at two or more comments per point goes to toss, and never to Discover. A story you liked always stays.
- **Minimum points and comments**, off by default. Discover is exempt, because new stories start small.

### The digest, made from your likes
- **Look again**: what you liked comes back for another look after 1, 3, 7, 16, 35, 90 and 180 days. *Still useful* moves it to the next gap; *Remind me tomorrow*, *Stop reminding* and *Unlike* do what they say.
- **Today, because you liked…**: today's front pages scored only against your likes (shared words, rarer ones counting more; sites; tags). Each story names the like that brought it.
- **Everything you liked**, by topic, as Stories, Comments and Links, each with its context: the thread, the author, an excerpt, the links in it, the date, and whether it was your thumbs up or an HN upvote.
- Likes now keep that context when you make them.

### Fonts
- **Source Sans 3** and **IBM Plex Sans** join the bundled fonts, grouped as serif, sans serif and monospace.
- **Pairings** in one step: Editorial (Source Serif titles, Source Sans text), Classic (Literata and Inter), Modern (Inter), Bookish (Literata), Easy reading (Atkinson) and Technical (Plex Sans).

### Fixed
- A threshold reason now shows even when a story was already below the floor.
- Scoring rules are now v0.5.

## 0.4.0 (2026-11-10)

### Discover: what you would not have known
- A **Discover** section now leads the front page. A story qualifies when it is **new to you** (most of its words appear in none of your tags, opens, likes or favourites, and the site is one you have never saved) and the **home page says it is worth a look** (votes per hour by HN's gravity formula, a healthy comment-to-point ratio, the submitter's karma). Several unrelated submissions on one new subject mark it as **emerging**.
- Score = 0.45 x novelty + 0.30 x quality + 0.15 x new site + 0.10 x emerging, shown line by line under "Why this score". Five per page by default (0 to 15, 0 switches it off).
- **Near-clustering**: stories sharing a tag or most of their title words form a topic; a story on the same topic as one you keep is lifted ("Same topic as a story you keep").

### Likes, dislikes and signals from the home page
- **Thumbs up and down** on every story, on the thread's story, and on every comment. Kept in this browser (`hamsa.prefs/1`) and used straight away: similar titles, sites and tags rise or fall; a liked story is kept, a disliked one is tossed.
- **Your HN votes become likes**: stories you upvoted and comments you upvoted or downvoted are read from the page (only HN's own "unvote" and "undown" links count). Your own thumbs always win over a vote read from HN.
- **Submitter karma** (HN public API, cached) as a small signal, and as part of Discover's quality.

### Backup and sync
- **Backup file**: everything you set and taught Hamsa in one open JSON file (`hamsa.backup/1`): settings, blocklist, likes and dislikes, dismissals, what you open, and topic boosts and mutes; optionally the reading log, and only if you tick it, your keys. **Restore** merges, never overwrites.
- **Firefox Sync**: settings, blocklist, likes and dismissals follow you to every Firefox where you are signed in. No keys and no reading log; trimmed to fit Firefox's 100 KB.
- **GitHub (private gist)**: the same backup pushed to a secret gist and pulled anywhere, by hand or automatically after changes.

### Settings, redesigned
- A new settings page: an illustrated hero with live status (interests, AI, sync, likes), a sticky section menu, an illustrated **How Hamsa works** in four steps, a **Getting started** checklist, and for every section a short **In plain words** explanation with its own drawing.
- Discover, likes and the reading log share one section; backup, Firefox Sync and GitHub sit side by side.

### Front page
- **Five pages** by default (about 150 stories), and a page selector (1 to 6) on the front page itself.
- Sections in Hamsa's order: Discover, Keep, Maybe, Toss.

### Fixed
- An empty karma lookup no longer rewrites the karma cache.
- Thumbs on comments now show their state straight away.
- Scoring rules are now v0.4.

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
