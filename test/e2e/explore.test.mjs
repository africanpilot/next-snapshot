// How much of a route's tab views the crawl captures.
//
// The fixture's /report route has one page per period, each with the same tab
// strip. `explore.tabs: true` clicks the tabs once per path, so only the first
// period gets tab pages; "url" clicks them on every captured page.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { capture } from "../../lib/capture.mjs";
import { loadConfig } from "../../lib/config.mjs";
import { startFixture } from "../fixtures/site/server.mjs";

const quiet = () => {};

async function captureWith(site, tabs) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "next-snapshot-explore-"));
  const file = path.join(dir, "site.config.mjs");
  await fs.writeFile(
    file,
    `export default {
      name: "site",
      url: ${JSON.stringify(site.origin)},
      out: "./out/site.html",
      seeds: ["/"],
      settleMs: 50,
      idleTimeoutMs: 3000,
      explore: { tabs: ${JSON.stringify(tabs)} },
    };`,
  );
  const cfg = await loadConfig(file);
  const manifest = await capture(cfg, quiet);
  return { dir, pages: Object.keys(manifest.pages.default) };
}

const reportTabs = (pages) => pages.filter((k) => k.startsWith("/report?") && k.includes("tab=")).sort();
const periods = (keys) => [...new Set(keys.map((k) => (k.match(/period=([^&]*)/) ?? [, "?"])[1]))].sort();

describe("tab exploration", { timeout: 300_000 }, () => {
  let site;
  const dirs = [];

  before(async () => {
    site = await startFixture();
  });
  after(async () => {
    await site?.close();
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  test("once per path: the route's other pages get no tab views", async () => {
    const { dir, pages } = await captureWith(site, true);
    dirs.push(dir);
    assert.ok(periods(pages.filter((k) => k.startsWith("/report?"))).length >= 2, "both periods were captured");
    // Which period the crawl reaches first is an ordering detail; that only one
    // of them ends up with tab views is the behaviour.
    const withTabs = periods(reportTabs(pages));
    assert.equal(withTabs.length, 1, `exactly one period has tab pages, got: ${withTabs.join(", ") || "none"}`);
  });

  test("once per page: every page of the route gets every tab", async () => {
    const { dir, pages } = await captureWith(site, "url");
    dirs.push(dir);
    assert.deepEqual(periods(reportTabs(pages)), ["q2", "q3"]);
    for (const k of ["/report?period=q2&tab=a", "/report?period=q2&tab=b", "/report?period=q3&tab=a", "/report?period=q3&tab=b"]) {
      assert.ok(pages.includes(k), `captured ${k}`);
    }
    // A page a tab click produced is not explored again.
    assert.ok(!pages.some((k) => (k.match(/tab=/g) ?? []).length > 1), "no key carries two tab parameters");
  });
});
