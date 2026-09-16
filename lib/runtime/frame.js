// Runs first in every page frame, before any of the app's own scripts.
//
// The page believes it is at its real URL (http://host/path?query). It is
// actually in an about:srcdoc frame inside a file:// document, with no server.
// This shim closes that gap:
//
//   location   the bundler rewrote every `location` reference in the app's
//              scripts to `__NOloc`; this defines it, reporting the virtual URL
//              and turning assignments into snapshot navigations.
//   history    pushState/replaceState record the virtual URL and mirror it into
//              the outer page's hash, instead of throwing on a path change.
//   fetch/XHR  served from the snapshot. Next's RSC requests get a non-RSC
//              answer on purpose: Next then falls back to a full navigation,
//              which the shell turns into a fresh frame of the captured HTML.
//   URLs       any script/link/img src the app sets at runtime is mapped to the
//              asset's blob: URL; reads give the original back, so a chunk
//              loader that looks itself up by src still finds itself.
//   clicks     plain same-origin links and GET forms navigate in the snapshot;
//              POST forms go to the configured handlers or are refused.
//
// Must not contain the character sequence that closes a script element.
(function () {
  "use strict";
  var W = window, P = W.parent, NO = P && P.__NO;
  if (!NO || !NO.frameState) return;
  var SEQ = NO.frameState.seq;
  var cur = new URL(NO.frameState.url);
  var D = W.document;
  var EP = W.Element.prototype, ga = EP.getAttribute, sa = EP.setAttribute, san = EP.setAttributeNS;

  function abs(u) { return new URL(NO.canon(new URL(String(u), cur.href).href)); }
  function live() { return NO.seq === SEQ; }
  function report(kind, detail) { if (live()) NO.report(kind, detail); }

  // --- location ------------------------------------------------------------------
  function scrollToHash() {
    if (!cur.hash || cur.hash === "#") return;
    var id = decodeURIComponent(cur.hash.slice(1));
    var el = D.getElementById(id) || D.getElementsByName(id)[0];
    if (el && el.scrollIntoView) el.scrollIntoView();
  }
  function go(v, replace) {
    var u;
    try { u = abs(v); } catch (e) { return; }
    if (u.origin === cur.origin && u.pathname === cur.pathname && u.search === cur.search && u.hash) {
      var old = cur.href;
      cur = u;
      if (live()) NO.frameHistory(u.href, replace ? "replace" : "push");
      scrollToHash();
      try { W.dispatchEvent(new W.HashChangeEvent("hashchange", { oldURL: old, newURL: u.href })); } catch (e) {}
      return;
    }
    if (live()) NO.navigate(u.href, { replace: !!replace });
  }
  function edit(part) {
    return function (v) { var u = new URL(cur.href); u[part] = v; go(u.href); };
  }
  var loc = {
    get href() { return cur.href; }, set href(v) { go(v); },
    get origin() { return cur.origin; },
    get protocol() { return cur.protocol; }, set protocol(v) {},
    get host() { return cur.host; }, set host(v) {},
    get hostname() { return cur.hostname; }, set hostname(v) {},
    get port() { return cur.port; }, set port(v) {},
    get pathname() { return cur.pathname; }, set pathname(v) { edit("pathname")(v); },
    get search() { return cur.search; }, set search(v) { edit("search")(v); },
    get hash() { return cur.hash; }, set hash(v) { edit("hash")(v); },
    get ancestorOrigins() { return W.location.ancestorOrigins; },
    assign: function (v) { go(v); },
    replace: function (v) { go(v, true); },
    reload: function () { if (live()) NO.reload(); },
    toString: function () { return cur.href; },
  };
  // An accessor, so `location = "/x"` (rewritten to `__NOloc = "/x"`) navigates
  // rather than replacing the object.
  Object.defineProperty(W, "__NOloc", { get: function () { return loc; }, set: function (v) { go(v); } });

  // --- history -------------------------------------------------------------------------
  var HP = W.History.prototype, realReplace = HP.replaceState;
  function hist(mode) {
    return function (state, title, url) {
      if (url !== undefined && url !== null) {
        var u = abs(url);
        if (u.origin !== cur.origin) throw new W.DOMException("Failed to execute '" + mode + "State' on 'History': cross-origin URL", "SecurityError");
        cur = u;
        if (live()) NO.frameHistory(u.href, mode);
      }
      // Never pass the URL on: the real document is about:srcdoc and would throw.
      return realReplace.call(this, state, title === undefined ? "" : title);
    };
  }
  HP.pushState = hist("push");
  HP.replaceState = hist("replace");

  // --- URL mapping ---------------------------------------------------------------------
  function remap(v) {
    if (v == null || v === "") return v;
    var s = String(v);
    if (/^(?:blob:|data:|javascript:|about:|#)/i.test(s)) return v;
    var u;
    try { u = new URL(s, D.baseURI); } catch (e) { return v; }
    return NO.assetURLFor(u.href) || v;
  }
  function remapSrcset(v) {
    if (v == null) return v;
    var out = [];
    String(v).split(/\s*,\s+/).forEach(function (part) {
      var bits = part.trim().split(/\s+/);
      if (!bits[0]) return;
      var r = remap(bits[0]);
      if (r !== bits[0] || /^(?:blob:|data:)/.test(bits[0])) { bits[0] = r; out.push(bits.join(" ")); }
    });
    return out.join(", ");
  }
  function unmap(v) {
    if (typeof v === "string" && v.lastIndexOf("blob:", 0) === 0) {
      var k = NO.unmap(v);
      if (k != null) return k;
    }
    return v;
  }
  function unmapAbs(v) {
    var k = unmap(v);
    return k === v ? v : k.charAt(0) === "/" ? cur.origin + k : k;
  }
  function patch(Ctor, prop, fn, list) {
    if (!Ctor) return;
    var proto = Ctor.prototype, d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set || !d.get) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: function () { var val = d.get.call(this); return list ? val : unmapAbs(val); },
      set: function (v) { d.set.call(this, fn(v)); },
    });
  }
  patch(W.HTMLScriptElement, "src", remap);
  patch(W.HTMLLinkElement, "href", remap);
  patch(W.HTMLLinkElement, "imageSrcset", remapSrcset, true);
  patch(W.HTMLImageElement, "src", remap);
  patch(W.HTMLImageElement, "srcset", remapSrcset, true);
  patch(W.HTMLSourceElement, "src", remap);
  patch(W.HTMLSourceElement, "srcset", remapSrcset, true);
  patch(W.HTMLMediaElement, "src", remap);
  patch(W.HTMLVideoElement, "poster", remap);
  patch(W.HTMLInputElement, "src", remap);
  patch(W.HTMLEmbedElement, "src", remap);
  patch(W.HTMLTrackElement, "src", remap);

  var URL_ATTRS = { src: remap, href: remap, poster: remap, "xlink:href": remap, srcset: remapSrcset, imagesrcset: remapSrcset };
  var NOT_ASSETS = { a: 1, area: 1, form: 1, base: 1, iframe: 1 };
  EP.setAttribute = function (name, value) {
    var f = URL_ATTRS[String(name).toLowerCase()];
    if (f && !NOT_ASSETS[this.localName]) value = f(value);
    return sa.call(this, name, value);
  };
  EP.setAttributeNS = function (ns, name, value) {
    var n = String(name).toLowerCase(), f = URL_ATTRS[n] || (n === "href" ? remap : null);
    if (f && !NOT_ASSETS[this.localName]) value = f(value);
    return san.call(this, ns, name, value);
  };
  EP.getAttribute = function (name) {
    var v = ga.call(this, name);
    return v && v.charCodeAt(0) === 98 ? unmap(v) : v;
  };

  // `script[src="/_next/…/x.js"]` must still find a script whose attribute is
  // now a blob: URL — chunk loaders dedupe this way.
  function fixSel(sel) {
    if (typeof sel !== "string" || sel.indexOf("[") < 0) return sel;
    return sel.replace(/\[\s*(src|href)\s*(\^?=)\s*(["'])((?:\\.|(?!\3)[^\\])*)\3\s*\]/g, function (m, at, op, q, val) {
      var raw = val.replace(/\\(.)/g, "$1"), clean = op === "^=" ? raw.replace(/[?#]$/, "") : raw, b = null;
      try { b = NO.assetURLFor(new URL(clean, D.baseURI).href); } catch (e) {}
      return b ? ":is(" + m + ",[" + at + op + '"' + b + '"])' : m;
    });
  }
  [W.Document, W.Element, W.DocumentFragment].forEach(function (C) {
    if (!C) return;
    ["querySelector", "querySelectorAll"].forEach(function (fn) {
      var orig = C.prototype[fn];
      if (!orig) return;
      C.prototype[fn] = function (sel) { return orig.call(this, fixSel(sel)); };
    });
  });
  ["matches", "closest"].forEach(function (fn) {
    var orig = EP[fn];
    if (orig) EP[fn] = function (sel) { return orig.call(this, fixSel(sel)); };
  });

  // --- fetch & XHR -----------------------------------------------------------------------
  var realFetch = W.fetch, R = W.Response, WP = W.Promise;
  function mk(body, status, type, url) {
    var nullBody = status === 101 || status === 204 || status === 205 || status === 304;
    var r = new R(nullBody ? null : body, { status: status || 200, headers: { "content-type": type } });
    try { Object.defineProperty(r, "url", { value: url }); } catch (e) {}
    return r;
  }
  function isRSC(req, u) {
    var h = req.headers;
    return h.get("rsc") === "1" || h.has("next-router-state-tree") || h.has("next-router-prefetch") ||
      h.has("next-router-segment-prefetch") || u.searchParams.has("_rsc");
  }
  function fdToObj(fd) {
    var o = {};
    fd.forEach(function (v, k) { o[k] = typeof v === "string" ? v : (v && v.name) || ""; });
    return o;
  }
  function readFields(req) {
    var ct = req.headers.get("content-type") || "";
    var p = /form/.test(ct) ? req.formData().then(fdToObj)
      : /json/.test(ct) ? req.json()
      : req.text().then(function (t) { return t ? { body: t } : {}; });
    return WP.resolve(p).catch(function () { return {}; });
  }
  W.fetch = function (input, init) {
    var req;
    try { req = new W.Request(input, init); } catch (e) { return WP.reject(e); }
    var u = new URL(req.url);
    if (u.protocol === "blob:" || u.protocol === "data:") return realFetch.apply(W, arguments);
    var m = req.method.toUpperCase();
    if (m === "GET" || m === "HEAD") {
      if (u.origin === cur.origin && isRSC(req, u)) return WP.resolve(mk("", 200, "text/html; charset=utf-8", u.href));
      return WP.resolve(NO.fetch(u.href)).then(function (hit) {
        if (!hit) {
          report("miss", m + " " + u.href);
          return mk(JSON.stringify({ error: "Not included in this offline snapshot." }), 404, "application/json", u.href);
        }
        return mk(m === "HEAD" ? null : hit.bytes, hit.status, hit.type, u.href);
      });
    }
    return readFields(req).then(function (fields) {
      if (NO.write(u.href, m, fields)) return mk(JSON.stringify({ ok: true, offline: true }), 200, "application/json", u.href);
      return mk(JSON.stringify({ error: "This is a read-only offline snapshot; changes cannot be saved." }), 503, "application/json", u.href);
    });
  };

  // Enough of XMLHttpRequest for axios and friends, routed through fetch above.
  class OfflineXHR extends W.EventTarget {
    constructor() {
      super();
      this.readyState = 0; this.status = 0; this.statusText = ""; this.response = null; this.responseText = "";
      this.responseType = ""; this.responseURL = ""; this.timeout = 0; this.withCredentials = false;
      this.upload = new W.EventTarget(); this._h = {}; this._rh = {};
    }
    open(method, url) { this._m = String(method).toUpperCase(); this._u = abs(url).href; this._aborted = false; this._set(1); }
    setRequestHeader(k, v) { this._h[k] = v; }
    getResponseHeader(k) { var v = this._rh[String(k).toLowerCase()]; return v == null ? null : v; }
    getAllResponseHeaders() { var s = ""; for (var k in this._rh) s += k + ": " + this._rh[k] + "\r\n"; return s; }
    overrideMimeType() {}
    abort() { this._aborted = true; this._set(4); this._fire("abort"); this._fire("loadend"); }
    send(body) {
      var self = this, noBody = this._m === "GET" || this._m === "HEAD";
      W.fetch(this._u, { method: this._m, headers: this._h, body: noBody ? undefined : body }).then(function (r) {
        if (self._aborted) return;
        self.status = r.status; self.statusText = r.statusText; self.responseURL = self._u;
        r.headers.forEach(function (v, k) { self._rh[k] = v; });
        self._set(2);
        var rt = self.responseType;
        return (rt === "arraybuffer" ? r.arrayBuffer() : rt === "blob" ? r.blob() : r.text()).then(function (data) {
          if (self._aborted) return;
          if (rt === "" || rt === "text") { self.responseText = data; self.response = data; }
          else if (rt === "json") { try { self.response = JSON.parse(data); } catch (e) { self.response = null; } }
          else self.response = data;
          self._set(3); self._set(4); self._fire("load"); self._fire("loadend");
        });
      }, function () {
        if (self._aborted) return;
        self._set(4); self._fire("error"); self._fire("loadend");
      });
    }
    _set(s) { this.readyState = s; this._fire("readystatechange"); }
    _fire(type) {
      var e = new W.Event(type);
      this.dispatchEvent(e);
      var h = this["on" + type];
      if (typeof h === "function") h.call(this, e);
    }
  }
  ["UNSENT", "OPENED", "HEADERS_RECEIVED", "LOADING", "DONE"].forEach(function (n, i) { OfflineXHR[n] = i; OfflineXHR.prototype[n] = i; });
  W.XMLHttpRequest = OfflineXHR;
  if (W.navigator.sendBeacon) W.navigator.sendBeacon = function () { return true; };

  // --- windows, cookies ---------------------------------------------------------------------
  var realOpen = W.open;
  W.open = function (url, target, features) {
    if (url == null || url === "") return realOpen.apply(W, arguments);
    var u;
    try { u = abs(url); } catch (e) { return null; }
    if (u.origin === cur.origin) {
      if (target === "_self" || target === "_top" || target === "_parent") { go(u.href); return W; }
      NO.openInNewTab(u.href);
      return null;
    }
    NO.external(u.href);
    return null;
  };
  var jar = NO.cookies;
  try {
    Object.defineProperty(D, "cookie", {
      configurable: true,
      get: function () { return Object.keys(jar).map(function (k) { return k + "=" + jar[k]; }).join("; "); },
      set: function (v) {
        var s = String(v), kv = s.split(";")[0], i = kv.indexOf("=");
        if (i < 0) return;
        var k = kv.slice(0, i).trim(), exp = /;\s*expires\s*=\s*([^;]+)/i.exec(s);
        if (/;\s*max-age\s*=\s*(-\d+|0)\s*(;|$)/i.test(s) || (exp && Date.parse(exp[1]) < Date.now())) delete jar[k];
        else jar[k] = kv.slice(i + 1).trim();
      },
    });
  } catch (e) {}

  // --- links and forms ------------------------------------------------------------------------
  // Bubble phase on window: runs after the app's own handlers, so a link the app
  // already handled (Next's <Link> calls preventDefault) is left alone.
  function onLink(e, newTab) {
    if (e.defaultPrevented) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href], area[href]") : null;
    if (!a) return;
    var href = ga.call(a, "href");
    if (href == null || /^javascript:/i.test(href)) return;
    var u;
    try { u = new URL(href, D.baseURI); } catch (x) { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    e.preventDefault();
    if (a.hasAttribute("download") || NO.isAsset(u.href)) { NO.openAsset(u.href, a.getAttribute("download")); return; }
    if (u.origin !== cur.origin) { NO.external(u.href); return; }
    var t = a.getAttribute("target");
    if (newTab || e.metaKey || e.ctrlKey || e.shiftKey || (t && !/^_(self|top|parent)$/i.test(t))) { NO.openInNewTab(u.href); return; }
    go(u.href);
  }
  W.addEventListener("click", function (e) { if (e.button === 0) onLink(e, false); });
  W.addEventListener("auxclick", function (e) { if (e.button === 1) onLink(e, true); });
  W.addEventListener("submit", function (e) {
    if (e.defaultPrevented) return;
    var f = e.target, s = e.submitter;
    var method = ((s && s.getAttribute("formmethod")) || f.getAttribute("method") || "get").toLowerCase();
    var action = (s && s.getAttribute("formaction")) || f.getAttribute("action") || cur.href;
    var u, fd;
    try { u = new URL(action, D.baseURI); } catch (x) { return; }
    try { fd = new W.FormData(f, s); } catch (x) { fd = new W.FormData(f); }
    e.preventDefault();
    if (method === "get") { u.search = new W.URLSearchParams(fd).toString(); go(u.href); return; }
    NO.submit(u.href, method, fdToObj(fd));
  });

  // --- links to pages the snapshot does not hold -----------------------------------------------
  // Marked with data-no-missing; the bundle's per-page CSS hides or dims them.
  // Observed from the first parsed node, so a hidden link never flashes.
  if (NO.manifest.missingLinks && NO.manifest.missingLinks !== "show") {
    var checkLink = function (a) {
      var href = ga.call(a, "href");
      if (!href || href.charAt(0) === "#" || /^(javascript|mailto|tel):/i.test(href)) return;
      var u;
      try { u = abs(href); } catch (e) { return; }
      if (u.origin !== cur.origin) return;
      if (NO.hasPage(u.href) || NO.isAsset(u.href)) { if (a.hasAttribute("data-no-missing")) a.removeAttribute("data-no-missing"); }
      else if (!a.hasAttribute("data-no-missing")) sa.call(a, "data-no-missing", "");
    };
    var scan = function (node) {
      if (node.nodeType !== 1) return;
      if (node.localName === "a" || node.localName === "area") checkLink(node);
      var list = node.getElementsByTagName("a");
      for (var i = 0; i < list.length; i++) checkLink(list[i]);
    };
    new W.MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === "attributes") { if (m.target.localName === "a" || m.target.localName === "area") checkLink(m.target); continue; }
        for (var j = 0; j < m.addedNodes.length; j++) scan(m.addedNodes[j]);
      }
    }).observe(D, { subtree: true, childList: true, attributes: true, attributeFilter: ["href"] });
  }

  // --- diagnostics ----------------------------------------------------------------------------
  W.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t !== W && t.nodeType === 1) {
      report("resource", (t.localName || "") + " " + unmap(ga.call(t, "src") || ga.call(t, "href") || ""));
      return;
    }
    report("error", (e.message || "error") + (e.filename ? " @ " + unmap(e.filename) + ":" + e.lineno : ""));
  }, true);
  W.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    report("rejection", (r && (r.stack || r.message)) || String(r));
  });
  D.addEventListener("securitypolicyviolation", function (e) {
    report("blocked", e.violatedDirective + " " + e.blockedURI);
  });

  // --- lifecycle --------------------------------------------------------------------------------
  D.addEventListener("DOMContentLoaded", function () {
    NO.frameReady(W, SEQ);
    var meta = D.querySelector("meta[data-no-refresh]");
    if (meta) {
      var m = /^\s*(\d+)?\s*[;,]?\s*(?:url\s*=\s*)?(.*)$/i.exec(meta.getAttribute("content") || "");
      if (m && m[2]) setTimeout(function () { go(m[2].replace(/^['"]|['"]$/g, ""), true); }, (+m[1] || 0) * 1000);
    }
    if (D.head && W.MutationObserver) {
      new W.MutationObserver(function () { NO.title(W, D.title); })
        .observe(D.head, { subtree: true, childList: true, characterData: true });
    }
  });
  W.addEventListener("load", scrollToHash);
})();
