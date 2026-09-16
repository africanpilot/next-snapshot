// The same capture bundled both ways must produce files that behave alike.
// "gzip" is the default and stores each page on its own; "zstd" packs pages
// into clusters and inlines a decoder.

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
import { startFixture } from "../fixtures/site/server.mjs";

const quiet = () => {};

describe("compression modes", { timeout: 300_000 }, () => {
  let site, dir, browser;
  const built = {};

  before(async () => {
    site = await startFixture();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "next-snapshot-compress-"));
    const write = async (name, extra) => {
      const file = path.join(dir, `${name}.config.mjs`);
      await fs.writeFile(
        file,
        `export default { name: ${JSON.stringify(name)}, url: ${JSON.stringify(site.origin)},
          out: "./out/${name}.html", seeds: ["/"], settleMs: 50, idleTimeoutMs: 3000,
          captureDir: "./shared.capture", ${extra} };`,
      );
      return loadConfig(file);
    };
    const gzipCfg = await write("gzip", "");
    // One crawl, shared by both bundles: the capture is identical either way.
    await capture(gzipCfg, quiet);
    built.gzip = { cfg: gzipCfg, report: await bundle(gzipCfg, quiet) };
    const zstdCfg = await write("zstd", `compress: "zstd", clusterBytes: 4 * 1024`);
    built.zstd = { cfg: zstdCfg, report: await bundle(zstdCfg, quiet) };
    browser = await launch({});
  });

  after(async () => {
    await browser?.close();
    await site?.close();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  async function open(which) {
    const context = await browser.newContext({ offline: true });
    const leaks = [];
    await context.route(
      (u) => !/^(file|blob|data|about):/.test(u.protocol),
      (r) => {
        leaks.push(r.request().url());
        return r.abort();
      },
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(pathToFileURL(built[which].cfg.out).href);
    await page.waitForFunction(() => window.__NO && window.__NO.loaded);
    return { page, leaks, errors, context };
  }

  test("the default is unchanged: gzip, one block per page, no decoder inlined", async () => {
    const html = await fs.readFile(built.gzip.cfg.out, "utf8");
    assert.equal(built.gzip.report.codec, "gzip");
    assert.equal(built.gzip.report.clusters, 0);
    assert.equal(built.gzip.cfg.compress, "gzip", "config default");
    assert.ok(!html.includes('id="no-c0"'), "no clusters");
    // The shell mentions fzstd either way; what must be absent is the decoder.
    assert.ok(!html.includes(".fzstd=f()"), "decoder is not inlined");
  });

  test("zstd writes clusters and inlines the decoder", async () => {
    const html = await fs.readFile(built.zstd.cfg.out, "utf8");
    assert.equal(built.zstd.report.codec, "zstd");
    // The fixture's pages are small; a budget below one page proves the packer
    // splits, without needing a big corpus.
    assert.ok(built.zstd.report.clusters >= 2, `several clusters at a 4KB budget, got ${built.zstd.report.clusters}`);
    assert.ok(html.includes('id="no-c0"') && html.includes('id="no-c1"'), "clusters are in the file");
    assert.ok(html.includes(".fzstd=f()"), "decoder is inlined");
  });

  for (const which of ["gzip", "zstd"]) {
    test(`${which}: pages render, navigation works, nothing reaches the network`, async () => {
      const { page, leaks, errors, context } = await open(which);
      const frame = () => page.frameLocator("iframe.no-frame:not(.loading)");
      await assert.doesNotReject(frame().locator("#data", { hasText: "hello from the api" }).waitFor(), "fetch replayed");
      await assert.doesNotReject(frame().locator("#lazy", { hasText: "loaded from /static/lazy.js" }).waitFor(), "runtime script ran");
      const before = await page.evaluate(() => window.__NO.seq);
      await frame().locator("nav a", { hasText: /^About$/ }).click();
      await page.waitForFunction((s) => window.__NO.loaded && window.__NO.loaded.seq > s, before, { timeout: 15_000 });
      assert.equal(await page.evaluate(() => window.__NO.loaded.key), "/about");
      await assert.doesNotReject(frame().locator("h1", { hasText: "About" }).waitFor());
      assert.deepEqual(errors, []);
      assert.deepEqual(leaks, []);
      await context.close();
    });

    test(`${which}: verify passes`, async () => {
      const r = await verify(built[which].cfg, { full: true, settleMs: 150 }, quiet);
      assert.deepEqual(r, { failed: 0, leaks: 0, clickFailures: 0 });
    });
  }

  test("both modes serve byte-identical pages", async () => {
    const read = async (which) => {
      const { page, context } = await open(which);
      const keys = await page.evaluate(() => window.__NO.listPages().map((p) => p.key).sort());
      const html = {};
      for (const key of keys) {
        html[key] = await page.evaluate(async (k) => {
          const r = await window.__NO.fetch(window.__NO.origin + k);
          return new TextDecoder().decode(r.bytes).length;
        }, key);
      }
      await context.close();
      return { keys, html };
    };
    const a = await read("gzip");
    const b = await read("zstd");
    assert.deepEqual(b.keys, a.keys, "same pages");
    assert.deepEqual(b.html, a.html, "same page bytes");
  });
});
