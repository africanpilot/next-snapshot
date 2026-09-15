import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalizer, createRewriter, decodeEntities, serialisePost, virtualiseLocation } from "../../lib/rewrite.mjs";

const O = "http://localhost:3000";
const ASSETS = ["/a.js", "/s.css", "/i.png", "/_next/static/media/f.woff2", "/i@2x.png", "https://cdn.example.com/lib.js"];

function rewriter(extra = {}) {
  const missing = [];
  const r = createRewriter({
    origin: O,
    aliases: ["http://127.0.0.1:3000"],
    lookup: (key) => ASSETS.indexOf(key),
    onMiss: (k) => missing.push(k),
    ...extra,
  });
  return { ...r, missing };
}

test("script, link and img URLs become tokens by asset index", () => {
  const { rewriteTag } = rewriter();
  assert.equal(rewriteTag('<script src="/a.js" async>', `${O}/`), '<script src="__NOA0__" async>');
  assert.equal(rewriteTag('<link rel="stylesheet" href="/s.css">', `${O}/`), '<link rel="stylesheet" href="__NOA1__">');
  assert.equal(rewriteTag("<img src='/i.png'>", `${O}/`), '<img src="__NOA2__">');
});

test("relative, absolute, alias-origin and cross-origin references all resolve", () => {
  const { tokenFor } = rewriter();
  assert.equal(tokenFor("i.png", `${O}/`), "__NOA2__");
  assert.equal(tokenFor(`${O}/i.png`, `${O}/x`), "__NOA2__");
  assert.equal(tokenFor("http://127.0.0.1:3000/i.png", `${O}/x`), "__NOA2__");
  assert.equal(tokenFor("https://cdn.example.com/lib.js", `${O}/`), "__NOA5__");
});

test("a reference to nothing captured is left alone and reported", () => {
  const { rewriteTag, missing } = rewriter();
  assert.equal(rewriteTag('<img src="/gone.png">', `${O}/`), '<img src="/gone.png">');
  assert.deepEqual(missing, ["/gone.png"]);
});

test("navigation targets are not assets", () => {
  const { rewriteTag } = rewriter();
  for (const tag of ['<a href="/i.png">', '<form action="/a.js">', '<iframe src="/i.png">', '<base href="/">']) {
    assert.equal(rewriteTag(tag, `${O}/`), tag);
  }
});

test("network hints are removed; a preload of something uncaptured is removed", () => {
  const { rewriteTag } = rewriter();
  assert.equal(rewriteTag('<link rel="preconnect" href="https://fonts.example.com">', `${O}/`), "");
  assert.equal(rewriteTag('<link rel="dns-prefetch" href="//x.com">', `${O}/`), "");
  assert.equal(rewriteTag('<link rel="manifest" href="/m.json">', `${O}/`), "");
  assert.equal(rewriteTag('<link rel="preload" href="/gone.js" as="script">', `${O}/`), "");
  assert.equal(rewriteTag('<link rel="preload" href="/a.js" as="script">', `${O}/`), '<link rel="preload" href="__NOA0__" as="script">');
});

test("a meta refresh is disarmed so the runtime can perform it instead", () => {
  const { rewriteTag } = rewriter();
  assert.equal(rewriteTag('<meta http-equiv="refresh" content="0;url=/x">', `${O}/`), '<meta data-no-refresh content="0;url=/x">');
});

test("srcset keeps captured candidates and drops the rest", () => {
  const { rewriteSrcset } = rewriter();
  assert.equal(rewriteSrcset("/i.png 1x, /i@2x.png 2x, /i@3x.png 3x", `${O}/`), "__NOA2__ 1x, __NOA4__ 2x");
  assert.equal(rewriteSrcset("/nope.png 1x", `${O}/`), "");
});

test("entity-encoded attribute values are decoded before lookup", () => {
  const { tokenFor } = createRewriter({ origin: O, lookup: (k) => (k === "/img?a=1&w=64" ? 7 : -1) });
  assert.equal(tokenFor("/img?w=64&amp;a=1", `${O}/`), "__NOA7__");
});

test("CSS url() — quoted, bare, relative to the stylesheet — and @import", () => {
  const { rewriteCSS } = rewriter();
  const css = `@font-face{src:url("../media/f.woff2")} a{background:url(/i.png)} b{background:url('data:image/png;base64,xx')} @import "/s.css";`;
  assert.equal(
    rewriteCSS(css, `${O}/_next/static/css/app.css`),
    `@font-face{src:url(__NOA3__)} a{background:url(__NOA2__)} b{background:url('data:image/png;base64,xx')} @import url(__NOA1__);`,
  );
});

