// The bundle's transformations, as pure functions of their input so each can be
// tested without a capture on disk.
//
//   createRewriter   HTML and CSS: asset URLs become __NOA<n>__ tokens the
//                    runtime swaps for blob: URLs; <base> + shim go first.
//   virtualiseLocation  JS: every global `location` becomes `__NOloc`.
//   serialisePost    offline.post handlers, as source text for the file.

import { transform } from "esbuild";

import { urlKey } from "./key.js";

const TAG = String.raw`<[a-zA-Z][^\s/>]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?)*\s*/?>`;
const HTML_RE = new RegExp(
  String.raw`(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(</script\s*>)|(<style\b[^>]*>)([\s\S]*?)(</style\s*>)|<!--[\s\S]*?-->|${TAG}`,
  "gi",
);
const ATTR_RE = /(\s)(src|href|srcset|imagesrcset|poster|xlink:href|style)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

const LOCATION_DEFINES = {
  location: "__NOloc",
  "window.location": "__NOloc",
  "self.location": "__NOloc",
  "globalThis.location": "__NOloc",
  "document.location": "__NOloc",
};

/** Maps a URL on any alias of the app's origin onto the origin itself. */
export function canonicalizer(origin, aliases = []) {
  return (u) => {
    for (const a of aliases) if (u === a || u.startsWith(a + "/") || u.startsWith(a + "?")) return origin + u.slice(a.length);
    return u;
  };
}

/**
 * @param {object} o
 * @param {string} o.origin          the captured app's origin
 * @param {string[]} [o.aliases]     other spellings of that origin
 * @param {(key: string, variant: string|null) => number} o.lookup  asset index, or -1
 * @param {string} [o.pageCSS]       markup appended after the shim in every page
 * @param {(key: string) => void} [o.onMiss]  told of each reference to nothing captured
 */
export function createRewriter({ origin, aliases = [], lookup, pageCSS = "", onMiss = () => {} }) {
  const canon = canonicalizer(origin, aliases);

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
      onMiss(key);
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

  // Candidates that were never captured are dropped rather than left to fail;
  // the element falls back to its `src`.
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
    // Navigation targets are not assets: the runtime intercepts them instead.
    if (name === "a" || name === "area" || name === "form" || name === "iframe" || name === "base") return tag;
    if (name === "meta") {
      return /http-equiv\s*=\s*["']?refresh/i.test(tag) ? tag.replace(/http-equiv\s*=\s*(["']?)refresh\1/i, "data-no-refresh") : tag;
    }
    if (name === "link") {
      const rel = (attr(tag, "rel") ?? "").toLowerCase();
      // Hints at the network have nothing to hint at offline.
      if (/\b(dns-prefetch|preconnect|manifest)\b/.test(rel)) return "";
      const href = attr(tag, "href");
      if (href != null && !tokenFor(href, base, v) && /\b(preload|prefetch|modulepreload|prerender)\b/.test(rel)) return "";
    }
    return tag.replace(ATTR_RE, (m, sp, an, eq, _all, dq, sq, bare) => {
      const val = dq ?? sq ?? bare ?? "";
      const lower = an.toLowerCase();
      if (lower === "style") return `${sp}${an}="${escAttr(rewriteCSS(decodeEntities(val), base, v))}"`;
      if (lower === "srcset" || lower === "imagesrcset") return `${sp}${an}="${escAttr(rewriteSrcset(decodeEntities(val), base, v))}"`;
      const t = tokenFor(val, base, v);
      return t ? `${sp}${an}${eq}"${t}"` : m;
    });
  }

  // Inline <script> bodies are never touched: they are code (often a JSON
  // payload), and a URL inside a string there is data, not a reference.
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

  return { tokenFor, rewriteCSS, rewriteSrcset, rewriteTag, rewriteHTML };
}

/**
 * Rewrite every reference to the global `location` to `__NOloc`. esbuild's
 * `define` only replaces unbound identifiers, so strings and a local variable
 * that happens to be called `location` are left alone. Throws if the code does
 * not parse.
 */
export async function virtualiseLocation(code) {
  const r = await transform(code, {
    loader: "js",
    define: LOCATION_DEFINES,
    minifyWhitespace: true,
    legalComments: "none",
    charset: "utf8",
    target: "esnext",
    logLevel: "silent",
  });
  return r.code;
}

/**
 * offline.post handlers as the source of an object literal. They run in the
 * browser, so they are serialised with Function#toString — which is why method
 * shorthand (`signin(form) {}`) is refused: its source is not an expression.
 */
export function serialisePost(post = {}) {
  const entries = Object.entries(post).map(([p, fn]) => {
    if (typeof fn !== "function") throw new Error(`offline.post["${p}"] must be a function`);
    const src = fn.toString();
    if (!/^(async\s*)?(\(|function\b|[A-Za-z_$][\w$]*\s*=>)/.test(src)) {
      throw new Error(`offline.post["${p}"] must be an arrow function or function expression (method shorthand cannot be serialised)`);
    }
    return `${JSON.stringify(p)}: (${src})`;
  });
  return `{${entries.join(",\n")}}`;
}

export function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i").exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
}

export function decodeEntities(s) {
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

export function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function escHTML(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
