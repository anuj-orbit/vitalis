// Shared view helpers. Every string interpolated into HTML goes through esc().
import { escapeHtml } from './format.js';

export const esc = escapeHtml;

export function loading(root, label = 'Loading…') {
  root.innerHTML = `<p class="loading" role="status">${esc(label)}</p>`;
}

export function errorHtml(err) {
  const msg = err && err.message ? err.message : 'Something went wrong.';
  return `<div class="alert alert-error" role="alert">${esc(msg)}</div>`;
}

export function showError(root, err) {
  root.innerHTML = errorHtml(err);
}

// Inline status message inside an element with a [data-msg] child (or the given element).
export function setMsg(el, text, kind = 'error') {
  el.className = `alert alert-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = text;
  el.hidden = !text;
}

export function pageHeader(title, subtitle = '') {
  return `<header class="page-head"><h1>${esc(title)}</h1>${subtitle ? `<p class="muted">${esc(subtitle)}</p>` : ''}</header>`;
}

export function emptyState(text) {
  return `<p class="empty">${esc(text)}</p>`;
}

export function statusBadge(status) {
  return `<span class="badge badge-${esc(status)}">${esc(status)}</span>`;
}

export function pagerHtml({ offset, limit, total }) {
  const prev = offset > 0;
  const next = offset + limit < total;
  if (!prev && !next) return '';
  return `<nav class="pager" aria-label="Pagination">
    <button type="button" class="btn btn-ghost" data-page="prev" ${prev ? '' : 'disabled'}>Previous</button>
    <span class="muted">${total ? offset + 1 : 0}–${Math.min(offset + limit, total)} of ${total}</span>
    <button type="button" class="btn btn-ghost" data-page="next" ${next ? '' : 'disabled'}>Next</button>
  </nav>`;
}
