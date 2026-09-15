// The fixture app. Written against the real browser APIs a framework uses —
// location, history, fetch, dynamic <script> — so the offline file has to
// supply every one of them.
(function () {
  var where = document.getElementById("where");
  function showWhere() {
    where.textContent = location.pathname + location.search;
  }
  showWhere();

  var data = document.getElementById("data");
  if (data) {
    fetch("/api/data")
      .then(function (r) { return r.json(); })
      .then(function (j) { data.textContent = j.message; })
      .catch(function (e) { data.textContent = "fetch failed: " + e.message; });
  }

  // Loaded at runtime, as a chunk loader would.
  if (document.getElementById("lazy")) {
    var s = document.createElement("script");
    s.src = "/static/lazy.js";
    document.head.appendChild(s);
  }

  // Next prefetches the links it can see: an RSC request per link, ahead of
  // any click. The capture must see these and skip them.
  document.querySelectorAll("a[data-router]").forEach(function (a) {
    fetch(a.getAttribute("href"), { headers: { RSC: "1", "Next-Router-Prefetch": "1" } }).catch(function () {});
  });

  var tab = new URLSearchParams(location.search).get("tab");
  if (tab && document.getElementById("tab")) document.getElementById("tab").textContent = tab;

  document.addEventListener("click", function (e) {
    // A router link: ask the server for an RSC payload first, then navigate —
    // Next falls back to a full navigation when the answer is not RSC.
    var a = e.target.closest("a[data-router]");
    if (a) {
      e.preventDefault();
      var href = a.getAttribute("href");
      fetch(href, { headers: { RSC: "1" } }).then(function () {
        location.assign(href);
      });
      return;
    }
    // A tab that never asks the server: it only rewrites the URL.
    var b = e.target.closest("button[data-tab]");
    if (b) {
      // Keep the rest of the query, the way a real app rebuilds it: the tab is
      // one parameter among several, not the whole address.
      var params = new URLSearchParams(location.search);
      params.set("tab", b.getAttribute("data-tab"));
      history.replaceState(null, "", "?" + params.toString());
      document.getElementById("tab").textContent = b.getAttribute("data-tab");
      showWhere();
    }
    // A lone button, not a tab strip, so the crawl never clicks it: the URL it
    // writes is one the snapshot has never seen.
    if (e.target.closest("#note")) {
      history.replaceState(null, "", "?note=1");
      showWhere();
    }
  });

  var sel = document.getElementById("period");
  if (sel) {
    sel.addEventListener("change", function () {
      location.assign("/report?period=" + sel.value);
    });
  }
})();
