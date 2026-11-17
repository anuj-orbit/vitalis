// Consumer bookings: upcoming/past tabs, pagination, join links and cancel.
import { get, post } from '../api.js';
import { esc, errorHtml, pageHeader, emptyState, statusBadge, pagerHtml, setMsg } from '../ui.js';
import { formatDubai, kindLabel, aed, DISCLAIMER } from '../format.js';

const LIMIT = 20;

export async function render(root, ctx) {
  const state = { scope: 'upcoming', offset: 0 };

  root.innerHTML = `${pageHeader('My bookings', 'Manage your sessions')}
    <div class="row" role="group" aria-label="Filter bookings">
      <button type="button" class="btn btn-primary" data-scope="upcoming" aria-pressed="true">Upcoming</button>
      <button type="button" class="btn btn-ghost" data-scope="past" aria-pressed="false">Past</button>
    </div>
    <div id="msg" class="alert" role="status" hidden></div>
    <div id="list"></div>`;

  const listEl = document.getElementById('list');
  const msgEl = document.getElementById('msg');
  const scopeBtns = Array.from(root.querySelectorAll('button[data-scope]'));

  const bookingCard = (b) => {
    const confirmed = b.status === 'confirmed';
    const upcoming = new Date(b.startsAt).getTime() >= Date.now();
    const join = confirmed && typeof b.meetingUrl === 'string' && b.meetingUrl.startsWith('https://')
      ? `<a class="btn btn-ghost" href="${esc(b.meetingUrl)}" target="_blank" rel="noopener noreferrer">Join session</a>`
      : '';
    const cancel = confirmed && upcoming
      ? `<button type="button" class="btn btn-danger" data-cancel="${esc(String(b.id))}" data-price="${esc(String(b.priceCredits))}" data-start="${esc(b.startsAt)}">Cancel</button>`
      : '';
    const disclaimer = b.providerKind === 'doctor' ? `<p class="disclaimer">${esc(DISCLAIMER)}</p>` : '';
    return `<div class="card">
      <div class="row row-between">
        <h3>${esc(b.providerName)}</h3>
        ${statusBadge(b.status)}
      </div>
      <p class="muted">${esc(kindLabel(b.providerKind))}</p>
      <p>${esc(formatDubai(b.startsAt))} · ${esc(String(b.durationMin))} min</p>
      <p class="price">${esc(String(b.priceCredits))} credits (${esc(aed(b.priceCredits))})</p>
      ${disclaimer}
      <div class="row">${join}${cancel}</div>
    </div>`;
  };

  const renderList = (data) => {
    const items = data.items || [];
    if (!items.length) {
      listEl.innerHTML = emptyState(state.scope === 'upcoming' ? 'No upcoming bookings.' : 'No past bookings.');
      return;
    }
    listEl.innerHTML = `<div class="stack">${items.map(bookingCard).join('')}</div>
      ${pagerHtml({ offset: state.offset, limit: LIMIT, total: data.total })}`;
    const pager = listEl.querySelector('.pager');
    if (pager) {
      pager.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-page]');
        if (!btn || btn.disabled) return;
        if (btn.dataset.page === 'prev') state.offset = Math.max(0, state.offset - LIMIT);
        else state.offset += LIMIT;
        loadList();
      });
    }
  };

  const loadList = async () => {
    listEl.innerHTML = '<p class="loading" role="status">Loading…</p>';
    try {
      const data = await get(`/bookings?scope=${encodeURIComponent(state.scope)}&limit=${LIMIT}&offset=${state.offset}`);
      renderList(data);
    } catch (err) {
      listEl.innerHTML = errorHtml(err);
    }
  };

  scopeBtns.forEach((b) => b.addEventListener('click', () => {
    if (state.scope === b.dataset.scope) return;
    state.scope = b.dataset.scope;
    state.offset = 0;
    scopeBtns.forEach((x) => {
      const active = x.dataset.scope === state.scope;
      x.setAttribute('aria-pressed', String(active));
      x.classList.toggle('btn-primary', active);
      x.classList.toggle('btn-ghost', !active);
    });
    loadList();
  }));

  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-cancel]');
    if (!btn) return;
    const id = btn.dataset.cancel;
    const priceCredits = Number(btn.dataset.price);
    const hoursLeft = (new Date(btn.dataset.start).getTime() - Date.now()) / 36e5;
    const confirmText = hoursLeft < 24
      ? 'This session starts in less than 24 hours. Cancelling now gives NO refund. Cancel anyway?'
      : `Cancel this booking? You will get a full refund of ${priceCredits} credits.`;
    if (!window.confirm(confirmText)) return;

    const allButtons = Array.from(listEl.querySelectorAll('button'));
    allButtons.forEach((b) => { b.disabled = true; });
    setMsg(msgEl, 'Cancelling…', 'info');
    try {
      const res = await post(`/bookings/${encodeURIComponent(id)}/cancel`, {});
      const refund = Number(res.refundCredits) || 0;
      setMsg(msgEl, refund > 0
        ? `Booking cancelled. ${refund} credits refunded.`
        : 'Booking cancelled. No refund was issued.', 'success');
      await loadList();
    } catch (err) {
      setMsg(msgEl, (err && err.message) || 'Could not cancel the booking.', 'error');
      allButtons.forEach((b) => { b.disabled = false; });
    }
  });

  await loadList();
}
