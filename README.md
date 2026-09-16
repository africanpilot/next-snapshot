# next-snapshot

Capture a running Next.js app and bundle it into **one HTML file** that opens
from disk — double-click, `file://`, network off — and still behaves like the
app: client components run, links and router navigation work, selects and tabs
work, and every page shows the data it showed when captured.

## Install

Requires **Node 22+** and **Google Chrome** (or any Chromium — see `browser`
below). Run it without installing:

```bash
npx @africanpilot/next-snapshot all --config my-app.config.mjs --screens
```

or add it to a project, where the command is `next-snapshot`:

```bash
npm install --save-dev @africanpilot/next-snapshot
npx next-snapshot all --config my-app.config.mjs
```

Write a config for your app, starting from
[`examples/basic.config.mjs`](https://github.com/africanpilot/next-snapshot/blob/main/examples/basic.config.mjs)
(or [`roles.config.mjs`](https://github.com/africanpilot/next-snapshot/blob/main/examples/roles.config.mjs)
for an app with sign-in). The commands:

```bash
next-snapshot all     --config my-app.config.mjs   # capture, bundle, verify
next-snapshot capture --config my-app.config.mjs   # crawl the app (starts it if configured)
next-snapshot bundle  --config my-app.config.mjs   # capture dir -> one .html
next-snapshot verify  --config my-app.config.mjs   # open the .html offline, check it
```

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
| `aliases` | loopback spellings | Other origins that are the same app (a canonical host it redirects to); URLs on them are treated as the app's own. `localhost`, `127.0.0.1`, `[::1]` and `0.0.0.0` on the same port are always aliases of each other. |
| `docker` | — | `{ container, staticPath }` — the app runs in a container, so copy its build output here with `docker cp` before bundling. `staticPath` defaults to `/app/.next/static`. See [Docker](#an-app-running-in-docker). |
| `out` | `./<name>.html` | Output file. The capture directory, bundle report, verify report and screenshots sit next to it. |
| `title` | — | Title shown while the file opens. |
| `start` | `/` | Page to open when the file has no hash. |
| `seeds` | `["/"]` | Where the crawl starts. Add any URL links and selects do not reach. |
| `exclude`, `include` | `/_next/`, `/api/` excluded | Regexes on the path+query key. |
| `maxPages` | 500 | Per variant. |
| `variants` | one | `[{ id, label, login({context, request, origin}) }]`. One crawl per variant; the file can switch between them. |
| `defaultVariant` | first | |
| `explore.selects` | `true` | Try each option of each visible `<select>` once per page path. |
| `explore.tabs` | `true` | Click each tab-like control and capture the URL it writes (router push/replace, or a bare `history.replaceState`). Candidates: `[role=tab]`, and "button bars" — an element whose children are two or more buttons and nothing else. `true` clicks each once per page **path**; `"url"` clicks each once per captured **page**, so a route whose pages differ by query (`?programme=…`) gets every tab for every one of them. `"url"` multiplies that route's pages by the number of tabs — use it when clicking through the app moves between a tab and a query at the same time. |
| `explore.click` | `[]` | Extra CSS selectors to click the same way. |
| `explore.denyText` | sign out, delete, approve, submit, save… | Controls whose label matches are never clicked. Writes are blocked at the network anyway; this protects the session and client-side state. |
| `explore.custom` | — | `async ({page, key, variant, discover}) => {}` for app-specific discovery (clicking tabs that change the URL, etc). |
| `offline.post` | `{}` | `{ "/path": (fields, {variant, key}) => ({ variant?, location?, message? }) }` — emulate a POST in the browser. Must be an arrow or `function` expression; it is serialised into the file. Any POST without a handler is refused as read-only. |
| `offline.css` | `""` | CSS added to every page — for hiding what has no meaning offline (a sign-out button, a user menu). |
| `offline.missingLinks` | `"show"` | Links to pages the snapshot does not hold: `"show"` (they open a "not in snapshot" page), `"disable"` (dimmed, not clickable) or `"hide"`. With `include` narrowing the crawl, `"hide"` removes the nav entries for everything left out. |
| `offline.badge` | `"bottom-right"` | The "Offline snapshot" pill; `false` to hide. |
| `offline.switcher` | `true` | A variant `<select>` in the badge. |
| `compress` | `"gzip"` | How pages are packed. `"gzip"` stores each page on its own, decoded by the browser itself. `"zstd"` sorts pages by route, packs them into clusters of `clusterBytes` and compresses each cluster as one stream, inlining an 8 KB decoder — far smaller for an app with many similar pages. See [Size](#size-and-compression). |
| `clusterBytes` | 4 MB | Raw bytes of pages per cluster, with `compress: "zstd"`. Bigger is smaller, but the first page of each cluster takes longer to open. |
| `includeStatic` | `true` | Also embed every file under `.next/static`, so lazily-loaded chunks the crawl never triggered are present. |
| `viewport`, `locale`, `timezoneId`, `browser` | | Passed to Chrome. `browser.executablePath` if Chrome is not installed. |

## Size and compression

Pages of an app repeat each other: the same layout, nav and table shell, over
and over. By default each page is gzipped on its own, which cannot exploit that
— gzip looks only 32 KB back, and a page's near-twin is further away than that.
For a handful of pages this costs nothing worth fixing.

For an app with hundreds of pages, `compress: "zstd"` sorts pages by route,
packs them into clusters and compresses each cluster as one stream, so the
repetition is paid for once:

```js
export default {
  // …
  compress: "zstd",
  clusterBytes: 4 * 1024 * 1024,   // the default
};
```

On a 260-page report app, measured: **12.4 MB → about 2 MB**. The cost is an
8 KB decoder inlined in the file, and tens of milliseconds to open the first
page of a cluster; pages in an already-decoded cluster are free. Assets stay
per-page gzip either way, since they are wanted all at once at startup and are
mostly already-compressed formats.

Why not brotli, which is smaller still: Chrome cannot decompress brotli from
JavaScript (`DecompressionStream` has no brotli there, and no zstd anywhere), so
it would mean inlining a 208 KB decoder to save about 10%.

## An app running in Docker

The tool drives Chrome on your machine, so it reaches the container the same way
your browser does. Start the app with its port published — `docker run -p
3000:3000 …`, or `ports: ["3000:3000"]` in compose — and point `url` at it:

```js
export default {
  name: "my-app",
  url: "http://localhost:3000",
  docker: { container: "my-app" },   // `docker ps` shows the name
  seeds: ["/"],
};
```

`docker` copies the build output out of the container with `docker cp`, so
chunks that only load later — a modal, a menu — are in the file too. Without it
the snapshot holds only what the crawl happened to load. If your image puts the
app somewhere other than `/app`, set `staticPath` to match. A failed copy is a
warning, not an error: the capture continues without it.

Redirects to `0.0.0.0` need nothing extra. Next's images set
`HOSTNAME=0.0.0.0`, and an app that builds absolute URLs from it redirects
there; `0.0.0.0` on the same port is already an alias of the origin. For any
other host it redirects to, add it to `aliases`.

## What it cannot do

- **Anything not captured is not there.** A URL no link, prefetch, select or tab
  led to shows a "not in this snapshot" page listing what was captured. Add it to
  `seeds`, or teach `explore.custom` how to reach it. One exception: a URL the
  app writes itself while you use the file (a tab calling `replaceState`) is
  remembered, and returning to it re-serves the page it came from at that URL.
- **Exploration is one option at a time.** Each select option and each tab is
  tried once per page path, from the first URL of that path the crawl reached —
  not every combination. `explore.tabs: "url"` covers the common case (every
  tab of every page of a route); for anything else, seed the combinations you
  need. A URL that was never captured shows a "not in this snapshot" page.
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

## Security

A config is code: `app.build`, `app.start`, `login` hooks and `explore.custom`
run with your privileges. A snapshot contains every page it captured, and the
API responses those pages fetched, for every variant — treat it like access to
the app, and check what is in it before sharing. Replayed pages run in a
sandboxed frame so that content the app never trusted cannot carry the snapshot
anywhere. See [SECURITY.md](SECURITY.md), including how to report a
vulnerability.

## Development

`npm test` runs the unit and end-to-end suites; `npm run test:next` snapshots a
real Next.js app. See [CONTRIBUTING.md](CONTRIBUTING.md). What might come next,
and what was deliberately ruled out, is in [docs/ROADMAP.md](docs/ROADMAP.md).

## License

MIT — see [LICENSE](LICENSE).
