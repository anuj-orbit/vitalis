// Provider directory with filters, search and pagination.
import { get } from '../api.js';
import { esc, errorHtml, emptyState, pageHeader, pagerHtml } from '../ui.js';
import { aed, kindLabel } from '../format.js';
import { buildQuery } from '../router.js';

const LIMIT = 12;
const KINDS = ['yoga', 'fitness', 'doctor'];

function card(p) {
  return `<article class="card">
    <h3><a href="#/providers/${esc(p.id)}">${esc(p.name)}</a></h3>
    <p class="muted">${esc(kindLabel(p.kind))}</p>
    <p>${esc(p.specialty)}</p>
    <p class="price">${esc(p.priceCredits)} credits · ${esc(aed(p.priceCredits))}</p>
  </article>`;
}

export async function render(root, ctx) {
  const q = ctx.query || {};
  const kind = KINDS.includes(q.kind) ? q.kind : '';
  const specialty = typeof q.specialty === 'string' ? q.specialty : '';
  const search = typeof q.q === 'string' ? q.q : '';
  const offset = Math.max(0, Number.parseInt(q.offset, 10) || 0);

  const opt = (value, label) => `<option value="${esc(value)}"${value === kind ? ' selected' : ''}>${esc(label)}</option>`;

  root.innerHTML = `
    ${pageHeader('Find a provider', 'Yoga trainers, fitness trainers and doctors.')}
    <form class="filters" id="filters" role="search">
      <div>
        <label for="f-kind">Category</label>
        <select id="f-kind" name="kind">
          ${opt('', 'All categories')}
          ${opt('yoga', 'Yoga trainer')}
          ${opt('fitness', 'Fitness trainer')}
          ${opt('doctor', 'Doctor')}
        </select>
      </div>
      <div>
        <label for="f-specialty">Specialty</label>
        <input id="f-specialty" name="specialty" type="text" maxlength="80" value="${esc(specialty)}">
      </div>
      <div>
        <label for="f-q">Search</label>
        <input id="f-q" name="q" type="search" value="${esc(search)}">
      </div>
      <div>
        <button class="btn btn-primary" type="submit">Apply filters</button>
      </div>
    </form>
    <div id="results"><p class="loading" role="status">Loading providers…</p></div>
  `;

  const form = root.querySelector('#filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const next = buildQuery({
      kind: fd.get('kind'),
      specialty: String(fd.get('specialty') || '').trim(),
      q: String(fd.get('q') || '').trim(),
    });
    ctx.navigate('#/providers' + next);
  });

  const resultsEl = root.querySelector('#results');
  let data;
  try {
    data = await get('/providers' + buildQuery({ kind, specialty, q: search, limit: LIMIT, offset }));
  } catch (err) {
    resultsEl.innerHTML = errorHtml(err);
    return;
  }

  const items = (data && data.items) || [];
  const total = (data && data.total) || 0;
  if (!items.length) {
    resultsEl.innerHTML = emptyState('No providers match your search.');
    return;
  }

  resultsEl.innerHTML = `<div class="grid">${items.map(card).join('')}</div>
    ${pagerHtml({ offset, limit: LIMIT, total })}`;

  resultsEl.querySelectorAll('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dir = btn.getAttribute('data-page');
      const nextOffset = dir === 'prev' ? Math.max(0, offset - LIMIT) : offset + LIMIT;
      ctx.navigate('#/providers' + buildQuery({ kind, specialty, q: search, offset: nextOffset || '' }));
    });
  });
}
