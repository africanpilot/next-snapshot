// URL -> lookup key, the one normalisation every part of the tool agrees on.
//
// Used by the Node side (capture, bundle) and by the browser runtime, which is
// handed this function's *source text*. Keep it a self-contained plain function:
// no imports, no closures over module scope, nothing Node-only.
//
// A same-origin URL keys as "/path?sorted=query"; anything else keys as its
// absolute URL. The fragment never matters, `_rsc` (Next's cache-buster) is
// dropped, parameters are sorted by name so `?b=2&a=1` and `?a=1&b=2` are one
// page, and a trailing slash is dropped from every path but "/".
export function urlKey(input, base, origin) {
  let u;
  try {
    u = new URL(input, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const own = origin || new URL(base).origin;
  const params = [];
  u.searchParams.forEach((v, k) => {
    if (k !== "_rsc") params.push([k, v]);
  });
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const search = params.length ? "?" + new URLSearchParams(params).toString() : "";
  let path = u.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return (u.origin === own ? "" : u.origin) + path + search;
}
