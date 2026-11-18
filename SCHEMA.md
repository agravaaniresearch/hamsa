# Schemas and rules

Everything on this page runs on your computer with no model. A model is called only for a thread summary you ask for, or to draft blocklist rules from your own words.

## The 0 to 1 score (`hamsa.score/1`, rules v0.6)

Every story and every comment carries four things, never the number alone:

| Field | Meaning |
|---|---|
| `score` | 0 to 1 |
| `reasons` | `[{ kind, label, points }]`, the signals that produced the score, strongest first |
| `bucket` | `keep`, `maybe`, `stretch`, `toss` (stories, and comments below the floor) or `removed` (comments cut as crust) |
| `rules` | the scoring-rules version, so an old item can be re-scored and compared fairly |

```
total = sum of reason points
score = 1 - exp(-2 * total / ceiling)
```

`ceiling` is provisional (0.9 by default) and tuned on real threads; a total equal to the ceiling scores about 0.86. Buckets: keep at 0.55 or more, maybe at 0.2 or more, otherwise toss. All of these are in settings.

### Story signals (front page)

| Kind | Label | Points |
|---|---|---|
| `tag` | Rare tag match / Broad tag match (rare = tag weight 0.45 or more) | 0.5 x tag weight x activation |
| `near` | Near your tag (reached along a co-occurrence edge) | same formula; activation is already damped |
| `domain` | Domain appears in your bookmarks (n) | 0.15 x min(1, log2(1 + n) / 4) |
| `history` | You often read this site (3 or more visits); from 0.7 there is no browser-history source, so this fires only on profiles synced before 0.7 | 0.08 x min(1, log2(1 + visits) / 5) |
| `fav` | Like an HN favourite (2 or more shared title words, overlap 0.3 or more) | 0.15 |
| `opened` | You open stories from this site (n) | 0.1 x min(1, log2(1 + n) / 3) |
| `opened` | Like a story you opened (as for favourites) | 0.12 |
| `opened` | You often open stories tagged X (2 or more opens) | 0.05 x min(1, log2(1 + n) / 3) |
| `muted` | Muted tag | -0.3 |
| `block` | Blocked: group (pattern). Forces toss unless the score is at least `blockOverrideAt` (0.75) | 0 |

Ties within a bucket are broken by Hacker News' published gravity, `(points - 1) / (hours + 2)^1.8` ([how it works](https://medium.com/hacking-and-gonzo/how-hacker-news-ranking-algorithm-works-1d9b0cf2c08d)), then HN's rank.

**Duplicate submissions**: the same link (host without `www.`, path without a trailing slash, tracking parameters such as `utm_*` removed; arXiv abs and pdf links treated as one; YouTube by video id), or titles sharing 3 or more words with an overlap of 0.6 or more. The best-voted submission leads, takes the best bucket of the group, and lists the others.

A title fires a tag when every word of the tag's name is in the title, or when an anchor term and a second term of the tag both appear. Words of one or two letters in a tag's name ("ai" in "ai safety", "ml", "ux") count too: "Warehouse safety rules" does not fire "ai safety", and a tag called "ml" fires on a title that says ML. Stop words ("of", "in") never count. Titles are scored on an absolute scale, so a story scores the same on any page.

With no interests synced, or no tag used often enough to score yet (see the relevance graph), every story sits in maybe with a note; nothing is ranked. The same holds on a thread: no comment is held back as off-topic.

### Discover (what you would not have known)

Candidates: not blocked, dismissed, disliked or a flame war, no direct tag match, not already kept, at least 20 points or 15 comments, and at least two title words of four or more letters.

| Component | Measure | Weight |
|---|---|---|
| Novelty | share of title words found in none of your tag terms, opened titles, liked titles or favourites (must be 0.5 or more) | 0.45 |
| Quality | 0.5 x votes per hour (HN gravity, against twice the page median, capped at 1) + 0.35 x discussion depth (comments to points between 0.3 and 2 scores 1) + 0.15 x submitter karma | 0.30 |
| New site | a site you have never saved or opened | 0.15 |
| Emerging | at least two stories in the same near-cluster that none of your tags touch, on a topic new today | 0.10 |

