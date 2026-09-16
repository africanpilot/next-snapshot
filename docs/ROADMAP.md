# Roadmap

What could come next, roughly in the order I'd do it. Each item says why it
matters, what it costs, and how we'd know it worked — an item nobody can
measure is an item nobody should start.

Shipped work lives in [CHANGELOG.md](../CHANGELOG.md). This file is for what
hasn't happened yet, including the things we decided *not* to do and why.

---

## P0 — next

### 1. Release the containment fix
A published version (0.2.0) lets captured content carry the snapshot to a
server; `main` fixes it by sandboxing the replay frame. Until that ships,
everyone using the tool has the hole.
**Cost:** a release. **Done when:** 0.2.1 is on npm with provenance.

### 2. Make capture fast — harder than it looks
Measured on a 273-page app: 12.5 minutes, of which **page loads were 4%**. The
rest is the tool waiting, or navigating back to where it was. That measurement
still stands. What does not stand is the conclusion I drew from it.

**Three changes were tried and all three were reverted**, because each changed
*what the crawl captured*:

| Attempt | Time | Pages | What happened |
|---|---|---|---|
| Baseline | 753 s | 273 | — |
| `settleMs`→0, `quietMs` 150 instead of `networkidle`, no navigating back between tab clicks | 130 s | 195 | Lost 78 pages: whole tab families for the non-default fiscal years |
| …with the `fromTabs` guard removed | 274 s | 170 | Captured 28 programmes for **FY2023 instead of FY2026** |
| Only the two waiting changes | 657 s | 192 | Still the wrong year (FY2025), and barely faster |

**The lesson.** None of this is "timing" in isolation. Exploration reads the
page's current state — which tabs exist, what each select is set to, which page
the next exploration starts from. Shortening a wait changes what the app has
finished doing when we read it; not navigating back changes where we read it
from. Both silently produce a *different, plausible-looking* capture. The clock
was never the test: **the page set is**.

**So, before any further speed work:**
1. Make the page set a test. Capture RADAR twice with the same config and
   assert identical manifests; then no change can quietly alter the result.
2. Only then measure `settle` directly — time every call, per visit and per
   explored option — rather than inferring the total by arithmetic, which is
   how I got a ~415 s estimate that the runs did not bear out.
3. Treat concurrency as the same class of risk, not an exception: parallel
   pages would share exactly the state that broke here, so each would need its
   own context, and the page set must be identical afterwards.

**Done when:** a capture is meaningfully faster **and** its manifest matches the
baseline key for key.

### 3. Make a big snapshot navigable
273 pages and the only way through them is whatever the app links to.
- **Page browser**: an overlay listing every captured page, grouped by route
  and variant.
- **Search**: a full-text index built at bundle time from page text.
Both are cheap given the format, and they change a snapshot from an archive
into something a stakeholder can use.
**Done when:** you can find a programme by name in RADAR without knowing the
route. Watch the index's weight — it must stay a small fraction of the file.

### 4. Say what the file is
The badge shows a date. It should open a panel: captured when, from which
origin, app build id, pages captured, **pages missing**, variants, tool
version — and the same as machine-readable JSON for anything archival.
**Done when:** someone handed the file cold can answer "what is this and is it
complete" without asking us.

---

## P1 — soon

### 5. `next-snapshot init`, and first-run errors that help
Today you must hand-write a config before anything happens, and a missing
Chrome surfaces Playwright's own advice, which sends people to install the
wrong thing. `init` should detect the framework, port and routes and write a
starter config.
**Done when:** someone goes from `npx` to a snapshot without reading the README.

### 6. Redaction and marking
The output is "all your data in a file you email", with no way to strip a
column, mask figures, or stamp **CUI / Draft / Not for distribution** on every
page. Config: patterns or selectors, applied to captured HTML at bundle time;
a watermark as page CSS.
**Done when:** a snapshot can be shared with someone who may not see one of its
columns. Test that redacted text is absent from the *bytes*, not just hidden.

### 7. `login` with a saved session
The `login` hook can't handle SSO, MFA or a magic link. Playwright's
`storageState` can: a `next-snapshot login` command opens a visible browser,
you sign in by hand, it saves the session, captures reuse it.
**Done when:** an SSO app captures without writing a hook.

### 8. Demo mode for writes
Click Save in a demo and you get "read-only snapshot", which reads as a bug.
Optionally let a configured write update the UI optimistically and say
"demo — not saved".
**Done when:** a stakeholder can click through a form without it looking broken.

### 9. Cookies — decide, then act
`document.cookie` is always empty in a snapshot, and the jar is shared across
pages and variants. Apps that read cookies client-side (consent, theme, locale)
misbehave. Seeding from the capture would fix it **and put session cookies in a
file people email** — today they are deliberately not stored.
**Options:** per-variant jar only (fixes the bleed, no credentials); opt-in
`captureCookies`; or a filter (non-`HttpOnly`, allowlisted names).
**Done when:** decided and documented, whichever way.

### 10. Small correctness items from the review
- `srcset` without a space after the comma is mis-parsed; the naive fix breaks
  `data:` URIs, so parse candidates properly.
- Cluster cache is 3 entries — `verify --full` thrashes it across more.
- `soft` map grows unbounded and rewrites sessionStorage on every URL change.
- `maxPages` counts redirects and file entries, so a redirect-heavy site stops
  short of its real page budget.
- Back/forward re-renders from captured HTML instead of firing the app's
  `popstate` handler: document it, or handle it.

---

## P2 — worth doing, no urgency

### 11. Diff two snapshots
"What changed between Tuesday and Friday" — pages added, removed, numbers
moved. Nothing in this space does it, it falls out of having two
content-addressed captures, and it turns the tool from "make a demo" into
"watch an app over time". The most distinctive thing on this list, and the
largest.

### 12. PDF export
Selected pages to PDF via Chrome's print. The RADAR reports literally have
"Printable brief" and "Slide deck" tabs — the demand is visible in the app.

### 13. Other frameworks
Remix, Nuxt, SvelteKit, Astro, plain SPAs. Most of the machinery is not
Next-specific; only Next is tested. A fixture each would widen the audience.
**Done when:** the README can name them without hedging.

### 14. A GitHub Action
Snapshot each PR and attach the file. How this becomes routine rather than a
thing someone remembers to run.

### 15. Size budget
`--max-size` fails a build when a snapshot balloons. Cheap, and it belongs with
the Action.

### 16. Staleness check
Compare a snapshot against the live app and report which pages have drifted.
`verify` only checks the file against itself.

### 17. Passphrase encryption
AES-GCM via WebCrypto for a snapshot travelling on a USB stick. Only worth
doing properly — a weak version is worse than none, because people would trust
it.

### 18. Decompress in a Worker
Cluster decoding is on the main thread. A Worker would keep the page responsive
on the first open of a large cluster.

---

## Decided against, for now

- **Brotli instead of zstd.** ~10% smaller, but Chrome cannot decompress brotli
  from JavaScript (`DecompressionStream` has no brotli there, and no zstd
  anywhere), so it would mean inlining a 208 KB wasm decoder to save ~80 KB.
  Revisit if Chromium ships brotli in Compression Streams.
- **A 32 KB shared dictionary per page.** The zlib preset dictionary is capped
  at 32 KB, far below the repeated content; measured 8.17 MB against 8.52 MB.
- **Content-defined chunking / template extraction.** Both hand-reimplement,
  worse, what a large-window compressor does for free.
- **Multi-file output for huge apps.** Contradicts the one promise the tool
  makes. Clustering removed the pressure.
