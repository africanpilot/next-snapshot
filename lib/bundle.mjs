// Turn a capture directory into one HTML file.
//
//   JS    location references are rewritten to a virtual location object
//         (esbuild `define`, so strings and shadowed locals are untouched).
//   CSS   url(...) and @import references become asset tokens.
//   HTML  asset-bearing attributes become tokens; a <base> naming the page's
//         real URL and a placeholder for the frame shim go first in <head>.
//
// Every body is gzipped and base64'd into its own inert <script type=text/plain>.
// The runtime (runtime/shell.js) decodes assets once into blob: URLs, replaces
// tokens with them, and decodes a page only when it is navigated to.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { transform } from "esbuild";

import { urlKey } from "./key.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const LOCATION_DEFINES = {
  location: "__NOloc",
  "window.location": "__NOloc",
  "self.location": "__NOloc",
  "globalThis.location": "__NOloc",
  "document.location": "__NOloc",
};

// Nothing in the file may reach the network. Anything that tries is refused by
// the browser and shows up as a CSP violation, which `verify` reports.
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob: data:",
  "style-src 'unsafe-inline' blob: data:",
  "img-src blob: data:",
  "font-src blob: data:",
  "media-src blob: data:",
  "connect-src blob: data:",
  "worker-src blob:",
  "frame-src blob: data: about:",
  "form-action 'none'",
].join("; ");

const TAG = String.raw`<[a-zA-Z][^\s/>]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?)*\s*/?>`;
const HTML_RE = new RegExp(
  String.raw`(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(</script\s*>)|(<style\b[^>]*>)([\s\S]*?)(</style\s*>)|<!--[\s\S]*?-->|${TAG}`,
  "gi",
);
const ATTR_RE = /(\s)(src|href|srcset|imagesrcset|poster|xlink:href|style)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

