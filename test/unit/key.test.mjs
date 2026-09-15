import assert from "node:assert/strict";
import { test } from "node:test";

import { urlKey } from "../../lib/key.js";

const O = "http://localhost:3000";

test("same-origin URLs key as path + query", () => {
  assert.equal(urlKey("/reports", O, O), "/reports");
  assert.equal(urlKey("http://localhost:3000/reports?x=1", O, O), "/reports?x=1");
});

test("parameters are sorted by name, so order does not make a second page", () => {
  assert.equal(urlKey("/r?b=2&a=1", O, O), "/r?a=1&b=2");
  assert.equal(urlKey("/r?a=1&b=2", O, O), "/r?a=1&b=2");
});

test("repeated parameters keep their relative order", () => {
  assert.equal(urlKey("/r?t=2&a=0&t=1", O, O), "/r?a=0&t=2&t=1");
});

test("Next's _rsc cache-buster is dropped", () => {
  assert.equal(urlKey("/r?_rsc=abc123&x=1", O, O), "/r?x=1");
  assert.equal(urlKey("/r?_rsc=abc123", O, O), "/r");
});

test("the fragment never matters", () => {
  assert.equal(urlKey("/r?x=1#section", O, O), "/r?x=1");
});

test("a trailing slash is dropped from every path but the root", () => {
  assert.equal(urlKey("/reports/", O, O), "/reports");
  assert.equal(urlKey("/", O, O), "/");
  assert.equal(urlKey(O, O, O), "/");
});

test("relative URLs resolve against the base, not the origin", () => {
  assert.equal(urlKey("../media/f.woff2", `${O}/_next/static/css/a.css`, O), "/_next/static/media/f.woff2");
});

test("cross-origin URLs key as absolute URLs", () => {
  assert.equal(urlKey("https://fonts.example.com/a.css?family=X", O, O), "https://fonts.example.com/a.css?family=X");
});

test("non-http(s) and unparsable URLs have no key", () => {
  assert.equal(urlKey("data:text/plain,hi", O, O), null);
  assert.equal(urlKey("mailto:a@b.c", O, O), null);
  assert.equal(urlKey("http://[bad", O, O), null);
});

test("the source is self-contained, because the runtime receives it as text", () => {
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return (${urlKey.toString()})`)();
  assert.equal(fn("/r?b=2&a=1&_rsc=z#h", O, O), "/r?a=1&b=2");
});
