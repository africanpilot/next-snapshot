#!/usr/bin/env node
// next-offline — capture a running Next.js app and bundle it into one HTML file
// that opens from disk with no network.
//
//   node cli.mjs all     --config app.config.mjs   capture, bundle, verify
//   node cli.mjs capture --config app.config.mjs   crawl the app (starts it if configured)
//   node cli.mjs bundle  --config app.config.mjs   capture dir -> one .html
//   node cli.mjs verify  --config app.config.mjs   open the .html offline, walk every page
//
// Options: --build (rebuild the app first)  --screens (verify saves screenshots)
//          --limit N / --variant ID (verify a subset)  --no-verify (all: skip verify)

import { parseArgs } from "node:util";

import { bundle } from "./lib/bundle.mjs";
import { capture } from "./lib/capture.mjs";
import { loadConfig } from "./lib/config.mjs";
import { withServer } from "./lib/server.mjs";
import { verify } from "./lib/verify.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", short: "c" },
    build: { type: "boolean" },
    screens: { type: "boolean" },
    full: { type: "boolean" },
    limit: { type: "string" },
    variant: { type: "string" },
    "no-verify": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const cmd = positionals[0] ?? "all";
if (values.help || !["all", "capture", "bundle", "verify"].includes(cmd)) {
  console.log(
    "usage: next-offline [all|capture|bundle|verify] --config app.config.mjs [--build] [--screens] [--limit N] [--variant ID] [--no-verify]",
  );
  process.exit(values.help ? 0 : 2);
}

const log = (s = "") => console.log(s);
const cfg = await loadConfig(values.config);
const verifyOpts = { screens: values.screens, full: values.full, limit: values.limit ? +values.limit : 0, variant: values.variant };

try {
  if (cmd === "capture" || cmd === "all") {
    await withServer(cfg, { build: values.build }, log, () => capture(cfg, log));
  }
  if (cmd === "bundle" || cmd === "all") await bundle(cfg, log);
  if (cmd === "verify" || (cmd === "all" && !values["no-verify"])) {
    const r = await verify(cfg, verifyOpts, log);
    if (r.failed || r.leaks || r.clickFailures) process.exitCode = 1;
  }
} catch (e) {
  console.error(`\nnext-offline: ${e.message}`);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
}
