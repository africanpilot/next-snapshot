# next-snapshot

Capture a running Next.js app and bundle it into **one HTML file** that opens
from disk — double-click, `file://`, network off — and still behaves like the
app: client components run, links and router navigation work, selects and tabs
work, and every page shows the data it showed when captured.

```bash
npm install                                   # playwright-core + esbuild, once
node cli.mjs all --config examples/basic.config.mjs --screens
open examples/out/my-app.html
```

Requires Node 20+ and Google Chrome (or any Chromium — see `browser` below).

`verify` checks a sample — two URLs per route per variant — unless given
`--full`. `--screens` saves a screenshot of each page it checks.

Two examples: `examples/basic.config.mjs` (start the app, crawl from a couple of
entry points) and `examples/roles.config.mjs` (every role as a variant, the
app's own sign-in screen as the switcher, a POST emulated offline).

## How it works

A Next app cannot simply be inlined: its pages are rendered by a server (server
components, cookies, redirects), its client fetches more from that server as you
navigate, and a `file://` page cannot `fetch`, cannot load module scripts from
disk, and cannot `pushState` to a new path. So the tool does not transform the
source. It **records the real app and replays it**.

1. **Capture** (`lib/capture.mjs`). Starts the app (`next start`), then crawls it
   in headless Chrome, once per *variant* (e.g. per role). It records the HTML of
   every page exactly as served, every asset and client GET the page triggers,
   and every redirect. It follows links, the URLs Next prefetches, and the URLs
   a `<select>` produces when changed. Every non-GET request is aborted in the
   browser, so the crawl cannot write to the app. Bodies are content-addressed,
   so a chunk shared by 200 pages is stored once.
2. **Bundle** (`lib/bundle.mjs`). Rewrites every `location` reference in the
   app's JS to a virtual location (esbuild `define`, so strings and local
   variables are untouched), turns asset URLs in HTML and CSS into tokens, and
   gzips + base64s every body into an inert `<script type="text/plain">`. One
   file out, with a Content-Security-Policy that forbids all network access.
3. **Replay** (`lib/runtime/`). The outer page decodes assets into `blob:` URLs
   and shows each page in a **fresh srcdoc iframe**. A shim runs first in every
   frame: it supplies the virtual `location`, answers `fetch`/XHR from the
   snapshot, maps runtime-created script/style/img URLs to their blobs (and
   reports the original back to chunk loaders that look themselves up), and
   intercepts links and forms. Next's RSC requests are deliberately answered
   with a non-RSC response: Next then falls back to a full navigation, which
   becomes a fresh frame of that page's captured HTML. Every navigation is
   therefore a clean boot of exactly what the server sent — no framework state
   to reconcile, no partial payloads to match.
4. **Verify** (`lib/verify.mjs`). Opens the file from `file://` with the network
   off, loads every captured page, checks that React hydrated, clicks a link on
   a few pages, and reports console errors, shim reports, and any attempt to
   reach the network.

The address bar hash carries the page: `my-app.html#editor:/reports?year=2026`
opens that page as that variant, and back/forward work.

## Config

A config is an ES module; relative paths resolve against it.

| key | default | |
|---|---|---|
| `app.cwd`, `app.start`, `app.build`, `app.port` | — | How to run the app. `{port}` is substituted into `start`. `build` runs when there is no `.next/BUILD_ID`, or with `--build`. Omit `app` and set `url` to capture a server you started yourself. |
| `url` | `http://localhost:{port}` | Origin to capture. `localhost`, because Next builds redirect URLs on it and a session cookie set on `127.0.0.1` is not sent to `localhost`. |
| `aliases` | loopback spellings | Other origins that are the same app (a canonical host it redirects to); URLs on them are treated as the app's own. `localhost`, `127.0.0.1` and `[::1]` are always aliases of each other. |
| `out` | `./<name>.html` | Output file. The capture directory, bundle report, verify report and screenshots sit next to it. |
| `title` | — | Title shown while the file opens. |
| `start` | `/` | Page to open when the file has no hash. |
| `seeds` | `["/"]` | Where the crawl starts. Add any URL links and selects do not reach. |
| `exclude`, `include` | `/_next/`, `/api/` excluded | Regexes on the path+query key. |
| `maxPages` | 500 | Per variant. |
| `variants` | one | `[{ id, label, login({context, request, origin}) }]`. One crawl per variant; the file can switch between them. |
| `defaultVariant` | first | |
| `explore.selects` | `true` | Try each option of each visible `<select>` once per page path. |
| `explore.tabs` | `true` | Click each tab-like control once per page path: `[role=tab]`, and "button bars" — an element whose children are two or more buttons and nothing else. A URL the click writes (router push/replace, or a bare `history.replaceState`) is captured. |
| `explore.click` | `[]` | Extra CSS selectors to click the same way. |
| `explore.denyText` | sign out, delete, approve, submit, save… | Controls whose label matches are never clicked. Writes are blocked at the network anyway; this protects the session and client-side state. |
| `explore.custom` | — | `async ({page, key, variant, discover}) => {}` for app-specific discovery (clicking tabs that change the URL, etc). |
| `offline.post` | `{}` | `{ "/path": (fields, {variant, key}) => ({ variant?, location?, message? }) }` — emulate a POST in the browser. Must be an arrow or `function` expression; it is serialised into the file. Any POST without a handler is refused as read-only. |
| `offline.css` | `""` | CSS added to every page — for hiding what has no meaning offline (a sign-out button, a user menu). |
| `offline.missingLinks` | `"show"` | Links to pages the snapshot does not hold: `"show"` (they open a "not in snapshot" page), `"disable"` (dimmed, not clickable) or `"hide"`. With `include` narrowing the crawl, `"hide"` removes the nav entries for everything left out. |
| `offline.badge` | `"bottom-right"` | The "Offline snapshot" pill; `false` to hide. |
| `offline.switcher` | `true` | A variant `<select>` in the badge. |
| `includeStatic` | `true` | Also embed every file under `.next/static`, so lazily-loaded chunks the crawl never triggered are present. |
| `viewport`, `locale`, `timezoneId`, `browser` | | Passed to Chrome. `browser.executablePath` if Chrome is not installed. |

## What it cannot do

- **Anything not captured is not there.** A URL no link, prefetch, select or tab
  led to shows a "not in this snapshot" page listing what was captured. Add it to
  `seeds`, or teach `explore.custom` how to reach it. One exception: a URL the
  app writes itself while you use the file (a tab calling `replaceState`) is
  remembered, and returning to it re-serves the page it came from at that URL.
- **Exploration is one option at a time.** Each select option and each tab is
  tried once per page path, from the first URL of that path the crawl reached —
  not every combination. Seed the combinations you need.
- **Writes.** Forms and fetches that POST/PUT/DELETE are refused unless an
  `offline.post` handler emulates them. Server Actions fail the same way.
- **Soft navigation.** Every navigation is a full page boot, so in-memory client
  state (a React context, an open panel) does not survive a page change.
  `localStorage` does, where the browser allows it on `file://`.
- **Size.** The file carries every page's HTML, including the data server
  components embedded in it. Pages that differ only a little still compress
  separately. Check the bundle report's "largest bodies".
- **Runtime URLs built inside CSS-in-JS** (`url()` in a style string set from
  JS) are not remapped; they are reported as blocked by `verify`.
- **Other frameworks.** Nothing here is Next-specific except the RSC fallback
  and the `.next/static` default; a plain SPA or a Remix/Nuxt app should capture,
  but only Next App Router is tested.

## License

MIT — see [LICENSE](LICENSE).
