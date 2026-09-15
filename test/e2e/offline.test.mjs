// The whole pipeline against the fixture site: capture it, bundle it, open the
// file from disk with the network off, and use it.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";

import { launch } from "../../lib/browser.mjs";
import { bundle } from "../../lib/bundle.mjs";
import { capture } from "../../lib/capture.mjs";
import { loadConfig } from "../../lib/config.mjs";
import { verify } from "../../lib/verify.mjs";
import { STATIC_DIR, startFixture } from "../fixtures/site/server.mjs";

const quiet = () => {};

describe("fixture site, end to end", { timeout: 180_000 }, () => {
  let site, dir, cfg, manifest, report, browser, page, leaks;

  before(async () => {
    site = await startFixture();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "next-snapshot-e2e-"));
    const file = path.join(dir, "site.config.mjs");
    await fs.writeFile(
      file,
      `export default {
        name: "site",
        title: "Fixture site",
        url: ${JSON.stringify(site.origin)},
        out: "./out/site.html",
        seeds: ["/"],
        staticDir: ${JSON.stringify(STATIC_DIR)},
        staticPrefix: "/static/",
        settleMs: 50,
        idleTimeoutMs: 3000,
      };`,
    );
    cfg = await loadConfig(file);
    manifest = await capture(cfg, quiet);
    report = await bundle(cfg, quiet);

    browser = await launch(cfg);
    const context = await browser.newContext({ offline: true, viewport: { width: 1200, height: 800 } });
    leaks = [];
    await context.route(
      (u) => !/^(file|blob|data|about):/.test(u.protocol),
      (r) => {
        leaks.push(r.request().url());
        return r.abort();
      },
    );
    page = await context.newPage();
    await page.goto(pathToFileURL(cfg.out).href);
    await page.waitForFunction(() => window.__NO && window.__NO.loaded);
  });

  after(async () => {
    await browser?.close();
    await site?.close();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  const frame = () => page.frameLocator("iframe.no-frame:not(.loading)");
  const seq = () => page.evaluate(() => window.__NO.seq);
  const loaded = () => page.evaluate(() => window.__NO.loaded.key);
  const waitLoad = (s) =>
    page.waitForFunction((s) => window.__NO.loaded && window.__NO.loaded.seq > s && window.__NO.loaded.seq === window.__NO.seq, s, {
      timeout: 15_000,
    });
  async function go(key) {
    const s = await seq();
    await page.evaluate((k) => window.__NO.go(window.__NO.manifest.defaultVariant, k), key);
    await waitLoad(s);
  }

  // --- capture ---------------------------------------------------------------

  test("capture finds pages by link, redirect, select and tab", () => {
    const P = manifest.pages.default;
    for (const k of ["/", "/about", "/report?period=q2"]) assert.ok(P[k]?.body, `page ${k} captured`);
    assert.deepEqual(P["/old"], { redirect: "/about" });
    assert.ok(P["/?tab=a"]?.body && P["/?tab=b"]?.body, "tab URLs written by replaceState are captured");
  });

  test("capture records client GETs per variant and skips RSC payloads", () => {
    assert.ok(manifest.variantAssets.default["/api/data"], "the page's fetch is recorded");
    assert.ok(manifest.rscSkipped >= 1, "the router link's RSC request was seen and skipped");
  });

  test("capture never sends a write to the app", () => {
    assert.ok(!site.hits.some((h) => !h.startsWith("GET ") && !h.startsWith("HEAD ")), site.hits.filter((h) => !h.startsWith("GET")).join());
  });

  test("the bundle reports what pages reference but the capture lacks", () => {
    assert.ok(report.missing["/static/dot-2x.svg"], "an uncaptured srcset candidate is reported");
    assert.equal(report.missing["/static/not-a-reference.svg"], undefined, "a URL inside an inline script is not a reference");
  });

  // --- the file --------------------------------------------------------------

  test("the file is one self-contained HTML document with a no-network CSP", async () => {
    const html = await fs.readFile(cfg.out, "utf8");
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
    assert.doesNotMatch(html, /<script[^>]+src=/, "no script is loaded from a URL");
    assert.doesNotMatch(html, /<link[^>]+href=/, "no stylesheet is loaded from a URL");
  });

  test("the app sees its real URL, not about:srcdoc", async () => {
    await go("/");
    await assert.doesNotReject(frame().locator("#where", { hasText: /^\/$/ }).waitFor());
  });

  test("fetch is answered from the snapshot", async () => {
    await assert.doesNotReject(frame().locator("#data", { hasText: "hello from the api" }).waitFor());
  });

  test("a script loaded at runtime runs, and reads its original src back", async () => {
    await assert.doesNotReject(frame().locator("#lazy", { hasText: "loaded from /static/lazy.js" }).waitFor());
  });

  test("images and CSS url() references load from the snapshot", async () => {
    const ok = await frame()
      .locator("#dot")
      .evaluate((img) => img.complete && img.naturalWidth > 0);
    assert.ok(ok, "the <img> decoded");
    const bg = await frame()
      .locator("body")
      .evaluate((b) => getComputedStyle(b).backgroundImage);
    assert.match(bg, /^url\("blob:/);
  });

  test("a plain link navigates", async () => {
    const s = await seq();
    await frame().locator("nav a", { hasText: /^About$/ }).click();
    await waitLoad(s);
    assert.equal(await loaded(), "/about");
    assert.match(await page.evaluate(() => location.hash), /^#\/about$/);
  });

  test("back returns to the previous page", async () => {
    const s = await seq();
    await page.goBack();
    await waitLoad(s);
    assert.equal(await loaded(), "/");
  });

  test("a router link falls back from RSC to a full navigation", async () => {
    await go("/");
    const s = await seq();
    await frame().locator("a[data-router]").click();
    await waitLoad(s);
    assert.equal(await loaded(), "/about");
  });

  test("a link to a redirect lands on its target", async () => {
    await go("/");
    const s = await seq();
    await frame().locator("nav a", { hasText: "Old link" }).click();
    await waitLoad(s);
    assert.equal(await loaded(), "/about");
  });

  test("a select that navigates lands on the captured page", async () => {
    await go("/");
    const s = await seq();
    await frame().locator("#period").selectOption("q2");
    await waitLoad(s);
    assert.equal(await loaded(), "/report?period=q2");
    await assert.doesNotReject(frame().locator("h1", { hasText: "Report q2" }).waitFor());
  });

  test("a replaceState tab updates the address without reloading, and survives a reload", async () => {
    await go("/");
    const s = await seq();
    await frame().locator("#tabs button", { hasText: "Tab B" }).click();
    await frame().locator("#tab", { hasText: "b" }).waitFor();
    assert.equal(await seq(), s, "no navigation");
    assert.equal(await page.evaluate(() => location.hash), "#/?tab=b");
    await page.reload();
    await page.waitForFunction(() => window.__NO && window.__NO.loaded);
    assert.equal(await loaded(), "/?tab=b");
    await assert.doesNotReject(frame().locator("#tab", { hasText: "b" }).waitFor());
  });

  test("a URL the app writes that was never captured survives a reload", async () => {
    await go("/");
    assert.equal(manifest.pages.default["/?note=1"], undefined, "precondition: the crawl never saw it");
    await frame().locator("#note").click();
    await page.waitForFunction(() => location.hash === "#/?note=1");
    await page.reload();
    await page.waitForFunction(() => window.__NO && window.__NO.loaded);
    assert.equal(await loaded(), "/?note=1");
    await assert.doesNotReject(frame().locator("#where", { hasText: "/?note=1" }).waitFor());
    assert.equal(await frame().locator("text=isn’t in the offline snapshot").count(), 0);
  });

  test("a POST is refused as read-only and reported, and nothing navigates", async () => {
    await go("/");
    await page.evaluate(() => window.__NO.drainReports());
    const s = await seq();
    await frame().locator("form button[type=submit]").click();
    await page.locator("#no-toast.show", { hasText: "read-only" }).waitFor();
    const reports = await page.evaluate(() => window.__NO.drainReports());
    assert.ok(reports.some((r) => r.kind === "write" && r.detail === "POST /api/save"));
    assert.equal(await seq(), s);
  });

  test("a page that was never captured says so and lists what was", async () => {
    await go("/nowhere");
    await assert.doesNotReject(frame().locator("h1", { hasText: "isn’t in the offline snapshot" }).waitFor());
    assert.ok(await frame().locator('li a[href="/about"]').count());
  });

  test("nothing tried to reach the network, and the CSP blocked nothing", async () => {
    const reports = await page.evaluate(() => window.__NO.drainReports());
    assert.deepEqual(
      reports.filter((r) => r.kind === "blocked" || r.kind === "miss"),
      [],
    );
    assert.deepEqual(leaks, []);
  });

  test("verify passes the file: every page loads, clicks land, no leaks", async () => {
    const r = await verify(cfg, { full: true, settleMs: 200 }, quiet);
    assert.deepEqual(r, { failed: 0, leaks: 0, clickFailures: 0 });
  });
});
