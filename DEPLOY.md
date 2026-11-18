# Deploying Hamsa

Everything an engineer needs to test, sign and ship a build. Nothing here needs a server.

## Requirements

- Node 22 and npm.
- Mozilla add-on API credentials (addons.mozilla.org → Tools → Manage API Keys): a JWT issuer (`user:…`) and a JWT secret. Never commit them.

## Test

```sh
npm ci
npm test        # parse-checks every script, then all unit and end-to-end tests (fake browser, fake IndexedDB)
npm run lint    # Mozilla's add-on linter, self-hosted mode (the manifest carries an update_url)
```

To try the add-on unsigned: `npx web-ext run --source-dir extension` (Firefox Developer Edition or Nightly), or load `extension/manifest.json` from `about:debugging` → This Firefox → Load Temporary Add-on.

## Release

1. Bump `version` in `extension/manifest.json` (and `package.json`). Mozilla never signs the same version twice.
2. Add a section for the version at the top of `CHANGELOG.md`.
3. Sign and stage the release, either:
   - **on your computer**: put the keys in a file outside the repository, one per line as `AMO_JWT_ISSUER=…` and `AMO_JWT_SECRET=…`, then run `node scripts/release.mjs --env /path/to/amo.env`; or
   - **on GitHub**: add the repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` once, then Actions → *Test, and sign on request* → *Run workflow*.
4. Either way the result is `releases/hamsa-<version>.xpi` (signed, unlisted) and a new `updates.json`. On your computer, commit both and push to `main`; GitHub does this itself. The *Publish signed release* workflow then creates the GitHub release with the changelog section as its notes.

## Updates reach installed copies by themselves

The manifest's `update_url` points to `updates.json` on `main`. Firefox checks it about once a day (or at once from `about:addons` → gear → *Check for Updates*) and installs the newer signed XPI, verified by its SHA-256 hash. Copies installed before 0.6 have no `update_url` and need 0.6 installed by hand once.

## Permissions

Always: `storage` and `unlimitedStorage` (so Firefox never evicts the tag graph), and the hosts `news.ycombinator.com` and `api.raindrop.io`. Author karma comes from HN's public API (`hacker-news.firebaseio.com`), which answers any site, so it needs no permission. Asked for only when you switch the feature on: `bookmarks` (browser bookmarks as interests), all sites (link previews), your AI provider's address (when you test a key), `hn.algolia.com` (HN history). Removed in 0.7: `history`, and GitHub hosts.

## Where data lives

| Place | What | Synced or backed up |
|---|---|---|
| `storage.local` | settings, providers and keys, blocklist, likes (`prefs`), dismissals, `teach`, profile, usage, errors | settings, blocklist, likes, dismissals and teach (keys only in a file backup, if asked) |
| `storage.local` → `hnLogin` | HN user name and password for automatic login | never |
| IndexedDB `hamsa` | tag graph, karma, previews, impressions, reading log, summaries, topics, digest, opened, visits, HN history, health counters | reading log and opened in file backups |

## Failure modes and what they look like

| Failure | Effect | Where it shows |
|---|---|---|
| Background page asleep at first load | page retries for about 4 seconds | rarely a "could not load" card with *Try again* |
| HN layout change | front page or thread falls back to plain HN | Settings → Recent problems |
| HN rate limit (503) while reading extra pages | one retry, then fewer pages merged | the lede says how many pages were read |
| HN captcha on automatic login | automatic login stops until you log in by hand once | Settings → Sources badge |
| Provider key or model wrong | summary card shows the provider's error | Recent problems |
| Algolia unreachable or rate-limited (HN history on) | no "Before this thread" panel; one error in Recent problems | Recent problems, Health (failed requests) |
| Hamsa doing too much work | Health shows Watch or Slow with the cause | Settings, Health and activity |
| Mozilla signing rejects a build | `scripts/release.mjs` stops with the validation messages; nothing is committed | terminal or Actions log |
