// Load a config module and fill in every default, so the rest of the tool reads
// one fully-resolved object. Relative paths resolve against the config file.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function loadConfig(file) {
  if (!file) throw new Error("No config given. Pass --config path/to/app.config.mjs");
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`Config not found: ${abs}`);
  const mod = await import(pathToFileURL(abs).href);
  const raw = mod.default ?? mod;
  const dir = path.dirname(abs);
  const r = (p) => (p == null ? p : path.resolve(dir, p));

  const name = raw.name ?? path.basename(abs).replace(/\.config\.m?js$/, "").replace(/\.m?js$/, "");
  const app = raw.app ? { ...raw.app, cwd: r(raw.app.cwd ?? ".") } : null;
  const port = app?.port ?? 3217;
  // `localhost`, not 127.0.0.1: Next builds absolute redirect URLs from its own
  // idea of the host, and a cookie set on one loopback name is not sent to the
  // other — a sign-in that redirects across them loses its session.
  const origin = new URL(raw.url ?? `http://localhost:${port}`).origin;
  const o = new URL(origin);
  // 0.0.0.0 is here because of Docker: Next's own images set HOSTNAME=0.0.0.0,
  // and an app that builds absolute URLs from that redirects to 0.0.0.0:PORT.
  // Without the alias those pages look like a different site and are dropped.
  const loopback = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"];
  const aliases = [
    ...(loopback.includes(o.hostname) ? loopback.map((h) => `${o.protocol}//${h}${o.port ? ":" + o.port : ""}`) : []),
    ...(raw.aliases ?? []),
  ]
    .map((a) => new URL(a).origin)
    .filter((a) => a !== origin);
  const out = r(raw.out ?? `./${name}.html`);

  const variants = (raw.variants?.length ? raw.variants : [{ id: "default" }]).map((v) => ({
    label: v.id,
    ...v,
  }));
  const ids = new Set();
  for (const v of variants) {
    if (!/^[A-Za-z0-9_.-]+$/.test(v.id)) throw new Error(`Variant id "${v.id}" must be [A-Za-z0-9_.-]+`);
    if (ids.has(v.id)) throw new Error(`Duplicate variant id "${v.id}"`);
    ids.add(v.id);
  }

  const defaultStatic = app ? path.join(app.cwd, ".next", "static") : null;
  const defaultPublic = app ? path.join(app.cwd, "public") : null;

  return {
    name,
    file: abs,
    dir,
    app,
    origin,
    // Other origins that are the same app (loopback spellings, a canonical host
    // the app redirects to). URLs on them are keyed as if on `origin`.
    aliases,
    out,
    captureDir: r(raw.captureDir) ?? out.replace(/\.html?$/, "") + ".capture",
    title: raw.title ?? null,
    start: raw.start ?? "/",
    seeds: raw.seeds ?? ["/"],
    // Never crawled as pages. /_next is build output; /api is not a page, and a
    // GET to it can still have side effects. Add your own with `exclude`.
    exclude: [/^\/_next\//, /^\/api\//, ...(raw.exclude ?? [])],
    include: raw.include ?? null,
    maxPages: raw.maxPages ?? 500,
    navTimeoutMs: raw.navTimeoutMs ?? 60_000,
    idleTimeoutMs: raw.idleTimeoutMs ?? 8_000,
    settleMs: raw.settleMs ?? 300,
    explore: {
      selects: true,
      maxOptions: 40,
      // Click tab-like controls and record any URL they write. `true` clicks
      // each once per page path; "url" clicks each once per captured page, so
      // a route whose pages differ by query gets every tab for every one of
      // them — at the cost of multiplying pages by the number of tabs.
      tabs: true,
      // Extra CSS selectors to click the same way.
      click: [],
      maxClicks: 30,
      // Never clicked, whatever they look like. Writes are blocked at the
      // network regardless; this keeps client-side state (and the session) intact.
      denyText: /\b(sign ?out|log ?out|delete|remove|approve|reject|submit|save|release|publish|reset|clear|discard|revoke)\b/i,
      custom: null,
      ...(raw.explore ?? {}),
    },
    variants,
    defaultVariant: raw.defaultVariant ?? variants[0].id,
    // The app runs in a container: its build output is not on this disk, so
    // `docker cp` it out before bundling. `staticPath` is where the build lives
    // inside the image (Next's own Dockerfile puts it under /app).
    docker: raw.docker ? { staticPath: "/app/.next/static", ...raw.docker } : null,
    includeStatic: raw.includeStatic ?? true,
    staticDir: r(raw.staticDir) ?? defaultStatic,
    staticPrefix: raw.staticPrefix ?? "/_next/static/",
    publicDir: r(raw.publicDir) ?? defaultPublic,
    maxPublicFileBytes: raw.maxPublicFileBytes ?? 5 * 1024 * 1024,
    offline: {
      badge: "bottom-right",
      switcher: true,
      post: {},
      // CSS added to every page, for hiding what makes no sense offline.
      css: "",
      // Links to pages the snapshot does not hold: "show", "disable" or "hide".
      missingLinks: "show",
      ...(raw.offline ?? {}),
    },
    viewport: raw.viewport ?? { width: 1440, height: 900 },
    browser: raw.browser ?? {},
    locale: raw.locale ?? "en-US",
    timezoneId: raw.timezoneId,
  };
}
