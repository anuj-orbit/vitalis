// Admin: provider applications (#/admin/applications). Guard: admin.
import { get, post } from '../api.js';
import { esc, pageHeader, emptyState, statusBadge, errorHtml, setMsg } from '../ui.js';
import { formatDubai, aed, kindLabel } from '../format.js';

export async function render(root, ctx) {
  root.innerHTML =
    pageHeader('Provider applications') +
    `<div class="filters">
      <div>
        <label for="status">Status</label>
        <select id="status">
          <option value="pending" selected>Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
      </div>
    </div>
    <div class="alert" id="msg" hidden></div>
    <div id="list"></div>`;

  const msg = document.getElementById('msg');
  const statusSel = document.getElementById('status');
  const listEl = document.getElementById('list');

  async function load() {
    listEl.innerHTML = '<p class="loading" role="status">Loading…</p>';
    try {
      const data = await get(`/admin/applications?status=${encodeURIComponent(statusSel.value)}`);
      renderList(data.items || []);
    } catch (err) {
      listEl.innerHTML = errorHtml(err);
    }
  }

  function renderList(items) {
    if (!items.length) {
      listEl.innerHTML = emptyState('No applications found.');
      return;
    }
    listEl.innerHTML = `<div class="grid">${items.map(cardHtml).join('')}</div>`;
    listEl.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => act(btn));
    });
  }

  function cardHtml(a) {
    const canApprove = a.status === 'pending' || a.status === 'rejected';
    const canReject = a.status === 'pending' || a.status === 'approved';
    const actions = [];
    if (canApprove) actions.push(`<button type="button" class="btn btn-primary" data-action="approve" data-id="${esc(String(a.id))}">Approve</button>`);
    if (canReject) actions.push(`<button type="button" class="btn btn-danger" data-action="reject" data-id="${esc(String(a.id))}">Reject</button>`);

    return `<article class="card stack" data-app="${esc(String(a.id))}">
      <div class="row row-between"><strong>${esc(a.name)}</strong>${statusBadge(a.status)}</div>
      <p class="muted">${esc(a.email)}</p>
      <p><strong>Kind:</strong> ${esc(kindLabel(a.kind))}</p>
      <p><strong>Specialty:</strong> ${esc(a.specialty)}</p>
      <p><strong>Credentials:</strong> ${esc(a.credentials)}</p>
      ${a.licenseNo ? `<p><strong>License:</strong> ${esc(a.licenseNo)}</p>` : ''}
      ${a.bio ? `<p><strong>Bio:</strong> ${esc(a.bio)}</p>` : ''}
      <p><strong>Price:</strong> <span class="price">${esc(aed(a.priceCredits))}</span></p>
      <p class="muted"><strong>Applied:</strong> ${esc(formatDubai(a.createdAt))}</p>
      ${a.reviewNote ? `<p class="muted"><strong>Review note:</strong> ${esc(a.reviewNote)}</p>` : ''}
      ${actions.length ? `<label for="note-${esc(String(a.id))}">Note (optional)</label>
        <input id="note-${esc(String(a.id))}" data-note maxlength="200">` : ''}
      ${actions.length ? `<div class="row">${actions.join('')}</div>` : ''}
    </article>`;
  }

  async function act(btn) {
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    const card = btn.closest('[data-app]');
    const noteInput = card.querySelector('[data-note]');
    const note = noteInput ? noteInput.value.trim() : '';
    const buttons = [...card.querySelectorAll('button')];
    buttons.forEach((b) => (b.disabled = true));
    try {
      await post(`/admin/applications/${id}/${action}`, note ? { note } : {});
      setMsg(msg, action === 'approve' ? 'Application approved.' : 'Application rejected.', 'success');
      await load();
    } catch (err) {
      setMsg(msg, err.message, 'error');
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  statusSel.addEventListener('change', load);

  await load();
}
