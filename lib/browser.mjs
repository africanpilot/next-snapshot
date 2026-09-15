// Find a Chromium to drive. Installed Chrome first (no download needed), then
// any browser Playwright has cached, then whatever the config names.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

export async function launch(cfg) {
  const b = cfg.browser ?? {};
  const tries = [];
  if (b.executablePath) tries.push({ executablePath: b.executablePath });
  if (b.channel !== false) tries.push({ channel: b.channel ?? "chrome" });
  for (const p of cachedChromiums()) tries.push({ executablePath: p });

  let last;
  for (const t of tries) {
    try {
      return await chromium.launch({ headless: b.headless ?? true, ...t });
    } catch (e) {
      last = e;
    }
  }
  throw new Error(
    "No Chromium could be launched. Install Google Chrome, or set browser.executablePath in the config.\n" +
      (last?.message ?? ""),
  );
}

function cachedChromiums() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "AppData", "Local", "ms-playwright"),
  ].filter(Boolean);
  const rels = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-win64/chrome.exe",
    "chrome-win/chrome.exe",
  ];
  const out = [];
  for (const root of roots) {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names.filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      for (const rel of rels) {
        const p = path.join(root, n, rel);
        if (fs.existsSync(p)) out.push(p);
      }
    }
  }
  return out;
}
