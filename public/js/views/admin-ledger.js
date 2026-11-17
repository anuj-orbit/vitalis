// Admin: credit ledger (#/admin/ledger). Guard: admin.
import { get } from '../api.js';
import { esc, pageHeader, emptyState, errorHtml, pagerHtml } from '../ui.js';
import { formatDubai, aed } from '../format.js';
import { buildQuery } from '../router.js';

const PAGE = 20;
const REASONS = ['topup', 'booking', 'refund', 'payout', 'adjust'];

export async function render(root, ctx) {
  const state = { offset: 0 };

  root.innerHTML =
    pageHeader('Credit ledger') +
    `<form class="filters" id="filters">
      <div>
        <label for="userId">User ID</label>
        <input id="userId" type="number" min="1" step="1">
      </div>
      <div>
        <label for="reason">Reason</label>
        <select id="reason">
          <option value="" selected>All reasons</option>
          ${REASONS.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}
        </select>
      </div>
      <div><button type="submit" class="btn btn-primary">Apply filters</button></div>
    </form>
    <div class="alert" id="msg" hidden></div>
    <div id="list"></div>
    <div id="pager"></div>`;

  const filters = document.getElementById('filters');
  const userIdInput = document.getElementById('userId');
  const reasonSel = document.getElementById('reason');
  const listEl = document.getElementById('list');
  const pagerEl = document.getElementById('pager');

  async function load() {
    listEl.innerHTML = '<p class="loading" role="status">Loading…</p>';
    pagerEl.innerHTML = '';
    try {
      const params = { limit: PAGE, offset: state.offset, reason: reasonSel.value };
      const uid = Number(userIdInput.value);
      if (userIdInput.value !== '' && Number.isInteger(uid) && uid > 0) params.userId = uid;
      const data = await get(`/admin/credits/ledger${buildQuery(params)}`);
      renderList(data.items || [], Number(data.total) || 0);
    } catch (err) {
      listEl.innerHTML = errorHtml(err);
    }
  }

  function renderList(items, total) {
    if (!items.length) {
      listEl.innerHTML = emptyState('No ledger entries found.');
      return;
    }
    listEl.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>User</th><th>Date</th><th>Reason</th><th>Delta</th><th>Balance after</th><th>Booking</th><th>Note</th></tr></thead>
      <tbody>${items.map((e) => `<tr>
        <td>${esc(String(e.id))}</td>
        <td>${esc(String(e.userId))}</td>
        <td>${esc(formatDubai(e.createdAt))}</td>
        <td>${esc(e.reason)}</td>
        <td class="${e.delta > 0 ? 'pos' : 'neg'}">${e.delta > 0 ? '+' : ''}${esc(String(e.delta))}</td>
        <td>${esc(aed(e.balanceAfter))}</td>
        <td>${e.bookingId != null ? esc(String(e.bookingId)) : '<span class="muted">—</span>'}</td>
        <td>${e.note ? esc(e.note) : '<span class="muted">—</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;

    pagerEl.innerHTML = pagerHtml({ offset: state.offset, limit: PAGE, total });
    const prev = pagerEl.querySelector('[data-page="prev"]');
    const next = pagerEl.querySelector('[data-page="next"]');
    if (prev) prev.addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE); load(); });
    if (next) next.addEventListener('click', () => { state.offset += PAGE; load(); });
  }

  filters.addEventListener('submit', (e) => {
    e.preventDefault();
    state.offset = 0;
    load();
  });

  reasonSel.addEventListener('change', () => {
    state.offset = 0;
    load();
  });

  await load();
}
