import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHash, matchRoute, buildQuery } from '../public/js/router.js';
import { escapeHtml, formatDubai, formatDubaiTime, aed, kindLabel, utcTimeToDubai, todayUtc } from '../public/js/format.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

test('parseHash splits path and decoded query', () => {
  assert.deepEqual(parseHash('#/providers?kind=yoga&q=a%20b'), { path: '/providers', query: { kind: 'yoga', q: 'a b' } });
  assert.deepEqual(parseHash(''), { path: '/', query: {} });
  assert.deepEqual(parseHash('#/login?next=%23%2Fcredits'), { path: '/login', query: { next: '#/credits' } });
  assert.equal(parseHash('#/bookings/').path, '/bookings');
  assert.equal(parseHash('#/x?q=%E0%A4%A').query.q, '%E0%A4%A');
});

test('matchRoute extracts params and rejects mismatches', () => {
  const routes = [{ path: '/' }, { path: '/providers' }, { path: '/providers/:id' }];
  assert.equal(matchRoute(routes, '/').route, routes[0]);
  assert.deepEqual(matchRoute(routes, '/providers/42').params, { id: '42' });
  assert.equal(matchRoute(routes, '/providers/1/x'), null);
  assert.equal(matchRoute(routes, '/nope'), null);
});

test('buildQuery skips empty values and encodes', () => {
  assert.equal(buildQuery({ a: 'x y', b: '', c: undefined, d: 0 }), '?a=x%20y&d=0');
  assert.equal(buildQuery({}), '');
});

test('escapeHtml escapes dangerous characters', () => {
  assert.equal(escapeHtml('<img src=x onerror="a()">&\'`'), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;&#96;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(5), '5');
});

test('time and money formatting', () => {
  assert.match(formatDubai('2026-01-01T06:00:00Z'), /10:00/);
  assert.equal(formatDubai('garbage'), '');
  assert.equal(formatDubaiTime('2026-01-01T20:00:00Z'), '00:00');
  assert.equal(aed(25), '125 AED');
  assert.equal(aed(10, 5), '50 AED');
  assert.equal(kindLabel('doctor'), 'Doctor');
  assert.equal(utcTimeToDubai('09:00'), '13:00');
  assert.equal(utcTimeToDubai('24:00'), '04:00 (+1)');
  assert.equal(todayUtc(new Date('2026-03-04T23:59:00Z')), '2026-03-04');
});

function listJs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listJs(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [],
  );
}

test('index.html shell references existing files', () => {
  const html = readFileSync(join(pub, 'index.html'), 'utf8');
  assert.match(html, /<html/);
  assert.match(html, /<div id="app"/);
  assert.match(html, /<script type="module" src="\/js\/app\.js">/);
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"#]*)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2);
  for (const ref of refs) assert.ok(existsSync(join(pub, ref)), `missing ${ref}`);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('every route view exists and exports render', async () => {
  const app = readFileSync(join(pub, 'js/app.js'), 'utf8');
  const views = [...app.matchAll(/view: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(views.length >= 15);
  for (const v of new Set(views)) {
    const mod = await import(`../public/js/views/${v}.js`);
    assert.equal(typeof mod.render, 'function', v);
  }
});

function normalise(p) {
  // a path literal ending in "/" is followed by a concatenated id
  if (p.length > 1 && p.endsWith('/')) p += ':id';
  return p.replace(/\/\$\{[^}]*\}/g, '/:id').replace(/\$\{[^}]*\}/g, '').split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id');
}

test('every API path the frontend calls is in the architecture API table', () => {
  const doc = readFileSync(join(root, 'docs/ARCHITECTURE.md'), 'utf8');
  const table = new Set();
  for (const m of doc.matchAll(/^\| `(GET|POST|PUT|DELETE) (\/[^`]*)` \|/gm)) {
    if (m[2] === '/health') continue;
    table.add(`${m[1]} ${m[2].replace(/:[a-zA-Z]+/g, ':id').split('?')[0]}`);
  }
  assert.ok(table.size > 20);
  const used = new Set();
  for (const file of listJs(join(pub, 'js'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\b(get|post|put|api)\(\s*(?:'(GET|POST|PUT|DELETE)'\s*,\s*)?([`'])(\/[^`']*)\3/g)) {
      const method = m[2] || { get: 'GET', post: 'POST', put: 'PUT' }[m[1]];
      assert.ok(method, `${file}: cannot determine method`);
      if (m[4].endsWith('/${action}')) {
        for (const a of ['approve', 'reject']) used.add(`${method} ${normalise(m[4].replace('${action}', a))}`);
      } else used.add(`${method} ${normalise(m[4])}`);
    }
  }
  assert.ok(used.size > 20, `only ${used.size} API calls detected`);
  for (const u of used) assert.ok(table.has(u), `frontend calls undocumented API: ${u}`);
});

test('frontend avoids inline handlers, eval and console output', () => {
  for (const file of listJs(join(pub, 'js'))) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /\bonclick=|\beval\(|document\.write|console\./, file);
  }
});
