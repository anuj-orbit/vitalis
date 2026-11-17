// Consumer dashboard: greeting, credit balance, upcoming sessions and quick links.
import { get } from '../api.js';
import { esc, errorHtml, pageHeader, emptyState } from '../ui.js';
import { formatDubai, kindLabel, aed } from '../format.js';

// A meeting URL is only linkified when it is a plain https:// URL.
function meetingLink(url, label) {
  if (typeof url === 'string' && url.startsWith('https://')) {
    return `<a class="btn btn-ghost" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  }
  return url ? `<span class="muted">${esc(url)}</span>` : '';
}

export async function render(root, ctx) {
  const { me } = ctx;
  const user = me.user;
  const header = pageHeader(`Hello, ${user.name}`, 'Your Vitalis dashboard');

  if (user.role === 'admin') {
    root.innerHTML = `${header}
      <div class="grid">
        <a class="card" href="#/admin/applications"><h3>Applications</h3><p class="muted">Review provider applications.</p></a>
        <a class="card" href="#/admin/users"><h3>Users</h3><p class="muted">Manage users and adjust balances.</p></a>
        <a class="card" href="#/admin/bookings"><h3>Bookings</h3><p class="muted">View and manage bookings.</p></a>
        <a class="card" href="#/admin/ledger"><h3>Ledger</h3><p class="muted">Browse the credit ledger.</p></a>
      </div>`;
    return;
  }

  let balance;
  let bookings;
  try {
    [balance, bookings] = await Promise.all([
      get('/credits/balance'),
      get('/bookings?scope=upcoming&limit=5'),
    ]);
  } catch (err) {
    root.innerHTML = header + errorHtml(err);
    return;
  }

  const sessions = (bookings.items || []).map((b) => `
    <div class="card">
      <div class="row row-between">
        <h3>${esc(b.providerName)}</h3>
        <span class="muted">${esc(kindLabel(b.providerKind))}</span>
      </div>
      <p>${esc(formatDubai(b.startsAt))}</p>
      <div class="row">${meetingLink(b.meetingUrl, 'Join session')}</div>
    </div>`).join('');

  let providerArea = '';
  if (me.provider && me.provider.status === 'approved') {
    providerArea = '<p><a class="btn btn-ghost" href="#/provider">Go to provider area</a></p>';
  } else if (!me.provider) {
    providerArea = '<p><a class="btn btn-ghost" href="#/apply">Become a provider</a></p>';
  } else {
    providerArea = '<p><a class="btn btn-ghost" href="#/apply">View your provider application</a></p>';
  }

  root.innerHTML = `${header}
    <section class="card">
      <p class="muted">Credit balance</p>
      <p class="stat">${esc(String(balance.balance))}</p>
      <p>${esc(aed(balance.balance))}</p>
      <div class="row">
        <a class="btn btn-primary" href="#/credits">Buy credits</a>
        <a class="btn btn-ghost" href="#/bookings">My bookings</a>
        <a class="btn btn-ghost" href="#/providers">Find a provider</a>
      </div>
    </section>
    <h2>Next sessions</h2>
    <div class="stack">${sessions || emptyState('You have no upcoming sessions.')}</div>
    ${providerArea}`;
}
