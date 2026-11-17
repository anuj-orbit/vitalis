// Admin: users and credit adjustments (#/admin/users). Guard: admin.
import { get, post } from '../api.js';
import { esc, pageHeader, emptyState, errorHtml, setMsg, pagerHtml } from '../ui.js';
import { formatDubai, aed } from '../format.js';
import { buildQuery } from '../router.js';

const PAGE = 20;

export async function render(root, ctx) {
  const state = { offset: 0 };

  root.innerHTML =
    pageHeader('Users') +
    `<form class="filters" id="filters">
      <div>
        <label for="role">Role</label>
        <select id="role">
          <option value="" selected>All roles</option>
          <option value="consumer">Consumer</option>
          <option value="provider">Provider</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <div>
        <label for="q">Search name or email</label>
        <input id="q" type="search" maxlength="100">
      </div>
      <div><button type="submit" class="btn btn-primary">Search</button></div>
    </form>
    <div class="alert" id="msg" hidden></div>
    <div id="list"></div>
    <div id="pager"></div>`;

  const msg = document.getElementById('msg');
  const filters = document.getElementById('filters');
  const roleSel = document.getElementById('role');
  const qInput = document.getElementById('q');
  const listEl = document.getElementById('list');
  const pagerEl = document.getElementById('pager');

  function closeForms() {
    listEl.querySelectorAll('[data-form-for]').forEach((tr) => tr.remove());
  }

  async function load() {
    listEl.innerHTML = '<p class="loading" role="status">Loading…</p>';
    pagerEl.innerHTML = '';
    closeForms();
    try {
      const params = { limit: PAGE, offset: state.offset };
      if (roleSel.value) params.role = roleSel.value;
      if (qInput.value.trim()) params.q = qInput.value.trim();
      const data = await get(`/admin/users${buildQuery(params)}`);
      renderList(data.items || [], Number(data.total) || 0);
    } catch (err) {
      listEl.innerHTML = errorHtml(err);
    }
  }

  function balanceCell(u) {
    const n = Number(u.balance) || 0;
    return `${esc(aed(n))}<span class="muted"> (${esc(String(n))} credits)</span>`;
  }

  function renderList(items, total) {
    if (!items.length) {
      listEl.innerHTML = emptyState('No users found.');
      return;
    }
    listEl.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Role</th><th>Balance</th><th>Created</th><th></th></tr></thead>
      <tbody>${items.map((u) => `<tr data-user="${esc(String(u.id))}">
        <td>${esc(String(u.id))}</td>
        <td>${esc(u.name)}</td>
        <td>${esc(u.email)}</td>
        <td>${esc(u.role)}</td>
        <td data-balance>${balanceCell(u)}</td>
        <td>${esc(formatDubai(u.createdAt))}</td>
        <td><button type="button" class="btn btn-ghost" data-adjust="${esc(String(u.id))}">Adjust credits</button></td>
      </tr>`).join('')}</tbody>
    </table></div>`;

    listEl.querySelectorAll('[data-adjust]').forEach((btn) => {
      btn.addEventListener('click', () => openForm(btn));
    });

    pagerEl.innerHTML = pagerHtml({ offset: state.offset, limit: PAGE, total });
    const prev = pagerEl.querySelector('[data-page="prev"]');
    const next = pagerEl.querySelector('[data-page="next"]');
    if (prev) prev.addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE); load(); });
    if (next) next.addEventListener('click', () => { state.offset += PAGE; load(); });
  }

  function openForm(btn) {
    const row = btn.closest('tr');
    const userId = btn.dataset.adjust;
    if (row.nextElementSibling && row.nextElementSibling.dataset.formFor === userId) return;
    closeForms();

    const tr = document.createElement('tr');
    tr.dataset.formFor = userId;
    tr.innerHTML = `<td colspan="7">
      <form class="filters" data-adjust-form>
        <div>
          <label for="delta-${esc(userId)}">Delta (credits, non-zero, max 100000)</label>
          <input id="delta-${esc(userId)}" type="number" step="1" min="-100000" max="100000" required>
        </div>
        <div>
          <label for="note-${esc(userId)}">Note (1–200 characters)</label>
          <input id="note-${esc(userId)}" maxlength="200" required>
        </div>
        <div class="row">
          <button type="submit" class="btn btn-primary">Apply</button>
          <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        </div>
      </form>
      <div class="alert" hidden data-form-msg></div>
    </td>`;
    row.after(tr);

    const form = tr.querySelector('[data-adjust-form]');
    const formMsg = tr.querySelector('[data-form-msg]');
    const deltaInput = tr.querySelector('input[type="number"]');
    const noteInput = tr.querySelector('input:not([type="number"])');
    const submitBtn = form.querySelector('button[type="submit"]');

    tr.querySelector('[data-cancel]').addEventListener('click', () => tr.remove());

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const delta = Number(deltaInput.value);
      const note = noteInput.value.trim();
      if (!Number.isInteger(delta) || delta === 0) {
        setMsg(formMsg, 'Delta must be a non-zero whole number.', 'error');
        return;
      }
      if (Math.abs(delta) > 100000) {
        setMsg(formMsg, 'Delta must be between -100000 and 100000.', 'error');
        return;
      }
      if (note.length < 1 || note.length > 200) {
        setMsg(formMsg, 'Note must be 1–200 characters.', 'error');
        return;
      }

      submitBtn.disabled = true;
      try {
        const res = await post('/admin/credits/adjust', { userId: Number(userId), delta, note });
        const balance = Number(res.balance) || 0;
        const row2 = listEl.querySelector(`tr[data-user="${userId}"]`);
        const cell = row2 ? row2.querySelector('[data-balance]') : null;
        if (cell) cell.innerHTML = `${esc(aed(balance))}<span class="muted"> (${esc(String(balance))} credits)</span>`;
        tr.remove();
        setMsg(msg, `Adjusted ${delta > 0 ? '+' : ''}${delta} credits. New balance ${aed(balance)}.`, 'success');
      } catch (err) {
        setMsg(formMsg, err.message, 'error');
        submitBtn.disabled = false;
      }
    });
  }

  filters.addEventListener('submit', (e) => {
    e.preventDefault();
    state.offset = 0;
    load();
  });

  roleSel.addEventListener('change', () => {
    state.offset = 0;
    load();
  });

  await load();
}
