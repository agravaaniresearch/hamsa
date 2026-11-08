# Hamsa

Relevance-first summaries of long Hacker News threads, as a Firefox sidebar.

1. **Clean (no model).** The thread is fetched fresh from HN and cleaned deterministically: dead and deleted rows, heavily downvoted comments, flame chains (A B A B A), short replies without evidence, and finally anything over the token budget, lowest priority first. Ranking reuses HN Companion's score maths.
2. **Rank against you (no model).** Comments are scored against a graph built from your Raindrop tags, bookmark titles and highlights. Format tags (essay, news, longform) and years are ignored. Muted tags push comments down.
3. **Summarise (one call, your key).** The cleaned thread goes to the provider and model you choose, with a fixed schema and hard limits (about 250 words). Every point says why it matters to you and cites comment numbers that are checked against the real thread.

There is no voting. You teach it through tag chips (boost, mute), through saving a point to Raindrop, and, if you switch it on, optional thumbs.

## Providers

OpenAI-compatible (OpenAI, DeepSeek, xAI, Qwen, Mistral, Groq, Together, Fireworks, OpenRouter, Ollama, LM Studio, custom URL), Anthropic native, and Gemini native. Keys stay in `storage.local`. A cost estimate in rupees shows before each run.

## Layout

- `extension/lib`: `parse`, `prune`, `render`, `thread` (cleaning), `graph` (tag-graph relevance), `summarise`, `providers`, `pricing`, `raindrop`, `store`
- `extension/background.js`: all network calls and state changes
- `extension/sidebar`, `extension/options`, `extension/content`
- `test`: `npm test`
- `scripts/compare.mjs`: offline check of the scorer on a saved thread (your bookmark data stays in `fixtures/private/`, which is git-ignored)

## Build and release

`npm ci && npm test && npm run lint`. Pushing to `main` runs `.github/workflows/release.yml`, which signs an unlisted XPI with Mozilla and publishes it as a release. Add `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` as repository secrets.

## Works with Modern for Hacker News

Hamsa never reads the rendered page for content. It adds one button and scrolls to a comment by its element id; everything else comes from a fresh fetch of the thread. If the restyle drops the id, the cited number opens the comment on HN in a new tab instead.
