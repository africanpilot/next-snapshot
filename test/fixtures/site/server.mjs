// A tiny site that behaves, where it matters to next-snapshot, like a Next.js
// app — without needing Next installed. Everything the app does happens in
// external scripts under /static, because only those get their `location`
// references virtualised (inline scripts are left alone, as in a real build).
//
//   /                 home: fetches /api/data, loads /static/lazy.js at runtime,
//                     a router-style link (RSC request, then full navigation),
//                     a select that navigates, replaceState tabs, a POST form
//   /about            a second page
//   /old              307 -> /about
//   /report?period=X  one page per select option
//   /api/data         JSON the home page fetches
//   /api/save         POST target (never reached: capture blocks writes)

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STATIC_DIR = path.join(HERE, "static");

const TYPES = { ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function page(title, main) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/static/style.css">
<link rel="preconnect" href="https://fonts.example.com">
<link rel="preload" href="/static/never-served.js" as="script">
<script src="/static/app.js" defer></script>
</head><body>
<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/about" data-router>About via router</a> <a href="/old">Old link</a></nav>
<main>${main}</main>
<p>location seen by the app: <span id="where"></span></p>
</body></html>`;
}

const HOME = page(
  "Home",
  `<h1>Home</h1>
<div id="data">loading</div>
<div id="lazy">not loaded</div>
<img id="dot" src="/static/dot.svg" srcset="/static/dot.svg 1x, /static/dot-2x.svg 2x" alt="">
<div id="tabs"><button data-tab="a">Tab A</button><button data-tab="b">Tab B</button></div>
<p>tab: <span id="tab">none</span></p>
<p><button id="note">Add a note to the URL</button></p>
<select id="period"><option value="q1">Q1</option><option value="q2">Q2</option></select>
<form method="post" action="/api/save"><input name="note" value="hello"><button type="submit">Save</button></form>
<script type="application/json" id="payload">{"html":"<img src=\\"/static/not-a-reference.svg\\">"}</script>`,
);

export function startFixture() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    hits.push(`${req.method} ${u.pathname}${u.search}`);
    const html = (s, body) => {
      res.writeHead(s, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };

    if (req.method === "POST" && u.pathname === "/api/save") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"saved":true}');
    }
    if (req.method !== "GET" && req.method !== "HEAD") return html(405, "no");

    // Next answers a navigation fetch with an RSC payload; mimic the header check.
    if (req.headers.rsc === "1") {
      res.writeHead(200, { "content-type": "text/x-component" });
      return res.end("0:{}\n");
    }
    if (u.pathname === "/") return html(200, HOME);
    if (u.pathname === "/about") return html(200, page("About", "<h1>About</h1>"));
    if (u.pathname === "/old") {
      res.writeHead(307, { location: "/about" });
      return res.end();
    }
    if (u.pathname === "/report") {
      const p = (u.searchParams.get("period") ?? "none").replace(/[^a-z0-9]/gi, "");
      return html(200, page(`Report ${p}`, `<h1>Report ${p}</h1>`));
    }
    if (u.pathname === "/api/data") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "hello from the api" }));
    }
    if (u.pathname.startsWith("/static/")) {
      const f = path.join(STATIC_DIR, path.basename(u.pathname));
      if (fs.existsSync(f)) {
        res.writeHead(200, { "content-type": TYPES[path.extname(f)] ?? "application/octet-stream" });
        return res.end(fs.readFileSync(f));
      }
    }
    return html(404, page("Not found", "<h1>Not found</h1>"));
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ origin: `http://localhost:${port}`, port, hits, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
