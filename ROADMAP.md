# Roadmap

Hamsa stays small on purpose. Every feature has to make the cheap, explainable layer sharper, add as little attack surface as possible, and never slow the browser it runs in. None may need a server, an account or telemetry. Hacker News is the only site Hamsa is built for; literature aggregation (PubMed and journals) is a separate project with its own relevance problem.

## 0.6: lighter, sharper, self-updating (done)

Large data in IndexedDB, an inverted-index engine with identical scores, interests that fade slowly, thumbs that teach, automatic HN login, self-updating builds, the Kshira palette.

## 0.7: reading a thread well (this release)

- **Strands**: the conversations inside a thread, with a kind and a colour, a reader that shows one strand in thread order, a summary of one strand, Markdown export, and `[` `]` to step through them. Kinds you never want can be hidden.
- **New since your last visit**, from the highest comment id you saw.
- **HN history** through the Algolia HN search, off until you switch it on: same link, similar threads, earlier comments on a strand.
- **Health**: work per page, writes, requests per site, wake-ups; Healthy, Watch or Slow with the fix; Lightest mode.
- **Smaller surface**: the GitHub gist backup, the browser-history source and front-page karma requests are gone.

## 0.8: learning from what you read

- A **small logistic model** trained in the browser on the reading log: stories shown against stories opened, and now strands opened. It starts from the hand-set weights and takes over only as evidence builds; every weight stays visible in "Why this score".
- **Tune the keep line on your own data**: the reading log export already holds what is needed; the settings page would suggest a keep line that gives the number of keeps a day you ask for.
- **Strand names from a model**, optional: one cheap call per thread with only each strand's top words.

## 1.0: the engine as a module

The relevance engine and strands split out as a standalone module with frozen, versioned schemas (`hamsa.graph`, `hamsa.score`, `hamsa.prefs`, strands), so other projects can import them.

## Deliberately not planned

Chat with a thread, a server, user accounts, telemetry, an AMO listing, adapters for other sites. Each adds code and failure modes without adding judgement.
