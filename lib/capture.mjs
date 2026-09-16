// Crawl the running app in headless Chrome and record what a browser receives:
// the HTML of every page, and every asset and client-side GET it triggers.
//
// Output is a directory: manifest.json (what was seen, keyed by urlKey) and
// bodies/<sha> (content-addressed, so a chunk shared by every page and a page
// identical across variants are each stored once).
//
// The crawl is read-only by construction: every request that is not GET, HEAD
// or OPTIONS is aborted before it leaves the browser. Only a variant's `login`
// hook, which runs before that guard is installed, can write.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fss from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { launch } from "./browser.mjs";
import { urlKey } from "./key.js";

const FILE_EXT = /\.(pdf|csv|tsv|xlsx?|docx?|pptx?|zip|gz|tgz|json|txt|xml|png|jpe?g|gif|svg|webp|avif|ico|mp4|webm|mp3|wav)$/i;

const MIME = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
};

export function mimeFor(p) {
  return MIME[path.extname(p.split("?")[0]).toLowerCase()] ?? "application/octet-stream";
}

export async function capture(cfg, log) {
  const { origin } = cfg;
  // Every URL the browser reports goes through here, so a redirect to another
  // spelling of the same host (localhost vs 127.0.0.1) keys as the same page.
  const canon = (u) => {
    for (const a of cfg.aliases) if (u === a || u.startsWith(a + "/") || u.startsWith(a + "?")) return origin + u.slice(a.length);
    return u;
  };
  const keyOf = (u, base = origin) => {
    let abs;
    try {
      abs = new URL(String(u), base).href;
    } catch {
      return null;
    }
    return urlKey(canon(abs), origin, origin);
  };
  const bodiesDir = path.join(cfg.captureDir, "bodies");
  await fs.mkdir(bodiesDir, { recursive: true });

  async function put(buf) {
    const sha = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 32);
    const f = path.join(bodiesDir, sha);
    if (!fss.existsSync(f)) await fs.writeFile(f, buf);
    return sha;
  }

  const M = {
    version: 1,
    tool: "next-snapshot",
    origin,
    createdAt: new Date().toISOString(),
    title: cfg.title,
    variants: cfg.variants.map((v) => ({ id: v.id, label: v.label })),
    defaultVariant: cfg.defaultVariant,
    start: keyOf(cfg.start),
    pages: {}, // variant -> key -> {body,status} | {redirect} | {file}
    assets: {}, // key -> {body,type,status}   shared by every variant
    variantAssets: {}, // variant -> key -> {body,type,status}   API/data responses
    blocked: [], // non-GET requests the guard stopped
    failures: [], // navigations that failed outright
    liveErrors: [], // errors the *live* app threw — not the tool's fault
    rscSkipped: 0,
  };
  for (const v of cfg.variants) {
    M.pages[v.id] = {};
    M.variantAssets[v.id] = {};
  }

  const allowed = (k) =>
    !!k && k.startsWith("/") && !cfg.exclude.some((re) => re.test(k)) && (!cfg.include || cfg.include.some((re) => re.test(k)));
  const discovered = new Set();
  const discover = (k) => {
    if (allowed(k) && !discovered.has(k)) {
      discovered.add(k);
      return true;
    }
    return false;
  };
  for (const s of cfg.seeds) discover(keyOf(s));
  discover(M.start);

  const pending = new Set();
  const track = (p) => {
    // Caught here: an unhandled rejection from a background body read (a full
    // disk, too many open files) would otherwise end the whole crawl silently.
    const q = p.catch((e) => log(`  warn: recording a response failed: ${e.message}`));
    pending.add(q);
    q.finally(() => pending.delete(q));
  };

  const browser = await launch(cfg);
  const sessions = {};
  const t0 = Date.now();

  try {
    // Every variant must answer for every URL any variant found: a URL one role
    // can open is a URL another role may be redirected away from, and that
    // redirect is part of what the snapshot has to reproduce.
    for (;;) {
      let progressed = false;
      for (const v of cfg.variants) {
        const s = (sessions[v.id] ??= await openSession(v));
        const todo = [...discovered].filter((k) => !s.visited.has(k));
        if (!todo.length) continue;
        progressed = true;
        await crawl(s, todo);
      }
      if (!progressed) break;
    }
    for (const s of Object.values(sessions)) {
      for (const k of s.files) if (!M.variantAssets[s.v.id][k] && !M.assets[k]) await fetchFile(s, k);
    }
    await Promise.allSettled([...pending]);
  } finally {
    await browser.close();
  }

  // The build output, so chunks the crawl never triggered are in the file too.
  // In Docker it lives inside the container; copy it out first.
  let staticDir = cfg.staticDir;
  if (cfg.docker?.container) staticDir = copyFromContainer(cfg, log) ?? staticDir;
  if (cfg.includeStatic && staticDir && fss.existsSync(staticDir)) {
    const n = await addDir(staticDir, cfg.staticPrefix, Infinity);
    log(`static: +${n} build files from ${path.relative(process.cwd(), staticDir)}`);
  }
  if (cfg.publicDir && fss.existsSync(cfg.publicDir)) {
    const n = await addDir(cfg.publicDir, "/", cfg.maxPublicFileBytes);
    if (n) log(`public: +${n} files from ${path.relative(process.cwd(), cfg.publicDir)}`);
  }

  await fs.writeFile(path.join(cfg.captureDir, "manifest.json"), JSON.stringify(M, null, 1));
  summarise(M, log, Date.now() - t0);
  return M;

  // ---------------------------------------------------------------------------

  async function openSession(v) {
    const context = await browser.newContext({
      viewport: cfg.viewport,
      serviceWorkers: "block",
      ignoreHTTPSErrors: true,
      locale: cfg.locale,
      timezoneId: cfg.timezoneId,
    });
    if (v.login) {
      log(`[${v.id}] login`);
      await v.login({ context, request: context.request, origin });
    }
    await context.route("**/*", (route) => {
      const req = route.request();
      const m = req.method();
      if (m === "GET" || m === "HEAD" || m === "OPTIONS") return route.continue();
      M.blocked.push({ variant: v.id, method: m, url: req.url() });
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    const s = {
      v,
      context,
      page,
      visited: new Set(),
      rsc: new Set(),
      files: new Set(),
      explored: new Set(),
      // Keys a tab click produced. In "url" mode they are not explored again:
      // their tab strip leads back to pages already captured, and re-clicking
      // it on every one of them is what turns this from linear into expensive.
      fromTabs: new Set(),
      current: null,
    };
    context.on("response", (res) => track(onResponse(s, res)));
    // A click that opens a window must not leave a second crawler behind.
    context.on("page", (p) => {
      if (p !== s.page) p.close().catch(() => {});
    });
    page.on("pageerror", (e) => {
      if (M.liveErrors.length < 200) M.liveErrors.push({ variant: v.id, key: s.current, message: e.message.split("\n")[0] });
    });
    return s;
  }

  async function crawl(s, queue) {
    let count = Object.keys(M.pages[s.v.id]).length;
    while (queue.length) {
      const key = queue.shift();
      if (s.visited.has(key)) continue;
      if (count >= cfg.maxPages) {
        log(`[${s.v.id}] maxPages (${cfg.maxPages}) reached; ${queue.length} URL(s) left unvisited`);
        for (const k of queue) s.visited.add(k);
        break;
      }
      const found = await visit(s, key);
      count = Object.keys(M.pages[s.v.id]).length;
      for (const k of found) if (discover(k)) queue.push(k);
      // Found by another variant earlier, but not yet visited by this one.
      for (const k of found) if (discovered.has(k) && !s.visited.has(k) && !queue.includes(k)) queue.push(k);
    }
  }

  async function visit(s, key) {
    const { page, v } = s;
    const P = M.pages[v.id];
    s.visited.add(key);
    s.current = key;
    const started = Date.now();
    let resp;
    try {
      resp = await page.goto(origin + key, { waitUntil: "load", timeout: cfg.navTimeoutMs });
    } catch (e) {
      if (/Download is starting|net::ERR_ABORTED/.test(e.message)) {
        await fetchFile(s, key);
        P[key] = { file: key };
        return [];
      }
      M.failures.push({ variant: v.id, key, message: e.message.split("\n")[0] });
      log(`[${v.id}] FAIL ${key}: ${e.message.split("\n")[0]}`);
      return [];
    }
    if (!resp) return [];

    const chain = [];
    for (let r = resp.request().redirectedFrom(); r; r = r.redirectedFrom()) chain.push(keyOf(r.url()));
    const finalKey = keyOf(resp.url());
    const type = resp.headers()["content-type"] ?? "";
    const isHTML = /html/i.test(type);

    if (isHTML) {
      P[finalKey] = { body: await put(await resp.body()), status: resp.status() };
    } else {
      const body = await resp.body().catch(() => null);
      if (body) M.variantAssets[v.id][finalKey] = { body: await put(body), type, status: resp.status() };
      P[finalKey] = { file: finalKey };
    }
    for (const k of chain) {
      if (k && k !== finalKey && !P[k]?.body) P[k] = { redirect: finalKey };
      if (k) s.visited.add(k);
    }
    if (finalKey !== key && !P[key]?.body) P[key] = { redirect: finalKey };
    s.visited.add(finalKey);
    const note = finalKey !== key ? ` -> ${finalKey}` : "";
    log(`[${v.id}] ${resp.status()} ${key}${note}  ${Date.now() - started}ms`);

    if (!isHTML || !finalKey.startsWith("/")) return [];

    await settle(page);
    const found = new Set();
    const after = keyOf(page.url());
    if (after && after !== finalKey) found.add(after); // client-side redirect

    const links = await page
      .evaluate(() =>
        [...document.querySelectorAll("a[href], area[href]")].map((a) => ({ href: a.href, download: a.hasAttribute("download") })),
      )
      .catch(() => []);
    for (const l of links) {
      const k = keyOf(l.href);
      if (!k || !k.startsWith("/")) continue;
      if (l.download || FILE_EXT.test(k.split("?")[0])) s.files.add(k);
      else found.add(k);
    }
    for (const k of s.rsc) found.add(k); // Next prefetched it, so the app links to it
    s.rsc.clear();

    if (cfg.explore.selects) for (const k of await exploreSelects(s, finalKey)) found.add(k);
    if (cfg.explore.tabs || cfg.explore.click.length) for (const k of await exploreClicks(s, finalKey)) found.add(k);
    if (cfg.explore.custom) {
      await cfg.explore.custom({
        page,
        key: finalKey,
        variant: v.id,
        origin,
        discover: (u) => {
          const k = keyOf(u, origin + finalKey);
          if (k) found.add(k);
        },
      });
    }
    return [...found];
  }

  async function settle(page) {
    await page.waitForLoadState("networkidle", { timeout: cfg.idleTimeoutMs }).catch(() => {});
    if (cfg.settleMs) await page.waitForTimeout(cfg.settleMs);
  }

  // A <select> that drives the URL (router.push/replace on change) is the
  // common way a Next page exposes views that links never mention. Try each
  // option once per (page path, select); a URL change is a page to capture.
  async function exploreSelects(s, key) {
    const { page } = s;
    const found = new Set();
    const pathOnly = key.split("?")[0];
    const sels = page.locator("select:visible");
    const count = await sels.count().catch(() => 0);
    let navigatedAway = false;

    for (let i = 0; i < count; i++) {
      if (navigatedAway) {
        await page.goto(origin + key, { waitUntil: "load", timeout: cfg.navTimeoutMs }).catch(() => {});
        await settle(page);
        navigatedAway = false;
      }
      const sel = sels.nth(i);
      let meta;
      try {
        meta = await sel.evaluate((el) => ({
          id: el.name || el.id || el.getAttribute("aria-label") || "",
          value: el.value,
          options: el.disabled ? [] : [...el.options].filter((o) => !o.disabled).map((o) => o.value),
        }));
      } catch {
        continue;
      }
      const sig = `${pathOnly}::${i}:${meta.id}`;
      if (s.explored.has(sig)) continue;
      s.explored.add(sig);

      for (const val of meta.options.slice(0, cfg.explore.maxOptions)) {
        if (val === meta.value) continue;
        if (navigatedAway) {
          await page.goto(origin + key, { waitUntil: "load", timeout: cfg.navTimeoutMs }).catch(() => {});
          await settle(page);
          navigatedAway = false;
        }
        try {
          await sels.nth(i).selectOption(val, { timeout: 3000 });
          await page.waitForTimeout(150);
          await settle(page);
          const k = keyOf(page.url());
          if (k && k !== key) {
            found.add(k);
            navigatedAway = true;
          }
        } catch {
          navigatedAway = true;
        }
      }
    }
    // Hand the page back where it was found: tab exploration and custom
    // discovery run next, and must run on this page, not the last option's.
    if (navigatedAway) {
      await page.goto(origin + key, { waitUntil: "load", timeout: cfg.navTimeoutMs }).catch(() => {});
      await settle(page);
    }
    if (found.size) log(`[${s.v.id}]   selects on ${key}: ${found.size} URL(s)`);
    return found;
  }

  // Tab strips that write the URL — router.replace, or history.replaceState for
  // a tab that never asks the server — expose views that no link names.
  // Candidates: [role=tab], the configured `explore.click` selectors, and
  // "button bars" (an element whose children are two or more buttons and
  // nothing else), which is how most tab strips are built without ARIA.
  //
  // `explore.tabs: true` clicks each label once per page *path*: cheap, but a
  // route whose pages differ by query (?programme=…) then holds tab views for
  // only the first of them. `"url"` clicks each label once per captured page,
  // so every programme gets every tab — pages, and file size, multiply by the
  // number of tabs.
  async function exploreClicks(s, key) {
    const { page } = s;
    const found = new Set();
    const perUrl = cfg.explore.tabs === "url";
    if (perUrl && s.fromTabs.has(key)) return found;
    const scope = perUrl ? key : key.split("?")[0];
    const tag = () =>
      page
        .evaluate(
          ({ tabs, extra, deny }) => {
            const denyRe = new RegExp(deny, "i");
            const picked = new Set();
            if (tabs) {
              document.querySelectorAll('[role="tab"]').forEach((el) => picked.add(el));
              document.querySelectorAll("button").forEach((b) => {
                const p = b.parentElement;
                if (!p || b.form) return;
                const kids = [...p.children];
                if (kids.length >= 2 && kids.every((k) => k.tagName === "BUTTON")) picked.add(b);
              });
            }
            for (const sel of extra) document.querySelectorAll(sel).forEach((el) => picked.add(el));
            const labels = [];
            for (const el of picked) {
              if (!(el.offsetParent || el.getClientRects().length)) continue;
              if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
              const label = (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 80);
              if (!label || denyRe.test(label)) continue;
              el.setAttribute("data-no-explore", label);
              labels.push(label);
            }
            return [...new Set(labels)];
          },
          { tabs: !!cfg.explore.tabs, extra: cfg.explore.click, deny: cfg.explore.denyText.source },
        )
        .catch(() => []);

    const labels = (await tag()).slice(0, cfg.explore.maxClicks);
    let dirty = false;
    for (const label of labels) {
      const sig = `${scope}::click:${label}`;
      if (s.explored.has(sig)) continue;
      s.explored.add(sig);
      if (dirty) {
        await page.goto(origin + key, { waitUntil: "load", timeout: cfg.navTimeoutMs }).catch(() => {});
        await settle(page);
        dirty = false;
      }
      await tag(); // the page may have re-rendered since
      try {
        await page.locator(`[data-no-explore=${JSON.stringify(label)}]`).first().click({ timeout: 3000 });
        await page.waitForTimeout(150);
        await settle(page);
        const k = keyOf(page.url());
        if (k && k !== key) {
          found.add(k);
          s.fromTabs.add(k);
          dirty = true;
        }
      } catch {
        dirty = true;
      }
    }
    if (dirty) {
      await page.goto(origin + key, { waitUntil: "load", timeout: cfg.navTimeoutMs }).catch(() => {});
      await settle(page);
    }
    if (found.size) log(`[${s.v.id}]   tabs on ${key}: ${found.size} URL(s)`);
    return found;
  }

  async function onResponse(s, res) {
    const req = res.request();
    if (req.method() !== "GET") return;
    const url = res.url();
    const key = keyOf(url);
    if (!key) return;
    const status = res.status();
    if (status >= 300 && status < 400) return;
    if (req.isNavigationRequest() && req.frame() === s.page.mainFrame()) return; // pages come from visit()

    const headers = res.headers();
    const type = headers["content-type"] ?? "";
    const rh = req.headers();
    if (rh.rsc === "1" || type.startsWith("text/x-component") || /[?&]_rsc=/.test(url)) {
      M.rscSkipped++;
      if (key.startsWith("/")) s.rsc.add(key);
      return;
    }
    if (/\/_next\/webpack-hmr|\/__nextjs/.test(url)) return;

    let body;
    try {
      body = await res.body();
    } catch {
      return;
    }
    const entry = { body: await put(body), type: type || mimeFor(key), status };
    const dynamic =
      key.startsWith("/") &&
      !key.startsWith(cfg.staticPrefix) &&
      (["fetch", "xhr", "eventsource"].includes(req.resourceType()) || key.startsWith("/api/"));
    if (dynamic) M.variantAssets[s.v.id][key] = entry;
    else if (!M.assets[key] || M.assets[key].status >= 400) M.assets[key] = entry;
  }

  async function fetchFile(s, key) {
    try {
      const r = await s.context.request.get(origin + key, { maxRedirects: 5 });
      if (!r.ok()) return;
      const type = r.headers()["content-type"] ?? mimeFor(key);
      M.variantAssets[s.v.id][key] = { body: await put(await r.body()), type, status: r.status() };
      log(`[${s.v.id}] file ${key}`);
    } catch (e) {
      M.failures.push({ variant: s.v.id, key, message: `file: ${e.message.split("\n")[0]}` });
    }
  }

  async function addDir(dir, prefix, maxBytes) {
    let n = 0;
    for (const f of await walk(dir)) {
      const rel = path.relative(dir, f).split(path.sep).join("/");
      const key = prefix + rel;
      if (M.assets[key]) continue;
      const st = await fs.stat(f);
      if (st.size > maxBytes) continue;
      M.assets[key] = { body: await put(await fs.readFile(f)), type: mimeFor(f), status: 200, fromDisk: true };
      n++;
    }
    return n;
  }
}

/**
 * `docker cp <container>:<staticPath>` into the capture directory. Returns the
 * local path, or null with a warning — a missing build is worth saying out
 * loud, but it does not stop a capture that is otherwise fine.
 */
function copyFromContainer(cfg, log) {
  const { container, staticPath } = cfg.docker;
  const dest = path.join(cfg.captureDir, "docker-static");
  // Ours, written by the previous run: `docker cp` nests into a directory that
  // already exists, which would bury the files a level deeper each time.
  fss.rmSync(dest, { recursive: true, force: true });
  const r = spawnSync("docker", ["cp", `${container}:${staticPath}`, dest], { encoding: "utf8" });
  if (r.error?.code === "ENOENT") {
    log(`  warn: docker is not installed, so ${container}:${staticPath} could not be copied`);
    return null;
  }
  if (r.status !== 0) {
    log(`  warn: docker cp ${container}:${staticPath} failed — ${(r.stderr || "").trim().split("\n")[0]}`);
    log(`  warn: continuing without the build output; lazily-loaded chunks may be missing offline`);
    return null;
  }
  log(`docker: copied ${container}:${staticPath}`);
  return dest;
}

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile() && !e.name.endsWith(".map")) out.push(p);
  }
  return out;
}

