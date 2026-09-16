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
  assert.deepEqual(c.aliases, ["http://127.0.0.1:3217", "http://[::1]:3217", "http://0.0.0.0:3217"]);
  assert.equal(c.docker, null);
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
  assert.equal(c.compress, "gzip", "the default packing is unchanged");
  assert.equal(c.clusterBytes, 4 * 1024 * 1024);
});

test("compress is gzip or zstd, and clusterBytes is settable", async () => {
  const { file } = await writeConfig(`export default { compress: "zstd", clusterBytes: 1024 };`);
  const c = await loadConfig(file);
  assert.equal(c.compress, "zstd");
  assert.equal(c.clusterBytes, 1024);
  const bad = await writeConfig(`export default { compress: "brotli" };`);
  await assert.rejects(loadConfig(bad.file), /compress must be "gzip" or "zstd"/);
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

test("every loopback spelling of the app's origin is an alias of it", async () => {
  // A Next image sets HOSTNAME=0.0.0.0, so its redirects can name that host.
  const { file } = await writeConfig(`export default { url: "http://localhost:3000" };`);
  const c = await loadConfig(file);
  assert.deepEqual(c.aliases, ["http://127.0.0.1:3000", "http://[::1]:3000", "http://0.0.0.0:3000"]);
});

test("docker only needs a container name; the build path has a default", async () => {
  const { file } = await writeConfig(`export default { docker: { container: "web" } };`);
  const c = await loadConfig(file);
  assert.deepEqual(c.docker, { container: "web", staticPath: "/app/.next/static" });
  const other = await writeConfig(`export default { docker: { container: "web", staticPath: "/srv/.next/static" } };`);
  assert.equal((await loadConfig(other.file)).docker.staticPath, "/srv/.next/static");
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
