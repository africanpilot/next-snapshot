// A real Next.js App Router app, built and started, captured, bundled and used
// offline. Slow and needs the network on first run (it installs Next into the
// fixture), so it runs only through `npm run test:next`.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fss from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";

import { launch } from "../../lib/browser.mjs";
import { bundle } from "../../lib/bundle.mjs";
import { capture } from "../../lib/capture.mjs";
import { loadConfig } from "../../lib/config.mjs";
import { withServer } from "../../lib/server.mjs";
import { verify } from "../../lib/verify.mjs";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "next-app");
const quiet = () => {};

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

describe("a real Next.js app, end to end", { timeout: 900_000 }, () => {
  let dir, cfg, manifest, browser, page, leaks;

  before(async () => {
    if (!fss.existsSync(path.join(APP, "node_modules", "next"))) {
      execSync("npm install --no-audit --no-fund", { cwd: APP, stdio: "inherit" });
    }
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "next-snapshot-next-"));
    const file = path.join(dir, "next.config.mjs");
    await fs.writeFile(
      file,
      `export default {
        name: "next-app",
        app: { cwd: ${JSON.stringify(APP)}, build: "npx next build", start: "npx next start -p {port}", port: ${await freePort()} },
        out: "./out/next-app.html",
        seeds: ["/"],
      };`,
    );
    cfg = await loadConfig(file);
    manifest = await withServer(cfg, { build: true }, quiet, () => capture(cfg, quiet));
    await bundle(cfg, quiet);

    browser = await launch(cfg);
    const context = await browser.newContext({ offline: true });
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
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  const frame = () => page.frameLocator("iframe.no-frame:not(.loading)");
  const seq = () => page.evaluate(() => window.__NO.seq);
  const loaded = () => page.evaluate(() => window.__NO.loaded.key);
  const waitLoad = (s) =>
    page.waitForFunction((s) => window.__NO.loaded && window.__NO.loaded.seq > s && window.__NO.loaded.seq === window.__NO.seq, s, {
      timeout: 20_000,
    });

  test("capture finds the pages, including the one router.replace reaches", () => {
    const P = manifest.pages.default;
    for (const k of ["/", "/about", "/?year=2026"]) assert.ok(P[k]?.body, `page ${k} captured`);
    assert.ok(manifest.rscSkipped > 0, "Next's prefetch requests were seen and skipped");
  });

  test("React hydrates, and usePathname sees the real path", async () => {
    await page.waitForFunction(() => window.__NO.hydrated(), null, { timeout: 15_000 });
    await assert.doesNotReject(frame().locator("#path", { hasText: /^\/$/ }).waitFor());
  });

  test("client state works", async () => {
    await frame().locator("#count").click();
    await frame().locator("#count").click();
    await assert.doesNotReject(frame().locator("#count", { hasText: "count: 2" }).waitFor());
  });

  test("<Link> navigates", async () => {
    const s = await seq();
    await frame().getByRole("link", { name: "About" }).click();
    await waitLoad(s);
    assert.equal(await loaded(), "/about");
    await assert.doesNotReject(frame().locator("#path", { hasText: "/about" }).waitFor());
  });

  test("router.replace from a select lands on the captured server render", async () => {
    const s0 = await seq();
    await page.evaluate(() => window.__NO.go(window.__NO.manifest.defaultVariant, "/"));
    await waitLoad(s0);
    await page.waitForFunction(() => window.__NO.hydrated(), null, { timeout: 15_000 });
    const s = await seq();
    await frame().locator("#year-select").selectOption("2026");
    await waitLoad(s);
    assert.equal(await loaded(), "/?year=2026");
    await assert.doesNotReject(frame().locator("#year", { hasText: "year: 2026" }).waitFor());
  });

  test("nothing reached for the network", () => {
    assert.deepEqual(leaks, []);
  });

  test("verify passes the file", async () => {
    const r = await verify(cfg, { full: true }, quiet);
    assert.deepEqual(r, { failed: 0, leaks: 0, clickFailures: 0 });
  });
});
