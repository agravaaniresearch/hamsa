# Schemas and rules

## Pruning order (deterministic, no model)
1. `unavailable`: dead, flagged, deleted or collapsed rows.
2. `downvoted`: 4 or more downvote shades (HN Companion's rule).
3. `flame_chain`: two authors alternating A B A B A for 5 or more turns. Kept: first, longest, OP, link or code, 100 or more words, or relevance 0.5 or more.
4. `short`: under 15 words, no link, code or number, not OP, no replies, relevance under 0.5.
5. `budget`: lowest priority first until under the token budget. Priority = HN score x (1 + 0.8 x relevance) x OP 1.3 x evidence 1.15.

HN score is `floor(1000 - rank x 1000 / N)` minus 10 percent per downvote shade, as in HN Companion. Comment paths such as `1.2.1` are assigned over all rows, so they stay stable when comments are pruned.

## Relevance (`hamsa.graph/1`)
- Built from items with tags and text (bookmarks): per-tag term counts, tag counts, tag co-occurrence. Stored as raw counts so each save updates it incrementally.
- A tag is activated by a comment only when one of its anchor terms (its own name, or a term found under at most three tags) appears together with at least one more of its recurring terms. Terms must recur in two or more items under the tag.
- Tag weight favours specific tags: `ln(N / count) / ln(N)`, damped for tags used fewer than 4 times. Tags used fewer than 4 times are not scored.
- Activation spreads along co-occurrence edges (40 percent of the neighbour's, capped). Muted tags subtract. Per-tag adjustments from feedback multiply the weight by `exp(adj)`, limited to +-2.
- In a thread of 20 or more comments the score is scaled against that thread (median to 95th percentile); smaller batches use an absolute yardstick. `abs` keeps the absolute value for thread-level relevance.

## Summary (`hamsa.summary/2`)
`gist`, `relevance_note`, `points[claim, why_relevant, basis, refs]`, `disagreements[question, sides[position, best_case, refs]]`, `corrections[claim, correction, refs]`, `links[url, why, ref]`. Limits are enforced after the call: refs that do not exist are dropped, points without a valid ref are removed, and over-long fields are cut.
