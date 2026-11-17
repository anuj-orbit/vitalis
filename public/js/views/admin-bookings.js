// Admin: bookings (#/admin/bookings). Guard: admin.
import { get, post } from '../api.js';
import { esc, pageHeader, emptyState, statusBadge, errorHtml, setMsg, pagerHtml } from '../ui.js';
import { formatDubai, aed } from '../format.js';
import { buildQuery } from '../router.js';

const PAGE = 20;

export async function render(root, ctx) {
  const state = { offset: 0 };

  root.innerHTML =
    pageHeader('Bookings') +
    `<form class="filters" id="filters">
      <div>
        <label for="status">Status</label>
        <select id="status">
          <option value="" selected>All statuses</option>
          <option value="confirmed">Confirmed</option>
          <option value="cancelled">Cancelled</option>
          <option value="completed">Completed</option>
        </select>
      </div>
      <div>
        <label for="providerId">Provider ID</label>
        <input id="providerId" type="number" min="1" step="1">
      </div>
      <div>
        <label for="consumerId">Consumer ID</label>
        <input id="consumerId" type="number" min="1" step="1">
      </div>
      <div><button type="submit" class="btn btn-primary">Apply filters</button></div>
    </form>
    <div class="alert" id="msg" hidden></div>
    <div id="list"></div>
    <div id="pager"></div>`;

  const msg = document.getElementById('msg');
  const filters = document.getElementById('filters');
  const statusSel = document.getElementById('status');
  const providerInput = document.getElementById('providerId');
  const consumerInput = document.getElementById('consumerId');
  const listEl = document.getElementById('list');
  const pagerEl = document.getElementById('pager');

  async function load() {
    listEl.innerHTML = '<p class="loading" role="status">Loading…</p>';
    pagerEl.innerHTML = '';
    try {
      const params = { limit: PAGE, offset: state.offset, status: statusSel.value };
      const pid = Number(providerInput.value);
      if (providerInput.value !== '' && Number.isInteger(pid) && pid > 0) params.providerId = pid;
      const cid = Number(consumerInput.value);
      if (consumerInput.value !== '' && Number.isInteger(cid) && cid > 0) params.consumerId = cid;
      const data = await get(`/admin/bookings${buildQuery(params)}`);
      renderList(data.items || [], Number(data.total) || 0);
    } catch (err) {
      listEl.innerHTML = errorHtml(err);
    }
  }

  function renderList(items, total) {
    if (!items.length) {
      listEl.innerHTML = emptyState('No bookings found.');
      return;
    }
    listEl.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>Consumer</th><th>Provider</th><th>Starts</th><th>Status</th><th>Price</th><th></th></tr></thead>
      <tbody>${items.map((b) => `<tr data-booking="${esc(String(b.id))}">
        <td>${esc(String(b.id))}</td>
        <td>${esc(b.consumerName || '')}</td>
        <td>${esc(b.providerName || '')}</td>
        <td>${esc(formatDubai(b.startsAt))}</td>
        <td>${statusBadge(b.status)}</td>
        <td>${esc(aed(b.priceCredits))}</td>
        <td>${b.status === 'confirmed' ? `<button type="button" class="btn btn-danger" data-cancel="${esc(String(b.id))}">Cancel</button>` : ''}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;

    listEl.querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => cancel(btn));
    });

    pagerEl.innerHTML = pagerHtml({ offset: state.offset, limit: PAGE, total });
    const prev = pagerEl.querySelector('[data-page="prev"]');
    const next = pagerEl.querySelector('[data-page="next"]');
    if (prev) prev.addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE); load(); });
    if (next) next.addEventListener('click', () => { state.offset += PAGE; load(); });
  }

  async function cancel(btn) {
    const id = btn.dataset.cancel;
    if (!window.confirm('Cancel this booking? The consumer gets a full refund.')) return;
    const row = btn.closest('tr');
    const rowBtns = row ? [...row.querySelectorAll('button')] : [btn];
    rowBtns.forEach((b) => (b.disabled = true));
    try {
      await post(`/bookings/${id}/cancel`);
      setMsg(msg, 'Booking cancelled. The consumer was refunded.', 'success');
      await load();
    } catch (err) {
      setMsg(msg, err.message, 'error');
      rowBtns.forEach((b) => (b.disabled = false));
    }
  }

  filters.addEventListener('submit', (e) => {
    e.preventDefault();
    state.offset = 0;
    load();
  });

  statusSel.addEventListener('change', () => {
    state.offset = 0;
    load();
  });

  await load();
}
