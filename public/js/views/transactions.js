// Credit ledger: balance, reason filter and a paginated transaction table.
import { get } from '../api.js';
import { esc, errorHtml, pageHeader, emptyState, pagerHtml } from '../ui.js';
import { formatDubai } from '../format.js';

const LIMIT = 20;
const LABELS = { topup: 'Top-up', booking: 'Booking', refund: 'Refund', payout: 'Payout', adjust: 'Adjustment' };
const OPTIONS = [['all', 'All'], ['topup', 'Top-up'], ['booking', 'Booking'], ['refund', 'Refund'], ['payout', 'Payout'], ['adjust', 'Adjustment']];

export async function render(root, ctx) {
  const state = { reason: 'all', offset: 0 };

  let balance;
  try {
    balance = await get('/credits/balance');
  } catch (err) {
    root.innerHTML = errorHtml(err);
    return;
  }

  const options = OPTIONS.map(([value, label]) =>
    `<option value="${esc(value)}">${esc(label)}</option>`).join('');

  root.innerHTML = `${pageHeader('Transactions', 'Your credit history')}
    <section class="card">
      <p class="muted">Current balance</p>
      <p class="stat">${esc(String(balance.balance))}</p>
    </section>
    <div class="filters">
      <div>
        <label for="reason-filter">Reason</label>
        <select id="reason-filter">${options}</select>
      </div>
    </div>
    <div id="list"></div>`;

  const listEl = document.getElementById('list');

  const renderList = (data) => {
    const items = data.items || [];
    if (!items.length) {
      listEl.innerHTML = emptyState('No transactions found.');
      return;
    }
    const rows = items.map((entry) => {
      const positive = Number(entry.delta) >= 0;
      return `<tr>
        <td>${esc(formatDubai(entry.createdAt))}</td>
        <td>${esc(LABELS[entry.reason] || entry.reason)}</td>
        <td class="${positive ? 'pos' : 'neg'}">${esc((positive ? '+' : '') + String(entry.delta))}</td>
        <td>${esc(String(entry.balanceAfter))}</td>
        <td>${esc(entry.note || '')}</td>
      </tr>`;
    }).join('');
    listEl.innerHTML = `<div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Reason</th>
              <th scope="col">Change</th>
              <th scope="col">Balance after</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
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
    let path = `/credits/ledger?limit=${LIMIT}&offset=${state.offset}`;
    if (state.reason !== 'all') path += `&reason=${encodeURIComponent(state.reason)}`;
    try {
      const data = await get(path);
      renderList(data);
    } catch (err) {
      listEl.innerHTML = errorHtml(err);
    }
  };

  document.getElementById('reason-filter').addEventListener('change', (e) => {
    state.reason = e.currentTarget.value;
    state.offset = 0;
    loadList();
  });

  await loadList();
}
