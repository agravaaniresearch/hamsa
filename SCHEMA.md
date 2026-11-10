# Schemas and rules

Everything on this page runs on your computer with no model. A model is called only for a thread summary you ask for, or to draft blocklist rules from your own words.

## The 0 to 1 score (`hamsa.score/1`, rules v0.3)

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
| `history` | You often read this site (3 or more visits) | 0.08 x min(1, log2(1 + visits) / 5) |
| `fav` | Like an HN favourite (2 or more shared title words, overlap 0.3 or more) | 0.15 |
| `opened` | You open stories from this site (n) | 0.1 x min(1, log2(1 + n) / 3) |
| `opened` | Like a story you opened (as for favourites) | 0.12 |
| `opened` | You often open stories tagged X (2 or more opens) | 0.05 x min(1, log2(1 + n) / 3) |
| `muted` | Muted tag | -0.3 |
| `block` | Blocked: group (pattern). Forces toss unless the score is at least `blockOverrideAt` (0.75) | 0 |

Ties within a bucket are broken by Hacker News' published gravity, `(points - 1) / (hours + 2)^1.8` ([how it works](https://medium.com/hacking-and-gonzo/how-hacker-news-ranking-algorithm-works-1d9b0cf2c08d)), then HN's rank.

**Duplicate submissions**: the same link (host without `www.`, path without a trailing slash, tracking parameters such as `utm_*` removed; arXiv abs and pdf links treated as one; YouTube by video id), or titles sharing 3 or more words with an overlap of 0.6 or more. The best-voted submission leads, takes the best bucket of the group, and lists the others.

A title fires a tag when every word of the tag's name is in the title, or when an anchor term and a second term of the tag both appear. Titles are scored on an absolute scale, so a story scores the same on any page.

With no interests synced, every story sits in maybe with a note; nothing is ranked.

### Stretch slice (things you do not know yet)

Among tossed stories with no tag match, not blocked and not dismissed: at least 40 points and 25 comments, and a comment-to-point ratio between 0.25 and 2.5 (a higher ratio usually means an argument). Ranked by `log(1 + comments)`, times 1.25 for a site you have never saved and 1.15 for a ratio of 0.6 or more. One pick per `stretchPerKeeps` keeps (4), at least 1, at most `stretchMax` (3). A stretch pick carries its own reasons and score.

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
9. `duplicate`: two comments whose word 3-gram sets overlap by 0.5 or more (each with 6 or more 3-grams). The one ranked higher by HN stays and lists the other. Then stretch picks (top-level, no tag, 60 or more words, evidence, HN score 800 or more; at most 3), then `below_floor`: comments in the toss bucket are held back from the model. **Minimum survivors**: if fewer than max(15, 8 percent of the thread) comments survive, the held-back comments with the best quality return as maybe.
10. `budget`: lowest priority first until under the token budget. Priority = HN score x (1 + 0.8 x relevance) x OP 1.3 x evidence 1.15 x rebuttal 1.5.

Rules 3 to 8 and `duplicate` are the crust and mark a comment `removed`. Rules 9 and 10 only keep a comment away from the model; it stays on the page with its bucket. Rebuttals, and the comments they answer (and the OP), are exempt from rules 5 to 9; rules 1, 3 and 4 still apply, and the budget cuts them only as a last resort (priority x 1.5).

**Rebuttal**: a reply to someone else whose text (after any quotes) opens with a disagreement ("No,", "Actually", "That's not true", "I disagree"...) or says so in its first 30 words, and carries evidence or 40 or more words.

**Funnel** shown on every thread: comments in thread, after crust removal, after tag match, sent to the model.

**Views**: Survivors lists keep, stretch, maybe and protected comments (no duplicates), ordered Best, Relevance or Thread order, with each rebuttal placed directly under the comment it answers. Tree shows the thread in place; everything hidden sits in a fold that says why, and *Collapse tossed threads* removes the folds.

## Relevance graph (`hamsa.graph/1`)

- Built from items with tags and text: Raindrop bookmarks (with highlights when switched on), browser bookmark folders (each folder on the path is a tag) and imported bookmark files. Stored as raw counts so each save updates it incrementally.
- A tag fires on a comment only when one of its anchor terms (its own name, or a term found under at most three tags) appears together with at least one more of its recurring terms. Terms must recur in two or more items under the tag.
- Tag weight favours specific tags: `ln(N / count) / ln(N)`, damped for tags used fewer than 4 times. Tags used fewer than 4 times are not scored.
- Activation spreads along co-occurrence edges (40 percent of the neighbour's, capped). Muted tags subtract. Per-tag adjustments from feedback multiply the weight by `exp(adj)`, limited to +-2.

## Interest profile (`hamsa.profile/1`)

`{ domains, histDomains, fav, sources, built_at }`: sites you bookmarked (all sources), sites you read often (browser history, opt-in, last 90 days, never leaves the browser), and the titles of your HN favourites and upvoted stories as stemmed terms. `sources` records the item count and sync time for each source.

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

## Daily digest

Pages 1 to `pages` (4) are fetched once a day, the first time the browser starts, scored as above and grouped: two stories join when a tag fired on both titles, or they share two or more title words with an overlap of 0.3 or more. A group is labelled by its shared tags (or shared words) and ranked by its best story. No model is used.

## Summary (`hamsa.summary/2`)

`gist`, `relevance_note`, `points[claim, why_relevant, basis, refs]`, `disagreements[question, sides[position, best_case, refs]]`, `corrections[claim, correction, refs]`, `links[url, why, ref]`. Limits are enforced after the call: refs that do not exist are dropped, points without a valid ref are removed, and over-long fields are cut. Each result records the provider's exact token counts, Hamsa's estimate before the call, the cost, and the scoring-rules version.

## Reading log (`hamsa.reading/1`)

Kept in this browser only, and off in settings if you prefer. `readingLog` holds up to 5000 opens: `{ at, kind: story | thread | link, id, title, url, domain, tags, score, bucket, rules, page, background }`. `opened` holds the derived signals: site counts, up to 400 opened titles as terms, and tag counts. `impressions` holds the last 3000 stories you were shown with what Hamsa scored.

The JSONL export has one object per line: for each story shown, `{ schema, id, title, url, domain, points, comments, tags, score, bucket, rules, first_seen, times_seen, opened, opened_story, opened_thread, dismissed }`, then one row for each opened link that was never on a front page. Shown-but-not-opened rows are the negatives a local model needs.

## Storage keys

`settings` (theme and reading options, layer, order, scoring, sources, hnUser, gate, karma, linkTarget, threadView, threadSort, collapseTossed, readingLog, provider choice), `providers`, `graph`, `profile`, `blocklist`, `dismissed`, `importedItems`, `raindropToken`, `cache` (summaries, 60 newest), `usage` (per model), `usageDaily` (per day, 60 days), `digest`, `karma` (user to karma and time), `readingLog`, `opened`, `impressions`, `errors` (the last 30 problems).
