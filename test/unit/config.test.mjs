import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { loadConfig } from "../../lib/config.mjs";

const dirs = [];
async function writeConfig(source) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "next-snapshot-cfg-"));
  dirs.push(dir);
  const file = path.join(dir, "app.config.mjs");
  await fs.writeFile(file, source);
  return { dir, file };
}
after(() => Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }))));

test("an empty config gets every default", async () => {
  const { dir, file } = await writeConfig("export default {};");
  const c = await loadConfig(file);
  assert.equal(c.name, "app");
  assert.equal(c.origin, "http://localhost:3217");
  assert.deepEqual(c.aliases, ["http://127.0.0.1:3217", "http://[::1]:3217"]);
  assert.equal(c.out, path.join(dir, "app.html"));
  assert.equal(c.captureDir, path.join(dir, "app.capture"));
  assert.deepEqual(c.seeds, ["/"]);
  assert.equal(c.start, "/");
  assert.deepEqual(c.variants.map((v) => v.id), ["default"]);
  assert.equal(c.defaultVariant, "default");
  assert.equal(c.explore.selects, true);
  assert.equal(c.explore.tabs, true);
  assert.equal(c.offline.missingLinks, "show");
  assert.equal(c.offline.badge, "bottom-right");
});

test("/_next and /api are never crawled as pages, and user excludes add to them", async () => {
  const { file } = await writeConfig("export default { exclude: [/^\\/admin/] };");
  const c = await loadConfig(file);
  const excluded = (k) => c.exclude.some((re) => re.test(k));
  assert.ok(excluded("/_next/static/x.js"));
  assert.ok(excluded("/api/users"));
  assert.ok(excluded("/admin/panel"));
  assert.ok(!excluded("/reports"));
});

test("relative paths resolve against the config file, not the working directory", async () => {
  const { dir, file } = await writeConfig(`export default { out: "./dist/x.html", app: { cwd: "../app", start: "x" } };`);
  const c = await loadConfig(file);
  assert.equal(c.out, path.join(dir, "dist", "x.html"));
  assert.equal(c.app.cwd, path.resolve(dir, "../app"));
  assert.equal(c.staticDir, path.join(path.resolve(dir, "../app"), ".next", "static"));
});

test("a url sets the origin; a non-loopback host gets only the aliases it is given", async () => {
  const { file } = await writeConfig(`export default { url: "https://app.example.com/some/path", aliases: ["https://www.app.example.com"] };`);
  const c = await loadConfig(file);
  assert.equal(c.origin, "https://app.example.com");
  assert.deepEqual(c.aliases, ["https://www.app.example.com"]);
});

test("variant labels default to their ids", async () => {
  const { file } = await writeConfig(`export default { variants: [{ id: "a" }, { id: "b", label: "Bee" }] };`);
  const c = await loadConfig(file);
  assert.deepEqual(c.variants.map((v) => v.label), ["a", "Bee"]);
  assert.equal(c.defaultVariant, "a");
});

test("a variant id that cannot be written into a URL hash is refused", async () => {
  const { file } = await writeConfig(`export default { variants: [{ id: "has space" }] };`);
  await assert.rejects(loadConfig(file), /must be \[A-Za-z0-9_.-\]\+/);
});

test("duplicate variant ids are refused", async () => {
  const { file } = await writeConfig(`export default { variants: [{ id: "a" }, { id: "a" }] };`);
  await assert.rejects(loadConfig(file), /Duplicate variant id "a"/);
});

test("a missing config file says where it looked", async () => {
  await assert.rejects(loadConfig("/nonexistent/next-snapshot.config.mjs"), /Config not found: .*nonexistent/);
  await assert.rejects(loadConfig(undefined), /No config given/);
});