The best `discoverCount` (5) become the Discover bucket (`stretch` internally), with the sum as their score.

### Topics (near-clusters)

Two stories join when a tag fired on both titles, or they share two or more title words of four or more letters with an overlap of 0.25 or more. Each group is a **topic**, shown together on the page and scored as a unit: a topic holding a keep lifts its other members by `min(0.2, 0.1 + 0.03 x (n - 1))` ("Same topic as a story you keep"); one holding only a weaker match lifts them by `min(0.2, 0.05 + 0.03 x (n - 1))` ("Part of a topic you follow").

**Topic memory** (`topics`): up to 500 topics, each `{ terms, label, first, firstDay, last, lastDay, days }`, kept 30 days. A topic on the page matches a remembered one when they share two or more terms; it is `returning` from its second day, otherwise `new`.

### Thresholds

| Setting | Default | Effect |
|---|---|---|
| `flameFilter` | on | `comments >= flameMinComments` (40) and `comments / points >= flameRatio` (2) goes to toss: "Looks like a flame war". Never Discover. |
| `minPoints`, `minComments` | 0 (off) | below either goes to toss: "Below your threshold". Discover is exempt. |

A like overrides both; a block or a dislike is never replaced by a threshold reason.

### Likes, dislikes and home-page signals (stories)

| Kind | Label | Points |
|---|---|---|
| `like` | Like something you liked (two or more shared title words, overlap 0.3 or more) | 0.15 |
| `like` | You liked stories from this site (n) | 0.08 x min(1, log2(1 + n) / 3) |
| `like` | Its tags are ones you liked | 0.05 x min(1, log2(1 + n) / 3) |
| `dislike` | Like something you disliked | -0.2 |
| `dislike` | You disliked stories from this site (2 or more) | -0.1 |
| `karma` | Submitted by a high-karma user (5000 or more) | 0.03 |

A story you liked is kept and one you disliked is tossed, whatever the score. A story you upvoted on HN counts as a like.

### Comment signals (thread page)

