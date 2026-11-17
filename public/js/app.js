// Bootstrap: auth state, nav, hash routing and guards.
import { parseHash, matchRoute, buildQuery } from './router.js';
import { api } from './api.js';
import { esc, loading, showError } from './ui.js';

// guard: undefined = public, 'auth' | 'prov' | 'admin'
export const ROUTES = [
  { path: '/', view: 'home' },
  { path: '/providers', view: 'providers' },
  { path: '/providers/:id', view: 'provider' },
  { path: '/login', view: 'auth' },
  { path: '/register', view: 'auth' },
  { path: '/apply', view: 'apply', guard: 'auth' },
  { path: '/dashboard', view: 'dashboard', guard: 'auth' },
  { path: '/credits', view: 'credits', guard: 'auth' },
  { path: '/bookings', view: 'bookings', guard: 'auth' },
  { path: '/transactions', view: 'transactions', guard: 'auth' },
  { path: '/provider', view: 'provider-dashboard', guard: 'prov' },
  { path: '/provider/profile', view: 'provider-profile', guard: 'prov' },
  { path: '/provider/bookings', view: 'provider-bookings', guard: 'prov' },
  { path: '/provider/earnings', view: 'provider-earnings', guard: 'prov' },
  { path: '/admin/applications', view: 'admin-applications', guard: 'admin' },
  { path: '/admin/users', view: 'admin-users', guard: 'admin' },
  { path: '/admin/bookings', view: 'admin-bookings', guard: 'admin' },
  { path: '/admin/ledger', view: 'admin-ledger', guard: 'admin' },
];

const state = { me: { user: null, provider: null } };
const root = document.getElementById('app');
const navEl = document.getElementById('nav');
let renderToken = 0;

export function navigate(hash) {
  if (location.hash === hash) renderRoute();
  else location.hash = hash;
}

async function refreshMe() {
  try {
    const data = await api('GET', '/auth/me');
    state.me = { user: data.user || null, provider: data.provider || null };
  } catch {
    state.me = { user: null, provider: null };
  }
  renderNav();
  return state.me;
}

async function logout() {
  try {
    await api('POST', '/auth/logout');
  } catch {
    // cookie is cleared server-side on success; ignore network failures here
  }
  await refreshMe();
  navigate('#/');
}

function link(href, label, current) {
  const active = current === href ? ' aria-current="page"' : '';
  return `<a href="${esc(href)}"${active}>${esc(label)}</a>`;
}

function renderNav() {
  const { user, provider } = state.me;
  const cur = location.hash || '#/';
  const items = [link('#/providers', 'Find a provider', cur)];
  if (!user) {
    items.push(link('#/apply', 'Become a provider', cur), link('#/login', 'Log in', cur), '<a class="btn btn-primary" href="#/register">Sign up</a>');
  } else {
    if (user.role === 'admin') {
      items.push(link('#/admin/applications', 'Applications', cur), link('#/admin/users', 'Users', cur), link('#/admin/bookings', 'Bookings', cur), link('#/admin/ledger', 'Ledger', cur));
    } else {
      items.push(link('#/dashboard', 'Dashboard', cur), link('#/bookings', 'My bookings', cur), link('#/credits', 'Buy credits', cur), link('#/transactions', 'Transactions', cur));
      if (provider && provider.status === 'approved') items.push(link('#/provider', 'Provider area', cur));
      else if (!provider) items.push(link('#/apply', 'Become a provider', cur));
      else items.push(link('#/apply', 'Application', cur));
    }
    items.push(`<span class="nav-user">${esc(user.name)}</span>`, '<button type="button" class="btn btn-ghost" id="logout-btn">Log out</button>');
  }
  navEl.innerHTML = items.join('');
  const btn = document.getElementById('logout-btn');
  if (btn) btn.addEventListener('click', logout);
}

function roleAllows(guard, me) {
  if (!guard) return true;
  if (guard === 'auth') return !!me.user;
  if (guard === 'admin') return me.user && me.user.role === 'admin';
  if (guard === 'prov') return !!(me.user && me.provider && me.provider.status === 'approved') || (me.user && me.user.role === 'provider');
  return false;
}

async function renderRoute() {
  const token = ++renderToken;
  const { path, query } = parseHash(location.hash);
  renderNav();
  const found = matchRoute(ROUTES, path);
  document.title = 'Vitalis';
  if (!found) {
    root.innerHTML = '<h1>Not found</h1><p>That page does not exist. <a href="#/">Go home</a>.</p>';
    return;
  }
  const { route, params } = found;
  if (route.guard && !state.me.user) {
    navigate(`#/login${buildQuery({ next: location.hash })}`);
    return;
  }
  if (!roleAllows(route.guard, state.me)) {
    root.innerHTML = '<h1>Access denied</h1><p>You do not have permission to view this page.</p>';
    return;
  }
  loading(root);
  try {
    const mod = await import(`./views/${route.view}.js`);
    if (token !== renderToken) return;
    root.innerHTML = '';
    await mod.render(root, { params, query, me: state.me, navigate, refreshMe, path });
  } catch (err) {
    if (token !== renderToken) return;
    showError(root, err);
  }
  if (token === renderToken) document.getElementById('main').focus({ preventScroll: true });
}

document.getElementById('nav-toggle').addEventListener('click', (e) => {
  const open = navEl.classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', String(open));
});
navEl.addEventListener('click', (e) => {
  if (e.target.closest('a')) {
    navEl.classList.remove('open');
    document.getElementById('nav-toggle').setAttribute('aria-expanded', 'false');
  }
});

window.addEventListener('hashchange', renderRoute);
await refreshMe();
await renderRoute();
