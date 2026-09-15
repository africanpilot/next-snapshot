// Loaded at runtime by app.js. Reads its own src back, as webpack and
// Turbopack chunk loaders do to register themselves: it must see the original
// URL, not the blob: URL the snapshot actually loaded it from.
window.__lazyLoaded = true;
document.getElementById("lazy").textContent = "loaded from " + document.currentScript.getAttribute("src");
