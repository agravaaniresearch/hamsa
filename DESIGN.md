# Design

Hamsa is the swan said to separate milk from water (nira-kshira-viveka). It separates what matters to you on Hacker News from what does not, before any model sees a word. Hacker News is the test bed: the same engine is meant to run later over journal feeds and PubMed abstracts, by swapping the sources and the parsers.

## Principles

1. **Rules first, model last.** Cleaning, relevance and ranking are deterministic and free. The model is called only when you press Summarise, and only on what survived.
2. **Nothing is deleted.** Every story and comment lands in a bucket with the reason it landed there. Removed and held-back items are logged and can be shown again.
3. **The score always travels with its reasons.** A 0 to 1 number is never shown alone; one tap shows every signal and its points.
4. **Recall over precision in the cheap layer.** Rebuttals deep in a chain are protected, a strong match overrides a block, and a Discover section is reserved for things outside your tags.
5. **Your sources, your keys.** Interests come from your own bookmarks, tags, favourites and, if you allow it, history. Keys stay in the browser.

## Flow

| Level | What happens | Model |
|---|---|---|
| Front page | Pages 1 to 5 merged into one list; every story scored on its title, site and your favourites; blocklist applied; Discover first, then keep and maybe; toss hidden behind a chip | none |
| Thread | Every page of the thread read; crust removed (dead, downvoted, abusive, flame chains, meta, quote-only, short); comments scored against your tags; off-topic comments held back; the tree redrawn with folds that say what was hidden and why | none |
| Summary | One call with your key on the comments that passed; tokens sent and received, and the cost, shown on the card and added to today's total in the header | on request |
| Digest | Once a day: the front pages scored and grouped into topics, Discover and keep first | none |

## Reading a thread

The default is to scroll through what survives: keep, discover and maybe comments in one column, best first, each reply saying what it answers, and each rebuttal sitting directly under the comment it answers. Every comment folds to a line; j and k move, c collapses. The tree view is there to see the thread in place, with folds that say what was hidden and why, or with the tossed folds collapsed away.

## Buckets

- **Keep**: score at or above the keep line.
- **Maybe**: matches your interests weakly. Held, and re-scored whenever your tags or rules change.
- **Discover**: new to you, and worth a look by HN's own signals. This is the real keep: what you would not have found yourself. It leads the page.
- **Toss**: below the floor, blocked, or dismissed by you. Hidden, logged, restorable.
- **Removed** (comments only): crust. Shown on request from the fold where it was cut.

## Interest sources

Raindrop (tags, highlights), browser bookmarks (folders as tags), HN favourites and upvoted stories, browser history (sites only, opt-in), and any exported bookmarks file. Each source only has to supply titles, links and, where it has them, tags. Adding a service means adding one connector that returns that shape.

## Blocklist

An open JSON file anyone can edit, share and import. Groups switch on and off as a whole. Rules can be written by hand, drafted by the model from a plain description, or suggested from what you dismiss; drafted and suggested rules stay off until you approve them, and a test button shows what each group would have blocked on today's front page.

## Learning from what you open

Opening a story, a thread or a link is the cheapest honest signal there is. Hamsa remembers it in the browser, uses it straight away (sites you open, titles like ones you opened, tags you click), and exports it with everything you were shown as one JSON line per story, so a small local model can later be tuned on your own choices.

## Taste, and taking it with you

Thumbs on any story or comment, and your own HN votes, teach Hamsa your taste in this browser. Everything you set and taught it is one open JSON format: a file you can keep, Firefox Sync for every Firefox you use, or a private GitHub gist for anywhere else. Keys stay out unless you put them in.

## Interface

One extension owns both the reading layout and the filtering (replacing Modern for Hacker News and the earlier sidebar), so selectors stay stable. The header keeps HN's navigation and adds today's token total, the digest, the theme button (Auto, Light, Dark, as in Parshva), the original HN view and settings. The palette is warm paper and rust, with no blue; dark comes in warm charcoal, neutral grey and black. Five bundled fonts, text size, width, justified text and density follow Modern for Hacker News, and a skin themes the HN pages Hamsa does not redraw.

## Open questions

- The ceiling of the 0 to 1 scale and the keep and maybe lines are starting values. They need tuning on real threads with real interests.
- Rebuttal detection is keyword-based and will miss polite disagreement.
- Karma and HN position stand in for comment votes, which HN does not publish.
- HN favourites and upvotes are read from HN pages, which can change without notice.

See SCHEMA.md for every rule, weight and file format.
