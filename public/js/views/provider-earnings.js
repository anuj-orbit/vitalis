// Provider earnings (#/provider/earnings). Guard: prov.
import { get } from '../api.js';
import { esc, pageHeader, emptyState, errorHtml, pagerHtml } from '../ui.js';
import { formatDubai, aed } from '../format.js';

const PAGE = 20;

export async function render(root, ctx) {
  const state = { offset: 0 };

  root.innerHTML =
    pageHeader('Earnings', 'Payouts from completed sessions') +
    `<div id="head"></div>
     <div id="list"></div>
     <div id="pager"></div>`;

  const headEl = document.getElementById('head');
  const listEl = document.getElementById('list');
  const pagerEl = document.getElementById('pager');

  try {
    const bal = await get('/credits/balance');
    const balance = Number(bal.balance) || 0;
    headEl.innerHTML = `<div class="card">
      <p class="muted">Available balance</p>
      <p class="stat">${esc(aed(balance))}</p>
      <p class="muted">${esc(String(balance))} credits</p>
    </div>
    <p class="muted">Credits are paid out when a session is marked completed. The platform keeps a fee, so your payout is less than the session price; each payout amount is shown below.</p>`;
  } catch (err) {
    headEl.innerHTML = errorHtml(err);
  }

  async function load() {
    listEl.innerHTML = '<p class="loading" role="status">Loading…</p>';
    pagerEl.innerHTML = '';
    try {
      const data = await get(`/credits/ledger?reason=payout&limit=${PAGE}&offset=${state.offset}`);
      renderList(data);
    } catch (err) {
      listEl.innerHTML = errorHtml(err);
    }
  }

  function renderList(data) {
    const items = data.items || [];
    if (!items.length) {
      listEl.innerHTML = emptyState('No payouts yet.');
      return;
    }
    listEl.innerHTML = `<h2>Payouts</h2><div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Credits</th><th>Balance after</th><th>Booking</th></tr></thead>
      <tbody>${items.map((e) => `<tr>
        <td>${esc(formatDubai(e.createdAt))}</td>
        <td class="pos">+${esc(String(e.delta))}</td>
        <td>${esc(aed(e.balanceAfter))}</td>
        <td>${e.bookingId != null ? esc(String(e.bookingId)) : '<span class="muted">—</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;

    pagerEl.innerHTML = pagerHtml({ offset: state.offset, limit: PAGE, total: data.total });
    const prev = pagerEl.querySelector('[data-page="prev"]');
    const next = pagerEl.querySelector('[data-page="next"]');
    if (prev) prev.addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE); load(); });
    if (next) next.addEventListener('click', () => { state.offset += PAGE; load(); });
  }

  await load();
}
