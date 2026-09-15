# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [Unreleased]

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
