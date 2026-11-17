// Provider dashboard (#/provider). Guard: prov.
import { get } from '../api.js';
import { esc, pageHeader, emptyState, statusBadge, errorHtml } from '../ui.js';
import { formatDubai, aed, kindLabel } from '../format.js';

function meetLink(url) {
  if (typeof url === 'string' && url.startsWith('https://')) {
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Join</a>`;
  }
  return '';
}

export async function render(root, ctx) {
  let me;
  try {
    me = await get('/providers/me');
  } catch (err) {
    root.innerHTML = errorHtml(err);
    return;
  }

  const provider = me.provider;
  if (!provider) {
    root.innerHTML =
      pageHeader('Provider area') +
      emptyState('You do not have a provider profile yet.') +
      `<p><a class="btn btn-primary" href="#/apply">Apply to become a provider</a></p>`;
    return;
  }

  const nav = `<nav class="row" aria-label="Provider sections">
    <a class="btn btn-ghost" href="#/provider/profile">Profile and availability</a>
    <a class="btn btn-ghost" href="#/provider/bookings">Bookings</a>
    <a class="btn btn-ghost" href="#/provider/earnings">Earnings</a>
  </nav>`;

  const overview = `<div class="card stack">
    <div class="row row-between"><span>Status</span>${statusBadge(provider.status)}</div>
    <div class="row row-between"><span>Kind</span><span>${esc(kindLabel(provider.kind))}</span></div>
    <div class="row row-between"><span>Specialty</span><span>${esc(provider.specialty)}</span></div>
    <div class="row row-between"><span>Session price</span><span class="price">${esc(aed(provider.priceCredits))}</span></div>
  </div>`;

  if (provider.status !== 'approved') {
    root.innerHTML =
      pageHeader('Provider area', `${kindLabel(provider.kind)} · ${provider.specialty}`) +
      overview +
      `<p class="alert alert-info">Your application is not approved yet. You can keep your profile and availability up to date.</p>` +
      nav +
      `<p><a class="btn btn-primary" href="#/apply">View your application</a></p>`;
    return;
  }

  let list;
  try {
    list = await get('/bookings?as=provider&scope=upcoming&limit=10');
  } catch (err) {
    root.innerHTML =
      pageHeader('Provider area', `${kindLabel(provider.kind)} · ${provider.specialty}`) +
      overview +
      errorHtml(err) +
      nav;
    return;
  }

  const items = list.items || [];
  const sessions = items.length
    ? `<div class="grid">${items.map((b) => `<article class="card stack">
        <div class="row row-between"><strong>${esc(b.consumerName || 'Client')}</strong>${statusBadge(b.status)}</div>
        <p class="muted">${esc(formatDubai(b.startsAt))}</p>
        <p><span class="price">${esc(aed(b.priceCredits))}</span></p>
        ${b.status === 'confirmed'
          ? `<p>${meetLink(b.meetingUrl) || '<span class="muted">Join link available soon</span>'}</p>`
          : ''}
      </article>`).join('')}</div>`
    : emptyState('No upcoming sessions.');

  root.innerHTML =
    pageHeader('Provider area', `${kindLabel(provider.kind)} · ${provider.specialty}`) +
    overview +
    nav +
    `<h2>Upcoming sessions</h2>` +
    sessions;
}
