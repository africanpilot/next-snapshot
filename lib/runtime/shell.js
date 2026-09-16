// The outer page of the snapshot. Runs once, in the file:// document.
//
// Holds every captured body, decodes assets into blob: URLs up front, and shows
// one page at a time in a fresh srcdoc <iframe>. A fresh frame per navigation
// is the point: each page boots exactly as it did from the server, with no
// framework state carried over from the last one. The frame talks back through
// window.__NO (same origin, so plain function calls).
//
// Placeholders filled by bundle.mjs: URLKEY, FRAME, POST.
(async function () {
  "use strict";
  var urlKey = /*@URLKEY@*/null;
  var FRAME_SRC = /*@FRAME@*/"";
  var POST = /*@POST@*/{};

  var M = JSON.parse(document.getElementById("no-manifest").textContent);
  var ORIGIN = M.origin;
  var td = new TextDecoder();
  var multi = M.variants.length > 1;
  var NO = (window.__NO = { origin: ORIGIN, manifest: M, reports: [], ready: false, seq: 0, loaded: null, cookies: {} });
  var ALIASES = M.aliases || [];
  // Another spelling of the app's own origin (localhost vs 127.0.0.1) is the app.
  NO.canon = function (href) {
    href = String(href);
    for (var i = 0; i < ALIASES.length; i++) {
      var a = ALIASES[i];
      if (href === a || href.indexOf(a + "/") === 0 || href.indexOf(a + "?") === 0) return ORIGIN + href.slice(a.length);
    }
    return href;
  };
  NO.key = function (u, base) {
    var abs;
    try { abs = new URL(u, base || ORIGIN).href; } catch (e) { return null; }
    return urlKey(NO.canon(abs), ORIGIN, ORIGIN);
  };

  // --- bodies -------------------------------------------------------------------
  function b64(s) {
    if (Uint8Array.fromBase64) return Uint8Array.fromBase64(s);
    var bin = atob(s), n = bin.length, a = new Uint8Array(n);
    for (var i = 0; i < n; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  // Pages may be packed in clusters: many of them compressed as one stream,
  // because pages of an app repeat each other and gzip cannot see past one
  // page. A cluster is decoded on first use and the last few are kept.
  var LOCS = M.locs || null;
  var clusterCache = new Map();
  function cluster(i) {
    var hit = clusterCache.get(i);
    if (hit) return hit;
    var p = (async function () {
      var el = document.getElementById("no-c" + i);
      if (!el) throw new Error("snapshot cluster " + i + " is missing");
      return fzstd.decompress(b64(el.textContent.trim()));
    })();
    clusterCache.set(i, p);
    // Three decoded clusters is a few MB; older ones cost nothing to redo.
    if (clusterCache.size > 3) clusterCache.delete(clusterCache.keys().next().value);
    return p;
  }

  var kept = {};
  function body(id, keep) {
    if (kept[id]) return kept[id];
    var loc = LOCS && LOCS[id];
    var p = loc
      ? cluster(loc[0]).then(function (bytes) {
          return bytes.subarray(loc[1], loc[1] + loc[2]);
        })
      : (async function () {
          var el = document.getElementById("no-b" + id);
          if (!el) throw new Error("snapshot body " + id + " is missing");
          var stream = new Blob([b64(el.textContent.trim())]).stream().pipeThrough(new DecompressionStream("gzip"));
          return new Uint8Array(await new Response(stream).arrayBuffer());
        })();
    if (keep) kept[id] = p;
    return p;
  }

  // --- assets -----------------------------------------------------------------------
  var A = M.assets.map(function (r) {
    return { k: r[0], v: r[1], b: r[2], t: r[3] || "application/octet-stream", s: r[4] || 200 };
  });
  var idx = {};
  A.forEach(function (a, i) {
    idx[(a.v || "") + "\u0000" + a.k] = i;
  });
  var variant = M.defaultVariant;
  function lookup(key, v) {
    if (key == null) return -1;
    var i = idx[(v || "") + "\u0000" + key];
    if (i == null) i = idx["\u0000" + key];
    if (i == null && key.indexOf("?") > 0 && key.indexOf("/_next/static/") === 0) i = idx["\u0000" + key.split("?")[0]];
    return i == null ? -1 : i;
  }
  var bytes = await Promise.all(A.map(function (a) { return body(a.b, true); }));
  var urls = [], orig = {};
  function assetURL(i) {
    if (urls[i]) return urls[i];
    var a = A[i], blob;
    if (/css/i.test(a.t)) {
      urls[i] = "data:,"; // cycle guard for CSS that imports itself
      blob = new Blob([tokens(td.decode(bytes[i]))], { type: a.t });
    } else {
      blob = new Blob([bytes[i]], { type: a.t });
    }
    var u = URL.createObjectURL(blob);
    urls[i] = u;
    orig[u] = a.k;
    return u;
  }
  function tokens(text) {
    return text.replace(/__NOA(\d+)__/g, function (_, i) { return assetURL(+i); });
  }
  for (var i = 0; i < A.length; i++) assetURL(i);

  NO.assetIndex = function (href) { return lookup(NO.key(href), variant); };
  NO.assetURLFor = function (href) {
    var i = NO.assetIndex(href);
    return i < 0 ? null : urls[i];
  };
  NO.unmap = function (u) { return orig[u]; };
  NO.isAsset = function (href) {
    var key = NO.key(href), P = M.pages[variant] || {};
    return !P[key] && lookup(key, variant) >= 0;
  };
  NO.fetch = async function (href) {
    var key = NO.key(href);
    if (key == null) return null;
    var i = lookup(key, variant);
    if (i >= 0) {
      var a = A[i];
      var b = /css/i.test(a.t) ? new TextEncoder().encode(tokens(td.decode(bytes[i]))) : bytes[i];
      return { status: a.s, type: a.t, bytes: b };
    }
    var r = resolvePage(key, variant);
    if (r.entry && r.entry.b != null) {
      var html = tokens(td.decode(await body(r.entry.b)));
      return { status: r.entry.s || 200, type: "text/html; charset=utf-8", bytes: new TextEncoder().encode(html) };
    }
    return null;
  };

  // --- pages & navigation ---------------------------------------------------------------
  function resolvePage(key, v) {
    var P = M.pages[v] || {}, hops = 0;
    while (P[key] && P[key].r != null && hops++ < 20) key = P[key].r;
    return { key: key, entry: P[key] || null };
  }
  NO.resolve = function (v, key) { return resolvePage(key, v).key; };
  NO.hasPage = function (href) {
    var key = NO.key(href);
    if (key == null) return false;
    var r = resolvePage(key, variant);
    return !!(r.entry && (r.entry.b != null || r.entry.a != null)) || !!soft[variant + "\u0000" + r.key];
  };
  NO.listPages = function () {
    var out = [];
    M.variants.forEach(function (v) {
      var P = M.pages[v.id] || {};
      Object.keys(P).forEach(function (k) { if (P[k].b != null) out.push({ variant: v.id, key: k }); });
    });
    return out;
  };

  var current = null, frame = null, pending = null;

  function hashFor(v, key, h) {
    return "#" + (multi ? encodeURIComponent(v) + ":" : "") + key + (h || "");
  }
  function parseHash() {
    var h = location.hash.slice(1);
    if (!h) return null;
    var v = variant, m = /^([^:\/?#]+):(\/.*)?$/.exec(h);
    if (m) { v = decodeURIComponent(m[1]); h = m[2] || "/"; }
    if (h.charAt(0) !== "/") return null;
    var hi = h.indexOf("#"), frag = "";
    if (hi >= 0) { frag = h.slice(hi); h = h.slice(0, hi); }
    return { variant: v, key: NO.key(ORIGIN + h), hash: frag };
  }
  function writeHash(mode) {
    var h = hashFor(current.variant, current.key, current.hash);
    if (location.hash === h) return;
    try {
      if (mode === "push") history.pushState(null, "", h);
      else history.replaceState(null, "", h);
    } catch (e) {
      /* some file:// contexts refuse; the hash is a convenience */
    }
  }

  async function load(v, rawKey, hash, mode) {
    var seq = ++NO.seq;
    if (!M.pages[v]) v = M.defaultVariant;
    setVariant(v);
    var r = resolvePage(rawKey, v), e = r.entry, html, base = r.key;
    if (!e && soft[v + "\u0000" + r.key]) {
      var sr = resolvePage(soft[v + "\u0000" + r.key], v);
      if (sr.entry && sr.entry.b != null) { e = sr.entry; base = sr.key; }
    }
    if (e && e.a != null) { openAssetIndex(e.a); return; }
    if (e && e.b != null) html = tokens(td.decode(await body(e.b)));
    else { html = missingHTML(v, r.key); NO.report("missing", r.key); }
    if (seq !== NO.seq) return; // a later navigation won
    current = { variant: v, key: r.key, hash: hash || "", base: base };
    writeHash(mode);
    mount(html, seq);
  }

  function mount(html, seq) {
    html = html.replace("<script data-no-shim></script>", function () {
      return "<script data-no-shim>" + FRAME_SRC + "<\/script>";
    });
    NO.frameState = { url: ORIGIN + current.key + current.hash, seq: seq };
    var f = document.createElement("iframe");
    f.className = "no-frame loading";
    f.setAttribute("title", M.title || "Application");
    f.addEventListener("load", function () {
      NO.frameReady(f.contentWindow, seq);
      if (seq === NO.seq) {
        NO.loaded = { variant: current.variant, key: current.key, seq: seq };
        syncTitle(f.contentWindow);
      }
    });
    if (pending && pending !== frame) pending.remove();
    pending = f;
    f.srcdoc = html;
    document.body.appendChild(f);
  }

  NO.frameReady = function (win, seq) {
    if (seq !== NO.seq || !pending || pending.contentWindow !== win) return;
    var f = pending;
    if (frame && frame !== f) frame.remove();
    frame = f;
    pending = null;
    f.classList.remove("loading");
    var l = document.getElementById("no-loading");
    if (l) l.remove();
    try { win.focus(); } catch (e) {}
  };

  NO.navigate = function (href, opts) {
    var u = new URL(href, ORIGIN + (current ? current.key : "/"));
    if (u.origin !== ORIGIN) { window.open(u.href, "_blank", "noopener"); return; }
    var key = NO.key(u.href), P = M.pages[variant] || {};
    if (!P[key]) {
      var i = lookup(key, variant);
      if (i >= 0) { openAssetIndex(i); return; }
    }
    load(variant, key, u.hash, opts && opts.replace ? "replace" : "push");
  };
  NO.go = function (v, key) { load(v, key, "", "push"); };
  NO.reload = function () { if (current) load(variant, current.key, current.hash, "replace"); };
  // URLs the app wrote itself (a tab that calls history.replaceState) may never
  // have been captured. Remember which captured page they were reached from, so
  // coming back to one — reload, back/forward — serves that page at this URL
  // and lets the app's own code read the parameters, instead of a dead end.
  // Kept in sessionStorage (per tab, per snapshot) so a reload still knows.
  var SOFT_KEY = "next-snapshot:soft:" + M.createdAt;
  var soft = {};
  try { soft = JSON.parse(sessionStorage.getItem(SOFT_KEY) || "{}") || {}; } catch (e) { soft = {}; }
  function saveSoft() {
    try { sessionStorage.setItem(SOFT_KEY, JSON.stringify(soft)); } catch (e) { /* storage refused: in-memory only */ }
  }
  NO.frameHistory = function (href, mode) {
    var u = new URL(href), key = NO.key(u.href);
    var base = current ? current.base || current.key : null;
    if (base && !(M.pages[variant] || {})[key]) soft[variant + "\u0000" + key] = base;
    saveSoft();
    current = { variant: variant, key: key, hash: u.hash, base: base };
    writeHash(mode === "push" ? "push" : "replace");
  };
  NO.openInNewTab = function (href) {
    var u = new URL(href, ORIGIN);
    window.open(location.href.split("#")[0] + hashFor(variant, NO.key(u.href), u.hash), "_blank");
  };
  NO.openAsset = function (href, name) {
    var i = NO.assetIndex(href);
    if (i >= 0) openAssetIndex(i, name);
  };
  function openAssetIndex(i, name) {
    var a = document.createElement("a"), t = A[i].t;
    a.href = urls[i];
    if (name != null || !/^(text\/html|text\/plain|image\/|application\/pdf)/.test(t)) {
      a.download = name || A[i].k.split("?")[0].split("/").pop() || "download";
    } else {
      a.target = "_blank";
    }
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function onHistory() {
    var p = parseHash();
    if (!p) return;
    if (current && p.variant === current.variant && p.key === current.key) {
      if (p.hash !== current.hash) current.hash = p.hash;
      return;
    }
    load(p.variant, p.key, p.hash, "replace");
  }
  window.addEventListener("popstate", onHistory);
  window.addEventListener("hashchange", onHistory);

  // --- writes: forms and fetches that are not GET ---------------------------------------
  // A configured handler can emulate a POST in the browser (sign in as a role,
  // sign out). Anything else is refused: the snapshot is read-only.
  function runHandler(href, method, fields) {
    var u = new URL(href, ORIGIN), h = POST[u.pathname];
    if (!h) {
      toast("This is a read-only offline snapshot — changes can’t be saved.");
      NO.report("write", method.toUpperCase() + " " + NO.key(u.href));
      return false;
    }
    var res;
    try {
      res = h(fields || {}, { variant: variant, key: current && current.key }) || {};
    } catch (e) {
      NO.report("error", "offline.post handler for " + u.pathname + ": " + e.message);
      return false;
    }
    if (res.message) toast(res.message);
    var changed = res.variant && M.pages[res.variant] && res.variant !== variant;
    if (changed) setVariant(res.variant);
    if (res.location) setTimeout(function () { load(variant, NO.key(new URL(res.location, ORIGIN).href), "", "push"); }, 0);
    else if (changed) setTimeout(NO.reload, 0);
    return true;
  }
  NO.submit = function (href, method, fields) { runHandler(href, method, fields); };
  NO.write = function (href, method, fields) { return runHandler(href, method, fields); };

  // --- chrome: badge, toast, title -----------------------------------------------------------
  var badge = null;
  function label(v) {
    for (var i = 0; i < M.variants.length; i++) if (M.variants[i].id === v) return M.variants[i].label || v;
    return v;
  }
  function setVariant(v) {
    if (v === variant) return;
    variant = v;
    renderBadge();
  }
  function renderBadge() {
    if (!M.badge) return;
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "no-badge";
      badge.className = String(M.badge);
      document.body.appendChild(badge);
    }
    var when = "";
    try { when = new Date(M.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); } catch (e) {}
    badge.innerHTML = "";
    var dot = document.createElement("span");
    dot.className = "dot";
    var txt = document.createElement("span");
    txt.textContent = "Offline snapshot" + (when ? " · " + when : "");
    txt.title = "Captured " + M.createdAt + " from " + ORIGIN + ". Read-only: nothing here reaches a server.";
    badge.appendChild(dot);
    badge.appendChild(txt);
    if (multi && M.switcher !== false) {
      var sel = document.createElement("select");
      sel.setAttribute("aria-label", "View as");
      M.variants.forEach(function (v) {
        var o = document.createElement("option");
        o.value = v.id;
        o.textContent = v.label || v.id;
        if (v.id === variant) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () {
        setVariant(sel.value);
        load(sel.value, current ? current.key : M.start, "", "push");
      });
      badge.appendChild(sel);
    }
  }
  var toastEl = null, toastTimer = 0;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "no-toast";
      toastEl.setAttribute("role", "status");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 3500);
  }
  NO.toast = toast;
  function syncTitle(win) {
    try { document.title = win.document.title || M.title || document.title; } catch (e) {}
  }
  NO.title = function (win, t) { if (frame && frame.contentWindow === win && t) document.title = t; };

  // --- diagnostics (read by `next-snapshot verify`) ---------------------------------------------
  NO.report = function (kind, detail) {
    var r = { kind: kind, detail: String(detail).slice(0, 600), key: current && current.key, variant: variant };
    NO.reports.push(r);
    if (NO.reports.length > 2000) NO.reports.shift();
    if (kind !== "write" && kind !== "missing") console.warn("[next-snapshot] " + kind + ": " + r.detail);
  };
  NO.drainReports = function () { var r = NO.reports; NO.reports = []; return r; };
  NO.hydrated = function () {
    var d = frame && frame.contentDocument;
    if (!d) return false;
    var els = [d, d.documentElement, d.head, d.body].concat([].slice.call(d.body ? d.body.querySelectorAll("*") : [], 0, 40));
    return els.some(function (el) {
      return el && Object.keys(el).some(function (k) { return k.indexOf("__react") === 0; });
    });
  };
  NO.frame = function () { return frame; };

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }
  function missingHTML(v, key) {
    var P = M.pages[v] || {}, path = key.split("?")[0];
    var pages = Object.keys(P).filter(function (k) { return P[k].b != null; }).sort();
    var near = pages.filter(function (k) { return k.split("?")[0] === path; }).slice(0, 40);
    var top = pages.filter(function (k) { return k.indexOf("?") < 0; }).slice(0, 200);
    function li(k) { return '<li><a href="' + esc(k) + '">' + esc(k) + "</a></li>"; }
    return (
      '<!doctype html><html><head><base href="' + esc(ORIGIN + key) + '"><script data-no-shim></script>' +
      '<meta charset="utf-8"><title>Not in this snapshot</title><style>body{font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:48px auto;padding:0 24px;color:#222;max-width:760px}' +
      "code{background:#f2f2f2;padding:1px 5px;border-radius:4px}a{color:#0b57d0}li{margin:3px 0}h2{font-size:15px;margin-top:28px}</style></head><body>" +
      '<h1 style="font-size:20px">This view isn’t in the offline snapshot</h1><p><code>' + esc(key) + "</code> was not captured" +
      (multi ? " for <b>" + esc(label(v)) + "</b>" : "") +
      ". A snapshot holds only the pages its capture visited; add this URL to the config’s <code>seeds</code> to include it.</p>" +
      (near.length ? "<h2>Captured views of this page</h2><ul>" + near.map(li).join("") + "</ul>" : "") +
      "<h2>Captured pages</h2><ul>" + top.map(li).join("") + "</ul></body></html>"
    );
  }

  // --- boot ------------------------------------------------------------------------------------
  var start = parseHash();
  if (start && M.pages[start.variant]) variant = start.variant;
  renderBadge();
  NO.ready = true;
  if (start) load(variant, start.key, start.hash, "replace");
  else load(variant, M.start, "", "replace");
})().catch(function (e) {
  var l = document.getElementById("no-loading");
  if (l) l.textContent = "This snapshot could not open: " + (e && e.message ? e.message : e);
  console.error(e);
});