export async function bundle(cfg, log) {
  const M = JSON.parse(await fs.readFile(path.join(cfg.captureDir, "manifest.json"), "utf8"));
  const origin = M.origin;
  const canon = (u) => {
    for (const a of cfg.aliases) if (u === a || u.startsWith(a + "/") || u.startsWith(a + "?")) return origin + u.slice(a.length);
    return u;
  };
  const readBody =(sha) => fs.readFile(path.join(cfg.captureDir, "bodies", sha));
  const t0 = Date.now();

  // --- asset table ---------------------------------------------------------
  const assets = [];
  for (const [k, e] of Object.entries(M.assets)) assets.push({ k, v: null, ...e });
  for (const [v, map] of Object.entries(M.variantAssets)) for (const [k, e] of Object.entries(map)) assets.push({ k, v, ...e });
  const index = new Map(assets.map((a, i) => [`${a.v ?? ""}\0${a.k}`, i]));
  const lookup = (key, v) => {
    if (!key) return -1;
    let i = index.get(`${v ?? ""}\0${key}`) ?? index.get(`\0${key}`);
    if (i == null && key.includes("?") && key.startsWith(cfg.staticPrefix)) i = index.get(`\0${key.split("?")[0]}`);
    return i ?? -1;
  };

  // --- per-page CSS ----------------------------------------------------------
  const cssRules = [cfg.offline.css ?? ""];
  if (cfg.offline.missingLinks === "hide") cssRules.push("a[data-no-missing],area[data-no-missing]{display:none!important}");
  if (cfg.offline.missingLinks === "disable") {
    cssRules.push("a[data-no-missing],area[data-no-missing]{opacity:.45;pointer-events:none;cursor:not-allowed}");
  }
  const pageCSS = cssRules.join("\n").trim()
    ? `<style data-no-css>${cssRules.join("\n").replace(/<\/style/gi, "<\\/style")}</style>`
    : "";

  // --- bodies ---------------------------------------------------------------
  const out = []; // id -> base64(gzip)
  const outIndex = new Map(); // content hash -> id
  const sizes = []; // {what, raw, packed}
  function emit(buf, what) {
    const h = crypto.createHash("sha256").update(buf).digest("hex");
    let id = outIndex.get(h);
    if (id == null) {
      const packed = zlib.gzipSync(buf, { level: 9 }).toString("base64");
      id = out.length;
      out.push(packed);
      outIndex.set(h, id);
      sizes.push({ what, raw: buf.length, packed: packed.length });
    }
    return id;
  }

  const missing = new Map(); // referenced but never captured -> count
  const miss = (k) => missing.set(k, (missing.get(k) ?? 0) + 1);
  const jsCache = new Map();
  let jsRewritten = 0;

  const isJS = (a) => /javascript|ecmascript/i.test(a.type) || /\.m?js$/.test(a.k.split("?")[0]);
  const isCSS = (a) => /text\/css/i.test(a.type) || /\.css$/.test(a.k.split("?")[0]);

  // CSS before its tokens can be resolved needs the index only, so one pass.
  for (const a of assets) {
    let buf = await readBody(a.body);
    if (isJS(a)) {
      if (!jsCache.has(a.body)) jsCache.set(a.body, await transformJS(buf, a.k));
      buf = jsCache.get(a.body);
      jsRewritten++;
    } else if (isCSS(a)) {
      const base = a.k.startsWith("/") ? origin + a.k : a.k;
      buf = Buffer.from(rewriteCSS(buf.toString("utf8"), base, a.v));
    }
    a.b = emit(buf, `asset ${a.k}`);
  }

  // --- pages ------------------------------------------------------------------
  const pagesOut = {};
  let pageCount = 0;
  for (const [v, P] of Object.entries(M.pages)) {
    pagesOut[v] = {};
    for (const [k, e] of Object.entries(P)) {
      if (e.redirect != null) pagesOut[v][k] = { r: e.redirect };
      else if (e.file != null) {
        const i = lookup(e.file, v);
        if (i >= 0) pagesOut[v][k] = { a: i };
      } else {
        const html = (await readBody(e.body)).toString("utf8");
        pagesOut[v][k] = { b: emit(Buffer.from(rewriteHTML(html, k, v)), `page ${v} ${k}`), s: e.status };
        pageCount++;
      }
    }
  }

  // --- runtime + output ---------------------------------------------------------
  const frameSrc = await fs.readFile(path.join(HERE, "runtime", "frame.js"), "utf8");
  const postEntries = Object.entries(cfg.offline.post ?? {}).map(([p, fn]) => {
    const src = fn.toString();
    if (!/^(async\s*)?(\(|function\b|[A-Za-z_$][\w$]*\s*=>)/.test(src)) {
      throw new Error(`offline.post["${p}"] must be an arrow function or function expression (method shorthand cannot be serialised)`);
    }
    return `${JSON.stringify(p)}: (${src})`;
  });
  const shellSrc = (await fs.readFile(path.join(HERE, "runtime", "shell.js"), "utf8"))
    .replace("/*@URLKEY@*/null", () => `(${urlKey.toString()})`)
    .replace('/*@FRAME@*/""', () => JSON.stringify(frameSrc).replace(/</g, "\\u003c"))
    .replace("/*@POST@*/{}", () => `{${postEntries.join(",\n")}}`);

  const manifestOut = {
    v: 1,
    origin,
    aliases: cfg.aliases,
    title: cfg.title ?? M.title ?? null,
    createdAt: M.createdAt,
    variants: M.variants,
    defaultVariant: M.defaultVariant,
    start: M.start,
    badge: cfg.offline.badge,
    switcher: cfg.offline.switcher,
    missingLinks: cfg.offline.missingLinks,
    assets: assets.map((a) => [a.k, a.v, a.b, a.type, a.status ?? 200]),
    pages: pagesOut,
  };

  const title = escHTML(manifestOut.title ?? "Offline snapshot");
  const parts = [
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<meta name="generator" content="next-snapshot">`,
    `<title>${title}</title>`,
    `<style>${SHELL_CSS}</style></head><body>`,
    `<noscript>This offline snapshot needs JavaScript enabled.</noscript>`,
    `<div id="no-loading">Opening ${title}…</div>`,
    `<script type="application/json" id="no-manifest">${JSON.stringify(manifestOut).replace(/</g, "\\u003c")}</script>`,
  ];
  for (let i = 0; i < out.length; i++) parts.push(`<script type="text/plain" id="no-b${i}">${out[i]}</script>`);
  parts.push(`<script>${shellSrc.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--")}</script>`);
  parts.push(`</body></html>\n`);

  await fs.mkdir(path.dirname(cfg.out), { recursive: true });
  const html = parts.join("\n");
  await fs.writeFile(cfg.out, html);

  // --- report ----------------------------------------------------------------------
  const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MB";
  const pageBytes = sizes.filter((s) => s.what.startsWith("page")).reduce((n, s) => n + s.packed, 0);
  const assetBytes = sizes.filter((s) => s.what.startsWith("asset")).reduce((n, s) => n + s.packed, 0);
  log("");
  log(`bundle finished in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${path.relative(process.cwd(), cfg.out)}`);
  log(`  file size        ${mb(html.length)}   (pages ${mb(pageBytes)}, assets ${mb(assetBytes)})`);
  log(`  pages            ${pageCount} captured, ${out.length} unique bodies after dedupe`);
  log(`  assets           ${assets.length} (${jsRewritten} scripts with location virtualised)`);
  const biggest = [...sizes].sort((a, b) => b.packed - a.packed).slice(0, 6);
  log(`  largest bodies   ${biggest.map((s) => `${s.what.slice(0, 70)} ${mb(s.packed)}`).join("\n                   ")}`);
  if (missing.size) {
    const top = [...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    log(`  NOT CAPTURED     ${missing.size} referenced URL(s) will fail offline:`);
    for (const [k, n] of top) log(`                   ${k}  (${n}x)`);
  }
  await fs.writeFile(
    cfg.out.replace(/\.html?$/, "") + ".bundle.json",
    JSON.stringify({ file: cfg.out, bytes: html.length, pageCount, bodies: out.length, missing: Object.fromEntries(missing), sizes }, null, 1),
  );
  return { bytes: html.length };

  // ---------------------------------------------------------------------------

  async function transformJS(buf, key) {
    try {
      const r = await transform(buf.toString("utf8"), {
        loader: "js",
        define: LOCATION_DEFINES,
        minifyWhitespace: true,
        legalComments: "none",
        charset: "utf8",
        target: "esnext",
        logLevel: "silent",
      });
      return Buffer.from(r.code);
    } catch (e) {
      log(`  warn: esbuild could not parse ${key}; left as-is, location in it is NOT virtualised (${e.message.split("\n")[0]})`);
      return buf;
    }
  }

  function tokenFor(raw, base, v) {
    const clean = decodeEntities(raw.trim());
    if (!clean || /^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(clean)) return null;
    let abs;
    try {
      abs = new URL(clean, base).href;
    } catch {
      return null;
    }
    const key = urlKey(canon(abs), origin, origin);
    if (!key) return null;
    const i = lookup(key, v);
    if (i < 0) {
      miss(key);
      return null;
    }
    return `__NOA${i}__`;
  }

  function rewriteCSS(css, base, v) {
    return css
      .replace(/url\(\s*(?:(["'])(.*?)\1|([^)'"\s]+))\s*\)/g, (m, _q, quoted, bare) => {
        const t = tokenFor(quoted ?? bare, base, v);
        return t ? `url(${t})` : m;
      })
      .replace(/@import\s+(["'])(.*?)\1/g, (m, _q, u) => {
        const t = tokenFor(u, base, v);
        return t ? `@import url(${t})` : m;
      });
  }

  function rewriteSrcset(value, base, v) {
    return value
      .split(/\s*,\s+/)
      .map((part) => {
        const bits = part.trim().split(/\s+/);
        const t = bits[0] && tokenFor(bits[0], base, v);
        return t ? [t, ...bits.slice(1)].join(" ") : null;
      })
      .filter(Boolean)
      .join(", ");
  }

  function rewriteTag(tag, base, v) {
    const name = /^<([a-zA-Z][^\s/>]*)/.exec(tag)[1].toLowerCase();
    if (name === "a" || name === "area" || name === "form" || name === "iframe" || name === "base") return tag;
    if (name === "meta") {
      return /http-equiv\s*=\s*["']?refresh/i.test(tag) ? tag.replace(/http-equiv\s*=\s*(["']?)refresh\1/i, "data-no-refresh") : tag;
    }
    if (name === "link") {
      const rel = (attr(tag, "rel") ?? "").toLowerCase();
      if (/\b(dns-prefetch|preconnect|manifest)\b/.test(rel)) return "";
      const href = attr(tag, "href");
      if (href != null && !tokenFor(href, base, v) && /\b(preload|prefetch|modulepreload|prerender)\b/.test(rel)) return "";
    }
    return tag.replace(ATTR_RE, (m, sp, an, eq, _all, dq, sq, bare) => {
      const val = dq ?? sq ?? bare ?? "";
      const lower = an.toLowerCase();
      let next;
      if (lower === "style") {
        next = escAttr(rewriteCSS(decodeEntities(val), base, v));
        return `${sp}${an}="${next}"`;
      }
      if (lower === "srcset" || lower === "imagesrcset") {
        next = rewriteSrcset(decodeEntities(val), base, v);
        return `${sp}${an}="${escAttr(next)}"`;
      }
      const t = tokenFor(val, base, v);
      return t ? `${sp}${an}${eq}"${t}"` : m;
    });
  }

  function rewriteHTML(html, key, v) {
    const base = origin + key;
    let body = html.replace(HTML_RE, (m, so, sb, sc, sto, stb, stc) => {
      if (so) return rewriteTag(so, base, v) + sb + sc;
      if (sto) return sto + rewriteCSS(stb, base, v) + stc;
      if (m.startsWith("<!--")) return m;
      return rewriteTag(m, base, v);
    });
    const inject = `<base href="${escAttr(base)}"><script data-no-shim></script>${pageCSS}`;
    if (/<head\b[^>]*>/i.test(body)) body = body.replace(/<head\b[^>]*>/i, (h) => h + inject);
    else if (/<html\b[^>]*>/i.test(body)) body = body.replace(/<html\b[^>]*>/i, (h) => h + "<head>" + inject + "</head>");
    else body = inject + body;
    return body;
  }
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i").exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;|&#47;/gi, "/")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escHTML(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SHELL_CSS = `
html,body{margin:0;height:100%;overflow:hidden;background:#fff}
.no-frame{position:fixed;inset:0;width:100%;height:100%;border:0;display:block;background:#fff}
.no-frame.loading{visibility:hidden}
#no-loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font:14px system-ui,-apple-system,"Segoe UI",sans-serif;color:#666;background:#fff;z-index:1}
#no-badge{position:fixed;z-index:2147483646;display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:999px;background:rgba(20,20,20,.82);color:#fff;font:500 11px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;opacity:.5;transition:opacity .15s;box-shadow:0 2px 8px rgba(0,0,0,.2)}
#no-badge:hover,#no-badge:focus-within{opacity:1}
#no-badge.bottom-right{right:12px;bottom:12px}#no-badge.bottom-left{left:12px;bottom:12px}#no-badge.top-right{right:12px;top:12px}#no-badge.top-left{left:12px;top:12px}
#no-badge select{font:inherit;color:#fff;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);border-radius:6px;padding:1px 4px}
#no-badge select option{color:#000}
#no-badge .dot{width:7px;height:7px;border-radius:50%;background:#e9b949;flex:none}
#no-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;max-width:min(520px,calc(100vw - 32px));padding:10px 14px;border-radius:8px;background:#1f1f1f;color:#fff;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);opacity:0;transition:opacity .2s;pointer-events:none}
#no-toast.show{opacity:1}
`;