| Kind | Label | Points |
|---|---|---|
| `tag`, `near` | as for stories, from the comment-level tag graph | 0.5 x tag weight x activation |
| `evidence` | Carries evidence: link (0.08), number (0.05), code (0.08) | capped at 0.15 |
| `rebuttal` | Rebuttal: disagrees with its parent and adds a fact | 0.15 |
| `context` | On the thread's topic: the story fires your tags and the comment shares a word of its title or text | 0.15 x the story's own score |
| `inherit` | Continues a relevant comment (its parent fired your tags) | min(0.12, 0.3 x the parent's tag points) |
| `hn` | Ranked high by HN readers (HN score 700 or more) | 0.12 x HN score / 1000 |
| `karma` | Author karma (500 or more), from HN's public API, cached a week | 0.08 x min(1, log10(1 + karma) / 5) |
| `replies` | Drew n replies (2 or more) | 0.06 x min(1, log2(1 + n) / 5) |
| `op` | Written by the submitter | 0.05 |
| `muted` | Muted tag | -0.3 |
| `floor` | Kept so the thread is not empty (see minimum survivors) | 0 |

With interests synced, a comment that is not on-topic (no `tag`, `near`, `context` or `inherit` reason) sits below the floor (`toss`) whatever its evidence: it stays on the page, but it is not sent to the model. Depth never lowers a score.

**Quality** (0 to 1, for ordering only) = 0.5 x HN position score / 1000 + 0.3 x karma (as above) + 0.2 x replies (as above). HN publishes neither comment points nor its comment-ranking weights, so its own ordering (which reflects votes and time) is the vote signal, as in HN Companion. Reddit's "best" sort (the Wilson score interval) needs up and down counts, which HN does not expose, so it is not used. **Best** order on a thread = 0.7 x score + 0.3 x quality.

## Cleaning order (thread page)

1. `unavailable`: dead, flagged, deleted or collapsed rows.
2. Features: HN Companion's rank score `floor(1000 - rank x 1000 / N)` minus 10 percent per downvote shade, evidence flags, rebuttal detection, tag relevance, comment score.
3. `downvoted`: 4 or more downvote shades.
4. `abusive`: an insult in under 80 words with no link or code, or 2 or more swear words in under 40 words with no evidence.
5. `flame_chain`: two authors alternating A B A B A for 5 or more turns. Kept: first, longest and last, the OP, rebuttals and what they answer, links or code, 100 or more words, relevance 0.5 or more.
6. `meta`: under 50 words about the paywall, the title, voting, flagging or the site itself.
7. `quote_only`: every paragraph is a quote.
8. `short`: under 15 words, no evidence, no replies, relevance under 0.5.
9. `duplicate`: two comments whose word 3-gram sets overlap by 0.5 or more (each with 6 or more 3-grams). The one ranked higher by HN stays and lists the other. Then **Discover** picks (below), then `below_floor`: comments in the toss bucket are held back from the model. **Minimum survivors**: if fewer than max(15, 8 percent of the thread) comments survive, the held-back comments with the best quality return as maybe.
10. `budget`: lowest priority first until under the token budget. Priority = HN score x (1 + 0.8 x relevance) x OP 1.3 x evidence 1.15 x rebuttal 1.5.

Rules 3 to 8 and `duplicate` are the crust and mark a comment `removed`. Rules 9 and 10 only keep a comment away from the model; it stays on the page with its bucket. Rebuttals, and the comments they answer (and the OP), are exempt from rules 5 to 9; rules 1, 3 and 4 still apply, and the budget cuts them only as a last resort (priority x 1.5).

**Discover in a thread**: comments at depth 0 to 2 with 40 or more words and no tag, near-tag, thread-topic or inherited reason. Quality = 0.35 x HN position (score / 1000) + 0.25 x karma (`log10(1 + k) / 5`) + 0.15 x replies (`log2(1 + replies) / 5`) + 0.10 x evidence + 0.15 x first-hand experience ("I worked on", "at my company", "in my experience", "we built"...). At 0.4 or more they compete; the best `stretchMax` (3) become `stretch`, are kept and sent, and list their reasons.

**Strands** (`lib/strands.js`, 0.7): the conversations inside a thread.
1. *Seeds*: each top-level comment and its replies is a branch.
2. *Profiles*: each branch keeps its 12 most distinctive words, weighted term frequency x `log(1 + branches / branches using it)` (words in more than half the branches and vague words are dropped).
3. *Merge*: branches join greedily, biggest first, when the cosine similarity of their profiles is 0.22 or more. Strands with 6 or more comments are shown (a single branch needs 12), up to 8; the rest is "Everything else".
4. *Kind*: one text rule per kind (debate: quote blocks or disagreement words; experience: "I use", "we run", "in production"; explainer: over 700 characters with few replies, or explaining phrases; alternatives: "have you tried", "instead of", "switched to"; stance: "I don't use", "zero usage"; meta: about HN, the title or the submitter). The kind whose rule fires on the largest share of the strand's comments wins if that share is 20% or more; otherwise "discussion". Kinds you mute in settings are not shown as strands.
5. *Relevance*: the mean of the comments' own 0 to 1 scores.

Each strand record: `{ id, kind, label, terms, colour, branches, count, people, relevance, why, ids }`. A strand summary sends only that strand's comments that survived the crust rules (the interest floor and token budget do not apply) and is cached as `<thread id>:<strand id>`.

**New since your last visit**: HN comment ids only grow, so Hamsa keeps, per thread, the highest comment id it has shown you (`visits`, 500 threads). On the next visit every comment with a higher id is new.

**Quotes**: a paragraph starting with `>` becomes a quote block. Its source is the nearest comment above it whose text contains the quote's first 60 characters (letters and digits only), or the story text. Each author's colour is a fixed hash of their name into 8 bright colours.

**Rebuttal**: a reply to someone else whose text (after any quotes) opens with a disagreement ("No,", "Actually", "That's not true", "I disagree"...) or says so in its first 30 words, and carries evidence or 40 or more words.

**Funnel** shown on every thread: comments in thread, after crust removal, after tag match, sent to the model.

**Views**: Survivors lists keep, stretch, maybe and protected comments (no duplicates), ordered Best, Relevance or Thread order, with each rebuttal placed directly under the comment it answers. Tree shows the thread in place; everything hidden sits in a fold that says why, and *Collapse tossed threads* removes the folds.

## Relevance graph (`hamsa.graph/1`)

- Built from items with tags and text: Raindrop bookmarks (with highlights when switched on), browser bookmark folders (each folder on the path is a tag) and imported bookmark files. Stored as raw counts so each save updates it incrementally.
- A tag fires on a comment only when one of its anchor terms (its own name, or a term found under at most three tags) appears together with at least one more of its recurring terms. Terms must recur in two or more items under the tag. Texts are matched through an index of anchor terms and name words, so only the tags a text shares such a word with are checked; the numbers are the same as checking every tag.
- Tag weight favours specific tags and recent ones:

  ```
  weight   = max(0.02, specific x seen x recency x exp(adj))
  specific = ln(N / count) / ln(N)            N = items in the graph (at least 2), count = items under the tag
  seen     = min(1, ln(1 + count) / ln(4))    damps tags used once or twice
  ```

  Tags used fewer than 4 times (`minTagCount`) are not scored at all. "Tags in use" counts only the tags that can score.
- **Recency** (rules 0.6): a tag you stopped using fades, but never below half its weight, so an old core interest is not erased.

  ```
  rc       = each dated bookmark under the tag counts 1, halved for every 365 days (halfLifeDays) it is older
             than the tag's newest bookmark (kept as one number per tag, updated as you save)
  recent   = rc x 2^(-(newest bookmark in the library - the tag's newest bookmark) / 365 days)
  recency  = 0.5 + 0.5 x min(1, recent / min(3, count))
  ```

  In words: a tag keeps its full weight while about three of its bookmarks (or all of them, if it has fewer) are from the last year or so of your saving; a tag untouched for years drops to 0.5. Ages count back from your newest bookmark, not from today, so a library you have not added to for a while keeps its balance. Bookmarks without a date are left out of the count, and a tag with no dated bookmark is never faded. A graph saved before 0.6 has no `rc` and is not faded until the next sync. `halfLifeDays: 0` in the graph's `params` switches recency off. In simulation this lifted ranking quality (NDCG@10) by 0.05 to 0.10 for a reader whose interests move in phases and changed nothing for a steady reader.
- Activation spreads along co-occurrence edges (40 percent of the neighbour's, capped). Muted tags subtract. Per-tag adjustments from feedback multiply the weight by `exp(adj)`: saving a point moves `adj` by 0.2 for its tags, a boost by 1 (a thumb sent as feedback by 0.3), limited to +-2. A stored adjustment that is not a number counts as 0.

## Interest profile (`hamsa.profile/1`)

`{ domains, histDomains, fav, sources, built_at }`: sites you bookmarked (all sources), sites you read often (from browser history before 0.7; the source was removed in 0.7 and this list is empty after the next sync), and the titles of your HN favourites and upvoted stories as stemmed terms. `sources` records the item count and sync time for each source.

## Blocklist (`hamsa.blocklist/1`)

```json
{
  "schema": "hamsa.blocklist/1",
  "groups": [
    { "id": "funding", "name": "Funding rounds", "enabled": true, "fields": ["title"],
      "patterns": ["raises", "series a", "/\\bseed (round|funding)\\b/"], "note": "", "source": "manual" }
  ]
}
```

A plain pattern matches whole words, case-insensitively; `/like this/` is a regular expression. `fields` is `title`, `domain` or both. `source` is `manual`, `drafted` (by the model from your words), `suggested` (from stories you dismissed: 3 from one site, or 4 sharing a title word) or `imported`. Drafted, suggested and imported groups arrive switched off.

## Digest (from likes only)

Pages 1 to `pages` are read once a day, the first time the browser starts (or on request). The digest then uses nothing but your likes:

- **Look again** (spaced repetition): each like carries `review: { step, due, stopped?, done?, last? }`. A new like is due 1 day later; *Still useful* moves to the next gap of 1, 3, 7, 16, 35, 90 and 180 days (after the last it is done); *Remind me tomorrow* sets due to a day from now; *Stop reminding* stops it; *Unlike* removes the like. A like made before 0.5 is due a day after it was made.
- **Today, because you liked…**: for each story not liked and not the thread a like came from: the liked item sharing the most weight of title words (each word weighted `log(1 + likes / likes using it)`, divided by max(3, title words); two shared words needed for titles of four or more words), up to 0.6; a liked site, 0.1 per like up to 0.25; tags your likes carry, 0.1 each up to 0.3. Shown at 0.2 or more, best 12.
- **Everything you liked**: stories, comments and links, each grouped by its first tag, else the thread (comments) or site.

No model is used.

## Summary (`hamsa.summary/2`)

`gist`, `relevance_note`, `points[claim, why_relevant, basis, refs]`, `disagreements[question, sides[position, best_case, refs]]`, `corrections[claim, correction, refs]`, `links[url, why, ref]`. Limits are enforced after the call: refs that do not exist are dropped, points without a valid ref are removed, and over-long fields are cut. Each result records the provider's exact token counts, Hamsa's estimate before the call, the cost, and the scoring-rules version.

## Reading log (`hamsa.reading/1`)

Kept in this browser only, and off in settings if you prefer. `readingLog` holds up to 5000 opens: `{ at, kind: story | thread | link | strand, id, title, url, domain, tags, score, bucket, rules, page, background, strand }`; for a strand you opened, `strand` is `{ kind, label, terms }`. `opened` holds the derived signals: site counts, up to 400 opened titles as terms, and tag counts. `impressions` holds the last 3000 stories you were shown with what Hamsa scored.

The JSONL export has one object per line: for each story shown, `{ schema, id, title, url, domain, points, comments, tags, score, bucket, rules, first_seen, times_seen, opened, opened_story, opened_thread, dismissed }`, then one row for each opened link that was never on a front page. Shown-but-not-opened rows are the negatives a local model needs.

## Likes and dislikes (`hamsa.prefs/1`)

`{ schema, items: { "<hn id>" | "link:<url>": { v: like | dislike, kind: story | comment | link, title, domain, tags, at, source: you | hn, url?, threadId?, threadTitle?, author?, excerpt?, links?, points?, site?, review? } } }`, up to 5000 items. A link's key is its address without the fragment or a trailing slash. A choice you made (`you`) is never replaced by one read from HN (`hn`): stories with HN's "unvote" link, comments with "unvote" (like) or "undown" (dislike).

## Backup and sync (`hamsa.backup/1`)

`{ schema, app_version, exported_at, includes_keys, settings, blocklist, prefs, dismissed, opened, teach: { adj, muted }, providers: [{ name, kind, baseUrl, models, knownModels, apiKey? }], raindropToken?, reading_log?, impressions? }`. Keys appear only when asked for. Restoring merges: likes by item (newest wins, yours beat HN's), blocklist groups by name, dismissals and the reading log joined, providers by name and base URL (a local key is kept), topic boosts and mutes applied to the graph (or held until the next sync builds one). The provider and model chosen in this browser are never carried over.

- **File**: the backup as one JSON file.
- **Firefox Sync** (`storage.sync`): the backup without keys, reading log or impressions, cut into items of at most 7,800 bytes (UTF-8, as Firefox counts them) under `hamsa:0..n` with `hamsa:meta` (which carries this browser's `deviceId`, so its own push is not pulled back); the oldest likes, opened titles and dismissals are trimmed until it fits 95,000 bytes. Pushed 8 seconds after a change, pulled at start-up and whenever Firefox Sync brings a newer copy.

## HN history (`hamsa.history/1`, off by default)

Through the public Algolia HN Search API (`hn.algolia.com/api/v1`): read only, no key, no cookies, its own optional permission. Per thread:

| Part | Request | Kept |
|---|---|---|
| Same link | stories whose url matches this story's url | 7 days |
| Similar threads | stories with more than 50 comments matching up to 5 words: the title's distinctive words and the top word of the two largest strands | 1 day |
| Earlier on HN | comments matching a strand's top 3 words, only when you press the button | 1 day |

Re-score, because keyword search is noisy: `score = min(1, 0.18 x words shared with this thread + sum over your tags that fire of min(0.4, weight x activation))`. Similar threads and earlier comments under 0.2 are dropped; same-link results are always kept. At most 6 stories and 4 comments are shown. Text from Algolia is shown as plain text; links are rebuilt from ids.

## Health (`hamsa.health/1`)

Counted in the background page's memory and saved with other writes: the work per page (from the moment HN's pages are in hand to the page drawn, so network time is not counted; last 50 pages), writes per hour to storage and to IndexedDB, requests per host per day (and failures), and background wake-ups per day. Status:

| | Watch from | Slow from |
|---|---|---|
| Work per page (median, 7 days) | 300 ms | 800 ms |
| Writes per hour, either store | 60 | 240 |
| Requests per host per day | 600 | 2000 |

Each line crossed is shown with the switch that fixes it. Lightest mode sets previews off, karma off, HN history off and one front page.

## Link previews

`previews`: `{ "<url>": { p: { url, final, title, description, image, icon, site, published, author, kind: page | article | paper | video | pdf | image, doi } or { url, error }, at } }`, up to 1500, kept 14 days (failures 1 day). Read from at most the first 512 KB of HTML (stopping once the head has closed past 32 KB), 6 second timeout, no cookies. Needs the optional `<all_urls>` permission; `settings.previews` and `settings.previewImages` switch them and their pictures off.

## Storage keys

`storage.local` (small; Firefox sends its changes to every open HN tab, so nothing large or frequent lives here): `settings` (theme and reading options, layer, order, scoring, sources, hnUser, gate, karma, linkTarget, threadView, threadSort, collapseTossed, readingLog, previews, previewImages, provider choice), `providers`, `teach` (`{ adj, muted }`: what you taught the graph; synced and backed up), `profile`, `blocklist`, `dismissed`, `prefs`, `importedItems`, `raindropToken`, `usage` (per model), `usageDaily` (per day, 60 days), `errors` (the last 30 problems), `syncInfo`, `deviceId` (tells this browser's Firefox Sync pushes from others), `hnLogin` (`{ user, pass, auto, status, at }`; never synced, backed up or exported), `hnAuto` (`{ auto, status }`: what HN pages read, without the password). Settings added in 0.7: `hnHistory`, `mutedKinds`.

IndexedDB `hamsa`, store `kv` (background page only, written at most every 1.5 seconds): `graph` (`hamsa.graph/1`), `karma` (user to karma and time, at most 6000; fetched on threads only), `previews`, `impressions`, `readingLog`, `opened`, `cache` (summaries, 60 newest), `topics` (topic memory), `digest`, `visits` (highest comment id seen per thread, 500 threads), `history` (HN history answers, 200 threads), `health` (counters). Data from 0.5 moves here on first start.
