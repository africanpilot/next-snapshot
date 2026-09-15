# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's
[private vulnerability reporting](https://github.com/africanpilot/next-snapshot/security/advisories/new)
(Security tab → "Report a vulnerability"). Do not open a public issue.

You can expect an acknowledgement within a week. Fixes are released as a new
version on npm, with the advisory published once users can update.

## Supported versions

next-snapshot is pre-1.0. Only the latest published version receives fixes.

## What the tool does, and what that means for you

next-snapshot is a development tool you run on your own machine, against your
own application. Knowing what it touches helps you judge its risk:

- **It runs your app.** `app.build` and `app.start` from your config are
  executed as shell commands, with your privileges. So are a variant's `login`
  hook and `explore.custom`: a config file is code. Only use configs you trust.
- **It drives a browser** — your installed Chrome, or a Chromium you point it
  at — against your app's origin. During the crawl every request that is not
  `GET`, `HEAD` or `OPTIONS` is aborted in the browser, so the crawl cannot
  write to your app. Only a `login` hook, which runs before that guard, can.
- **The output file contains your data.** A snapshot holds every captured page,
  including whatever data your server rendered into it and whatever the
  signed-in variants could see. Treat a snapshot exactly as you would treat
  access to the app itself, for every variant it contains.
- **The output file does not reach the network.** Its Content-Security-Policy
  refuses every network request, and `verify` fails if anything tries. It does
  run your app's own JavaScript, with `'unsafe-inline'` and `'unsafe-eval'`
  allowed so that the app can run as it did.
- **`offline.post` handlers** are serialised into the file and run in the
  viewer's browser. Keep them to emulating navigation (which variant, which
  page); do not put secrets in them.

## Supply chain

Releases are published from GitHub Actions with npm trusted publishing and
provenance, so each version on npm is linked to the commit and workflow that
built it. The package has two runtime dependencies, `playwright-core` and
`esbuild`.