function summarise(M, log, ms) {
  log("");
  log(`capture finished in ${(ms / 1000).toFixed(1)}s`);
  for (const v of M.variants) {
    const P = Object.values(M.pages[v.id]);
    const html = P.filter((e) => e.body).length;
    const red = P.filter((e) => e.redirect).length;
    log(`  ${v.id.padEnd(22)} ${String(html).padStart(4)} pages  ${String(red).padStart(4)} redirects  ${Object.keys(M.variantAssets[v.id]).length} data responses`);
  }
  log(`  shared assets: ${Object.keys(M.assets).length}   RSC payloads skipped: ${M.rscSkipped}`);
  // An app that is answering with error pages captures perfectly happily; say
  // so, or the snapshot looks complete and is a book of 500s.
  const errorPages = M.variants.flatMap((v) => Object.entries(M.pages[v.id]).filter(([, e]) => e.body && e.status >= 400));
  if (errorPages.length) {
    log(`  WARNING: ${errorPages.length} captured page(s) are error responses — e.g. ${errorPages[0][1].status} ${errorPages[0][0]}`);
  }
  if (M.blocked.length) log(`  blocked ${M.blocked.length} non-GET request(s) — the crawl never writes`);
  if (M.failures.length) log(`  ${M.failures.length} navigation failure(s): ${M.failures.slice(0, 3).map((f) => f.key).join(", ")}`);
  if (M.liveErrors.length) log(`  the LIVE app threw ${M.liveErrors.length} error(s) during capture (first: ${M.liveErrors[0].message})`);
}