test("style attributes are rewritten, entities and all", () => {
  const { rewriteTag } = rewriter();
  assert.equal(
    rewriteTag(`<div style="background:url(&quot;/i.png&quot;)">`, `${O}/`),
    '<div style="background:url(__NOA2__)">',
  );
});

test("rewriteHTML injects <base> and the shim placeholder first in <head>", () => {
  const { rewriteHTML } = rewriter({ pageCSS: "<style data-no-css>x{}</style>" });
  const out = rewriteHTML('<!doctype html><html><head><meta charset="utf-8"><script src="/a.js"></script></head><body></body></html>', "/r?x=1");
  assert.match(out, /<head><base href="http:\/\/localhost:3000\/r\?x=1"><script data-no-shim><\/script><style data-no-css>x\{\}<\/style><meta charset="utf-8">/);
  assert.match(out, /<script src="__NOA0__"><\/script>/);
});

test("rewriteHTML adds a <head> when a page has none", () => {
  const { rewriteHTML } = rewriter();
  assert.match(rewriteHTML("<html><body>x</body></html>", "/"), /^<html><head><base href="http:\/\/localhost:3000\/"><script data-no-shim><\/script><\/head>/);
  assert.match(rewriteHTML("<p>fragment</p>", "/"), /^<base href="http:\/\/localhost:3000\/"><script data-no-shim><\/script><p>/);
});

test("inline script bodies and comments are never rewritten", () => {
  const { rewriteHTML } = rewriter();
  const html = `<head></head><script>self.__next_f.push([1,"<img src=\\"/i.png\\">"])</script><!-- <img src="/i.png"> --><img src="/i.png">`;
  const out = rewriteHTML(html, "/");
  assert.ok(out.includes('self.__next_f.push([1,"<img src=\\"/i.png\\">"])'));
  assert.ok(out.includes('<!-- <img src="/i.png"> -->'));
  assert.ok(out.endsWith('<img src="__NOA2__">'));
});

test("a tag whose attribute value contains '>' is still one tag", () => {
  const { rewriteHTML } = rewriter();
  const out = rewriteHTML(`<head></head><img alt="a > b" src="/i.png">`, "/");
  assert.ok(out.endsWith('<img alt="a > b" src="__NOA2__">'));
});

test("canonicalizer maps only exact alias origins", () => {
  const canon = canonicalizer(O, ["http://127.0.0.1:3000"]);
  assert.equal(canon("http://127.0.0.1:3000/x"), `${O}/x`);
  assert.equal(canon("http://127.0.0.1:3000?q"), `${O}?q`);
  assert.equal(canon("http://127.0.0.1:30001/x"), "http://127.0.0.1:30001/x");
});

test("decodeEntities handles named, decimal and hex references", () => {
  assert.equal(decodeEntities("a&amp;b&quot;&#39;&#x2F;&#65;&#x42;"), `a&b"'/AB`);
});

test("virtualiseLocation rewrites the global only", async () => {
  const out = await virtualiseLocation(
    'var a = location.href; window.location.assign("/x"); function f(location) { return location.y } var s = "location";',
  );
  assert.match(out, /__NOloc\.href/);
  assert.match(out, /__NOloc\.assign\("\/x"\)/);
  assert.match(out, /return \w+\.y/); // the parameter survives, renamed or not
  assert.doesNotMatch(out, /function f\(__NOloc\)/);
  assert.match(out, /"location"/);
});

test("virtualiseLocation turns an assignment to location into one to __NOloc", async () => {
  // The runtime defines __NOloc as an accessor, so this navigates.
  assert.match(await virtualiseLocation('window.location = "/next";'), /__NOloc\s*=\s*"\/next"/);
});

test("virtualiseLocation throws on code that does not parse", async () => {
  await assert.rejects(virtualiseLocation("function ("));
});

test("serialisePost keeps arrows and function expressions, refuses method shorthand", () => {
  const src = serialisePost({
    "/a": (f) => ({ location: f.next }),
    "/b": function (f) {
      return { variant: f.role };
    },
  });
  const obj = new Function(`return ${src}`)(); // eslint-disable-line no-new-func
  assert.deepEqual(obj["/a"]({ next: "/x" }), { location: "/x" });
  assert.deepEqual(obj["/b"]({ role: "r" }), { variant: "r" });
  const shorthand = {
    signin(f) {
      return f;
    },
  };
  assert.throws(() => serialisePost({ "/c": shorthand.signin }), /method shorthand/);
  assert.throws(() => serialisePost({ "/d": "not a function" }), /must be a function/);
  assert.equal(serialisePost(), "{}");
});
