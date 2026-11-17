# Roadmap

Hamsa stays small on purpose: every feature has to make the cheap, explainable layer sharper, and none may need a server, an account or telemetry. The order below is the order of value per line of code.

## 0.6 (this release): lighter, sharper, self-updating

- **Lighter.** The relevance engine looks up only the tags that share a word with a comment (an inverted index), with identical scores. Large data (the tag graph, caches, the reading log) lives in IndexedDB, so Firefox no longer copies megabytes into every open HN tab on each change. What you teach Hamsa is stored apart from the graph, so a thumb writes a few hundred bytes. The digest is built when you open it, not at every browser start.
- **Relevance v0.6.** Learning that saturates instead of pinning a tag after a few thumbs, interests that fade slowly with age, a sharper novelty measure for Discover, calibrated lines. Every formula is in SCHEMA.md.
- **HN auto-login**, with the password kept only in this browser.
- **Self-updating**: Firefox installs new signed builds itself through `updates.json`.
- **Kshira**: a new palette (jade-white, pond ink, lotus) and a heat strip for relevance.

## 0.7: reading

- **New since your last visit**: comments that appeared since you last opened a thread, marked and listed first. Seen comment ids are kept compactly per thread.
- **Discussed before**: earlier HN threads on the same link, through the HN Algolia API, with their size and year.
- **Author cards** on hover: karma, account age, the "about" line, cached like karma is today.
- **Read later**: a queue in the browser, shown in the digest, with nothing synced unless you choose to.
- **Reader view** of a linked article (Mozilla Readability, bundled), with a summary only on request.

## 0.8: learning from what you actually do

- A **small logistic model** trained in the browser on the reading log (stories shown against stories opened). It starts with the hand-set weights as its prior and takes over only as evidence accumulates. Every weight stays visible in "Why this score".
- An export of what it learned, so it can be inspected or used to seed a local model.

## 0.9: beyond Hacker News

- **Source adapters** with the same engine and buckets: Lobsters, arXiv listings, PubMed (E-utilities) and RSS through Miniflux. This is the bridge to the Pravaha reader and to literature aggregation.

## 1.0: the engine as a module

- The relevance engine split out as a standalone module with frozen, versioned schemas (`hamsa.graph`, `hamsa.score`, `hamsa.prefs`), so other projects (Pravaha, Nikasha, Sutradhar) can import it.

## Deliberately not planned

Chat with a thread, a server, user accounts, telemetry and an AMO listing. Each adds code and failure modes without adding judgement.
