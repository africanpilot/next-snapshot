# Contributing

Thanks for looking. next-snapshot is small and has no build step: the source
in `cli.mjs` and `lib/` is what runs.

## Setup

```bash
git clone https://github.com/africanpilot/next-snapshot
cd next-snapshot
npm ci
```

You need Node 22 or later and Google Chrome (or set `browser.executablePath`
in a config to another Chromium).

## Tests

```bash
npm test            # unit + end-to-end against the fixture site (~20 s)
npm run test:unit   # pure functions only, no browser (~1 s)
npm run test:e2e    # capture, bundle and use the fixture site offline
npm run test:next   # a real Next.js App Router app — installs Next into
                    # test/fixtures/next-app on first run (slow; needs network)
```

`test/fixtures/site/` is a tiny server that behaves, where it matters to this
tool, like a Next.js app: router navigation that falls back from an RSC request
to a full navigation, `replaceState` tabs, a select that navigates, runtime
script loading, a redirect, a POST form. When you fix a bug, add the behaviour
that exposed it to the fixture and a test that fails without the fix.

## Style

- Plain modern JavaScript, ES modules, no transpiler. The runtime files in
  `lib/runtime/` run in the browser and are injected as text: keep them free of
  imports and of the character sequence that closes a `<script>` element.
- Comments say *why*. The code says what.
- Keep dependencies at two. A third needs a good reason.

## Pull requests

One change per pull request, with tests. CI must pass. Describe what the change
does for someone snapshotting their app, not only what it does to the code.

## Releasing (maintainer)

1. Move the `Unreleased` notes in `CHANGELOG.md` under the new version.
2. `npm version patch|minor` — bumps, commits and tags.
3. `git push --follow-tags` — the `v*` tag runs `.github/workflows/release.yml`,
   which tests and **stages** the version on npm with provenance, through
   trusted publishing. Staged means it exists in the registry but nobody can
   install it.
4. Approve it, which is what publishes it:
   ```bash
   npm stage list                 # find the stage id
   npm stage view <stage-id>      # what is in it
   npm stage approve <stage-id>   # asks for your passkey; now it is live
   ```
   `npm stage reject <stage-id>` throws it away instead.

The approval step is deliberate: no token and no workflow can publish a version
on its own — a person has to be present. Run it in a real terminal, since the
passkey prompt needs one.
