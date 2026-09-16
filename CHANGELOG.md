# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [Unreleased]

### Added

- `compress: "zstd"` packs pages into clusters — sorted by route, compressed as
  one stream each — instead of gzipping every page on its own. Pages of an app
  repeat each other and gzip's 32KB window cannot see past one page, so a big
  app paid for its layout once per page. Measured on a 260-page report app:
  12.4 MB to about 2 MB. Costs an 8 KB inlined decoder (fzstd) and tens of
  milliseconds for the first page of each cluster; `clusterBytes` (4 MB by
  default) trades size against that. The default stays `"gzip"`, which is
  unchanged and needs no decoder.

## [0.1.2] — 2026-09-15

### Added

- `docker: { container, staticPath }` copies a containerised app's build output
  out with `docker cp` before bundling, so chunks that load later are in the
  file. A failed copy warns and carries on.
- `0.0.0.0` on the app's port is now a default alias of its origin, alongside
  `localhost`, `127.0.0.1` and `[::1]`. Next's Docker images set
  `HOSTNAME=0.0.0.0`, and pages an app redirects there were being treated as
  another site.

### Changed

- "Nothing is answering at …" now also says to publish the port when the app
  runs in Docker.
- Releases are staged rather than published by CI: the workflow runs
  `npm stage publish`, and a maintainer approves it with 2FA. No workflow and
  no token can ship a version without a person present.

## [0.1.1] — 2026-09-15

### Added

- `explore.tabs: "url"` clicks each tab on every captured page of a route,
  rather than once per route. Without it, a route whose pages differ by query
  (a programme picker, say) holds tab views only for the first of them, so
  clicking from a list straight into another page's tab lands on "not in this
  snapshot". Pages a tab click produced are not explored again, so the cost is
  one pass per page rather than a combinatorial one.

## [0.1.0] — 2026-09-15

First release.

### Added

- `capture`: crawls a running Next.js app in headless Chrome, once per variant
  (for example per role), recording each page's HTML, every asset and client
  GET, and every redirect. Follows links, the URLs Next prefetches, and the
  URLs that `<select>`s and tab strips write. Every non-GET request is blocked.
- `bundle`: one HTML file with a Content-Security-Policy that forbids the
  network. `location` is virtualised in the app's scripts; assets become
  `blob:` URLs; each page boots in a fresh frame.
- `verify`: opens the file from `file://` with the network off, checks pages
  load and hydrate, clicks through links, and reports anything that tried to
  reach the network.
- Offline behaviour: link, router and select navigation; back/forward and deep
  links through the address-bar hash; `fetch`/XHR from the snapshot; POSTs
  refused as read-only unless `offline.post` emulates them; URLs the app writes
  itself (a `replaceState` tab) served from the page they came from, across a
  reload.
- Config: variants with `login` hooks, `seeds`/`include`/`exclude`,
  `explore.selects`/`tabs`/`click`/`custom`, `offline.css`,
  `offline.missingLinks`, loopback `aliases`.
