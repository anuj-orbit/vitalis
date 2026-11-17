// Provider bookings (#/provider/bookings). Guard: prov.
import { get, post } from '../api.js';
import { esc, pageHeader, emptyState, statusBadge, errorHtml, setMsg, pagerHtml } from '../ui.js';
import { formatDubai, aed } from '../format.js';

const PAGE = 20;

function meetLink(url) {
  if (typeof url === 'string' && url.startsWith('https://')) {
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Join</a>`;
  }
  return '';
}

export async function render(root, ctx) {
  const state = { offset: 0 };

  root.innerHTML =
    pageHeader('Provider bookings') +
    `<div class="filters">
      <div>
        <label for="scope">Show</label>
        <select id="scope">
          <option value="upcoming">Upcoming</option>
          <option value="past">Past</option>
          <option value="all" selected>All</option>
        </select>
      </div>
    </div>
    <div class="alert" id="msg" hidden></div>
    <div id="list"></div>
    <div id="pager"></div>`;

  const msg = document.getElementById('msg');
  const scopeSel = document.getElementById('scope');
  const listEl = document.getElementById('list');
  const pagerEl = document.getElementById('pager');

  async function load() {
    listEl.innerHTML = '<p class="loading" role="status">Loading…</p>';
    pagerEl.innerHTML = '';
    try {
      const data = await get(`/bookings?as=provider&scope=${encodeURIComponent(scopeSel.value)}&limit=${PAGE}&offset=${state.offset}`);
      renderList(data.items || [], Number(data.total) || 0);
    } catch (err) {
      listEl.innerHTML = errorHtml(err);
    }
  }

  function renderList(items, total) {
    if (!items.length) {
      listEl.innerHTML = emptyState('No bookings in this view.');
      return;
    }
    listEl.innerHTML = `<div class="stack">${items.map(cardHtml).join('')}</div>`;
    listEl.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => act(btn, items));
    });
    pagerEl.innerHTML = pagerHtml({ offset: state.offset, limit: PAGE, total });
    const prev = pagerEl.querySelector('[data-page="prev"]');
    const next = pagerEl.querySelector('[data-page="next"]');
    if (prev) prev.addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE); load(); });
    if (next) next.addEventListener('click', () => { state.offset += PAGE; load(); });
  }

  function cardHtml(b) {
    const startMs = new Date(b.startsAt).getTime();
    const endMs = startMs + (Number(b.durationMin) || 60) * 60000;
    const ended = Date.now() >= endMs;
    const future = startMs > Date.now();
    const confirmed = b.status === 'confirmed';

    let actions = '';
    if (confirmed) {
      actions += ended
        ? `<button type="button" class="btn btn-primary" data-action="complete" data-id="${esc(String(b.id))}">Mark completed</button>`
        : `<button type="button" class="btn btn-primary" data-action="complete" data-id="${esc(String(b.id))}" disabled>Mark completed</button>`;
      if (future) {
        actions += `<button type="button" class="btn btn-danger" data-action="cancel" data-id="${esc(String(b.id))}">Cancel</button>`;
      }
    }

    return `<article class="card stack" data-booking="${esc(String(b.id))}">
      <div class="row row-between"><strong>${esc(b.consumerName || 'Client')}</strong>${statusBadge(b.status)}</div>
      <p class="muted">${esc(formatDubai(b.startsAt))}</p>
      <p>Price: <span class="price">${esc(aed(b.priceCredits))}</span></p>
      ${typeof b.payoutCredits === 'number' ? `<p>Payout: <span class="pos">${esc(aed(b.payoutCredits))}</span></p>` : ''}
      ${confirmed ? `<p>${meetLink(b.meetingUrl) || '<span class="muted">Join link available soon</span>'}</p>` : ''}
      ${confirmed && !ended ? '<p class="hint muted">You can mark this session completed after it ends.</p>' : ''}
      ${actions ? `<div class="row">${actions}</div>` : ''}
    </article>`;
  }

  async function act(btn, items) {
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    const b = items.find((x) => String(x.id) === id);
    if (action === 'cancel' && !window.confirm('Cancel this session? The client gets a full refund.')) return;

    const cardEl = btn.closest('[data-booking]');
    const cardBtns = cardEl ? [...cardEl.querySelectorAll('button')] : [btn];
    cardBtns.forEach((x) => (x.disabled = true));

    try {
      const res = action === 'complete' ? await post(`/bookings/${id}/complete`) : await post(`/bookings/${id}/cancel`);
      if (action === 'complete') {
        const extra = res && typeof res.payoutCredits === 'number' ? ` Payout: ${aed(res.payoutCredits)}.` : '';
        setMsg(msg, `Booking marked completed.${extra}`, 'success');
      } else {
        setMsg(msg, 'Booking cancelled. The client was refunded.', 'success');
      }
      await load();
    } catch (err) {
      setMsg(msg, err.message, 'error');
      cardBtns.forEach((x) => (x.disabled = false));
    }
  }

  scopeSel.addEventListener('change', () => {
    state.offset = 0;
    load();
  });

  await load();
}
