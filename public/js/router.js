// Pure hash router helpers. No imports, no DOM access.

export function parseHash(hash) {
  let h = String(hash || '');
  if (h.startsWith('#')) h = h.slice(1);
  const qi = h.indexOf('?');
  const rawPath = qi === -1 ? h : h.slice(0, qi);
  const rawQuery = qi === -1 ? '' : h.slice(qi + 1);
  let path = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const query = {};
  for (const part of rawQuery.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = safeDecode(eq === -1 ? part : part.slice(0, eq));
    const v = eq === -1 ? '' : safeDecode(part.slice(eq + 1));
    query[k] = v;
  }
  return { path, query };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

// routes: [{ path: '/providers/:id', ... }]. Returns { route, params } or null.
export function matchRoute(routes, path) {
  const segs = path.split('/').filter(Boolean);
  for (const route of routes) {
    const rsegs = route.path.split('/').filter(Boolean);
    if (rsegs.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < rsegs.length; i++) {
      if (rsegs[i].startsWith(':')) params[rsegs[i].slice(1)] = safeDecode(segs[i]);
      else if (rsegs[i] !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

export function buildQuery(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? '?' + parts.join('&') : '';
}
