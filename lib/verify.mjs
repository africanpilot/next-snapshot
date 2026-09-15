// Open the bundled file the way a user would — file://, network off — and walk
// every captured page. For each: did it load, did React hydrate, what did the
// console and the shim report. Then click a link on a few pages to prove
// navigation works. Anything that tried to reach the network is a leak.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { launch } from "./browser.mjs";

export async function verify(cfg, opts, log) {
  const url = pathToFileURL(cfg.out).href;
  const browser = await launch(cfg);
  const shotsDir = cfg.out.replace(/\.html?$/, "") + ".screens";
  if (opts.screens) await fs.mkdir(shotsDir, { recursive: true });

  try {
    const context = await browser.newContext({ viewport: cfg.viewport, offline: true, serviceWorkers: "block" });
    const leaks = [];
    await context.route(
      (u) => !/^(file|blob|data|about):/.test(u.protocol),
      (r) => {
        leaks.push(r.request().url());
        return r.abort("internetdisconnected");
      },
    );
    const page = await context.newPage();
    let messages = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") messages.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => messages.push(`pageerror: ${e.message}`));

    const t0 = Date.now();
    await page.goto(url);
    await page.waitForFunction(() => window.__NO && window.__NO.ready, null, { timeout: 120_000 });
    await waitLoaded(page, 0);
    const bootMs = Date.now() - t0;
    log(`opened ${path.basename(cfg.out)} in ${bootMs}ms`);

    const all = await page.evaluate(() => window.__NO.listPages());
    let targets = all;
    if (opts.variant) targets = targets.filter((t) => t.variant === opts.variant);
    // By default, a sample: the first few URLs of each path per variant. Query
    // variants of one route run the same code; --full walks every page.
    if (!opts.full) {
      const seen = new Map();
      targets = targets.filter((t) => {
        const k = `${t.variant} ${t.key.split("?")[0]}`;
        const n = seen.get(k) ?? 0;
        seen.set(k, n + 1);
        return n < (opts.perPath ?? 2);
      });
    }
    if (opts.limit) targets = targets.slice(0, opts.limit);
    log(`checking ${targets.length} of ${all.length} pages${opts.full ? "" : " (a sample; --full for every page)"}`);

    const results = [];
    for (const t of targets) {
      messages = [];
      await page.evaluate(() => window.__NO.drainReports());
      const before = await page.evaluate(() => window.__NO.seq);
      const started = Date.now();
      await page.evaluate(([v, k]) => window.__NO.go(v, k), [t.variant, t.key]);
      const ok = await waitLoaded(page, before);
      await page.waitForTimeout(opts.settleMs ?? 700);
      const info = await page.evaluate(() => {
        const f = window.__NO.frame();
        const d = f && f.contentDocument;
        return {
          hydrated: window.__NO.hydrated(),
          reports: window.__NO.drainReports(),
          text: d && d.body ? d.body.innerText.trim().length : 0,
          title: d ? d.title : "",
        };
      });
      const r = { ...t, ok, ms: Date.now() - started, ...info, console: messages };
      results.push(r);
      const bad = r.reports.filter((x) => x.kind !== "write").length + r.console.length;
      log(`${ok ? (r.hydrated ? "ok " : "dry") : "ERR"} ${String(r.ms).padStart(5)}ms  ${t.variant.padEnd(20)} ${t.key}${bad ? `  (${bad} issue${bad > 1 ? "s" : ""})` : ""}`);
      if (opts.screens) {
        const name = `${t.variant}__${t.key.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 120) || "root"}.png`;
        await page.screenshot({ path: path.join(shotsDir, name) });
      }
    }

    // Navigation by clicking, which exercises the link/Link/router paths rather
    // than the shell's own loader.
    const clicks = [];
    const byVariant = new Map();
    for (const t of targets) {
      const list = byVariant.get(t.variant) ?? [];
      if (list.length < (opts.clicks ?? 3)) list.push(t);
      byVariant.set(t.variant, list);
    }
    for (const list of byVariant.values()) {
      for (const t of list) {
        const before0 = await page.evaluate(() => window.__NO.seq);
        await page.evaluate(([v, k]) => window.__NO.go(v, k), [t.variant, t.key]);
        await waitLoaded(page, before0);
        await page.waitForTimeout(400);
        const target = await page.evaluate(() => {
          const NO = window.__NO, d = NO.frame().contentDocument, cur = NO.loaded;
          for (const a of d.querySelectorAll("a[href]")) {
            const href = a.getAttribute("href");
            if (!href || href.startsWith("#") || !a.offsetParent) continue;
            const key = NO.key(new URL(href, d.baseURI).href);
            if (!key || !key.startsWith("/") || key === cur.key) continue;
            const expect = NO.resolve(cur.variant, key);
            if (expect === cur.key) continue;
            a.setAttribute("data-no-verify", "1");
            return { href, expect };
          }
          return null;
        });
        if (!target) continue;
        const before = await page.evaluate(() => window.__NO.seq);
        await page.frameLocator("iframe.no-frame:not(.loading)").locator('[data-no-verify="1"]').first().click({ timeout: 5000 }).catch(() => {});
        const ok = await waitLoaded(page, before, 15_000);
        const landed = await page.evaluate(() => window.__NO.loaded && window.__NO.loaded.key);
        const pass = ok && landed === target.expect;
        clicks.push({ from: t.key, variant: t.variant, href: target.href, expect: target.expect, landed, pass });
        log(`${pass ? "ok " : "ERR"} click  ${t.variant.padEnd(20)} ${t.key} → ${target.href}${pass ? "" : `  (landed on ${landed})`}`);
      }
    }

    // --- summary ------------------------------------------------------------------
    const issues = new Map();
    const add = (kind, text) => {
      const norm = `${kind}: ${text}`.replace(/blob:[^\s"')]+/g, "blob:…").replace(/\d{3,}/g, "#").slice(0, 220);
      issues.set(norm, (issues.get(norm) ?? 0) + 1);
    };
    for (const r of results) {
      for (const x of r.reports) if (x.kind !== "write") add(x.kind, x.detail);
      for (const c of r.console) if (!c.includes("[next-offline]")) add("console", c);
    }
    const failed = results.filter((r) => !r.ok);
    const dry = results.filter((r) => r.ok && !r.hydrated);
    const empty = results.filter((r) => r.ok && r.text < 20);
    log("");
    log(`verify: ${results.length} pages, ${results.length - failed.length} loaded, ${results.length - failed.length - dry.length} hydrated, ${clicks.filter((c) => c.pass).length}/${clicks.length} click navigations`);
    if (failed.length) log(`  did not load: ${failed.slice(0, 5).map((r) => `${r.variant}:${r.key}`).join(", ")}`);
    if (dry.length) log(`  loaded but no React root found: ${dry.length} (fine for a static page, a failure for an app page)`);
    if (empty.length) log(`  nearly empty body: ${empty.slice(0, 5).map((r) => `${r.variant}:${r.key}`).join(", ")}`);
    log(`  network leaks: ${leaks.length}${leaks.length ? " — " + [...new Set(leaks)].slice(0, 5).join(", ") : ""}`);
    if (issues.size) {
      log(`  distinct issues (${issues.size}):`);
      for (const [k, n] of [...issues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) log(`    ${String(n).padStart(4)}x  ${k}`);
    }
    const report = { file: cfg.out, bootMs, results, clicks, leaks, issues: Object.fromEntries(issues) };
    const reportPath = cfg.out.replace(/\.html?$/, "") + ".verify.json";
    await fs.writeFile(reportPath, JSON.stringify(report, null, 1));
    log(`  report: ${path.relative(process.cwd(), reportPath)}${opts.screens ? `   screenshots: ${path.relative(process.cwd(), shotsDir)}` : ""}`);
    return { failed: failed.length, leaks: leaks.length, clickFailures: clicks.filter((c) => !c.pass).length };
  } finally {
    await browser.close();
  }
}

async function waitLoaded(page, seqBefore, timeout = 30_000) {
  try {
    await page.waitForFunction((s) => window.__NO.loaded && window.__NO.loaded.seq > s && window.__NO.loaded.seq === window.__NO.seq, seqBefore, {
      timeout,
    });
    return true;
  } catch {
    return false;
  }
}
