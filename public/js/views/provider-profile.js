// Provider profile and availability editor (#/provider/profile). Guard: prov.
import { get, put } from '../api.js';
import { esc, pageHeader, errorHtml, setMsg, emptyState } from '../ui.js';
import { aed, kindLabel, WEEKDAYS, utcTimeToDubai } from '../format.js';

const MAX_ROWS = 28;
const pad2 = (n) => String(n).padStart(2, '0');

const WEEKDAY_OPTIONS = WEEKDAYS.map((d, i) => `<option value="${i}">${esc(d)}</option>`).join('');
const START_OPTIONS = Array.from({ length: 24 }, (_, h) => `<option value="${pad2(h)}:00">${pad2(h)}:00</option>`).join('');
const END_OPTIONS = Array.from({ length: 24 }, (_, i) => {
  const v = `${pad2(i + 1)}:00`;
  return `<option value="${v}">${v}</option>`;
}).join('');

function normalizeHour(t) {
  const h = Number(String(t || '').split(':')[0]);
  if (!Number.isFinite(h) || h < 0 || h > 24) return '00:00';
  return `${pad2(h)}:00`;
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

export async function render(root, ctx) {
  let me;
  try {
    me = await get('/providers/me');
  } catch (err) {
    root.innerHTML = errorHtml(err);
    return;
  }

  const provider = me.provider;
  if (!provider) {
    root.innerHTML =
      pageHeader('Provider profile') +
      emptyState('You do not have a provider profile yet.') +
      `<p><a class="btn btn-primary" href="#/apply">Apply to become a provider</a></p>`;
    return;
  }

  const isDoctor = provider.kind === 'doctor';

  root.innerHTML =
    pageHeader('Profile and availability', `${kindLabel(provider.kind)} · status ${provider.status}`) +
    `<div class="stack">
      <section class="card">
        <h2>Profile</h2>
        <form class="form wide" id="profile-form" novalidate>
          <div class="alert" id="profile-msg" hidden></div>
          <label for="pf-specialty">Specialty</label>
          <input id="pf-specialty" maxlength="80" value="${esc(provider.specialty)}" required>
          <label for="pf-bio">Bio</label>
          <textarea id="pf-bio" rows="5" maxlength="2000">${esc(provider.bio)}</textarea>
          <label for="pf-credentials">Credentials</label>
          <textarea id="pf-credentials" rows="3" maxlength="2000" required>${esc(provider.credentials)}</textarea>
          <label for="pf-license">License number${isDoctor ? ' (required for doctors)' : ' (optional)'}</label>
          <input id="pf-license" maxlength="80" value="${esc(provider.licenseNo || '')}">
          <label for="pf-price">Session price (credits)</label>
          <input id="pf-price" type="number" min="1" max="1000" step="1" value="${esc(String(provider.priceCredits))}" required>
          <p class="hint">Equals <span id="pf-aed">${esc(aed(provider.priceCredits))}</span>.</p>
          <div class="row">
            <button type="submit" class="btn btn-primary" id="profile-save">Save profile</button>
            <span class="muted">Kind is ${esc(kindLabel(provider.kind))} and cannot be changed.</span>
          </div>
        </form>
      </section>

      <section class="card">
        <h2>Weekly availability (UTC)</h2>
        <p class="muted">Set your recurring weekly hours in UTC. Times are the same every week. The Dubai equivalent (GST, UTC+4) is shown next to each time.</p>
        <div class="alert" id="avail-msg" hidden></div>
        <div id="avail-rows" class="stack"></div>
        <div class="row">
          <button type="button" class="btn btn-ghost" id="avail-add">Add row</button>
          <button type="button" class="btn btn-primary" id="avail-save">Save availability</button>
          <span class="muted">At most ${MAX_ROWS} rows; hours must not overlap on the same weekday.</span>
        </div>
      </section>
    </div>`;

  const profileMsg = document.getElementById('profile-msg');
  const availMsg = document.getElementById('avail-msg');
  const availRowsEl = document.getElementById('avail-rows');
  const addBtn = document.getElementById('avail-add');
  const availSaveBtn = document.getElementById('avail-save');

  // ---- Profile form ----
  const fields = {
    specialty: document.getElementById('pf-specialty'),
    bio: document.getElementById('pf-bio'),
    credentials: document.getElementById('pf-credentials'),
    licenseNo: document.getElementById('pf-license'),
    priceCredits: document.getElementById('pf-price'),
  };
  const aedSpan = document.getElementById('pf-aed');

  const original = {
    specialty: provider.specialty,
    bio: provider.bio,
    credentials: provider.credentials,
    licenseNo: provider.licenseNo || '',
    priceCredits: String(provider.priceCredits),
  };

  fields.priceCredits.addEventListener('input', () => {
    const n = Number(fields.priceCredits.value);
    aedSpan.textContent = Number.isFinite(n) && n > 0 ? aed(n) : '—';
  });

  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = {};
    if (fields.specialty.value.trim() !== original.specialty) patch.specialty = fields.specialty.value.trim();
    if (fields.bio.value !== original.bio) patch.bio = fields.bio.value;
    if (fields.credentials.value !== original.credentials) patch.credentials = fields.credentials.value;
    if (fields.licenseNo.value.trim() !== original.licenseNo) patch.licenseNo = fields.licenseNo.value.trim();
    if (fields.priceCredits.value !== original.priceCredits) patch.priceCredits = Number(fields.priceCredits.value);

    if (isDoctor && !fields.licenseNo.value.trim()) {
      setMsg(profileMsg, 'A license number is required for doctors.', 'error');
      return;
    }
    if (patch.priceCredits !== undefined && (!Number.isInteger(patch.priceCredits) || patch.priceCredits < 1 || patch.priceCredits > 1000)) {
      setMsg(profileMsg, 'Price must be a whole number of credits between 1 and 1000.', 'error');
      return;
    }
    if (!Object.keys(patch).length) {
      setMsg(profileMsg, 'No changes to save.', 'info');
      return;
    }

    const saveBtn = document.getElementById('profile-save');
    saveBtn.disabled = true;
    try {
      const res = await put('/providers/me', patch);
      const p = res.provider || {};
      original.specialty = fields.specialty.value.trim();
      original.bio = fields.bio.value;
      original.credentials = fields.credentials.value;
      original.licenseNo = fields.licenseNo.value.trim();
      original.priceCredits = String(p.priceCredits != null ? p.priceCredits : fields.priceCredits.value);
      setMsg(profileMsg, 'Profile saved.', 'success');
    } catch (err) {
      setMsg(profileMsg, err.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ---- Availability editor ----
  let rows = (me.availability || []).map((a) => ({
    weekday: Number(a.weekday),
    start: normalizeHour(a.startTime),
    end: normalizeHour(a.endTime),
  }));

  function validateRows() {
    for (const r of rows) {
      if (toMinutes(r.start) >= toMinutes(r.end)) return 'Each row must have a start before its end.';
    }
    const byDay = {};
    for (const r of rows) (byDay[r.weekday] || (byDay[r.weekday] = [])).push(r);
    for (const list of Object.values(byDay)) {
      list.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
      for (let i = 1; i < list.length; i++) {
        if (toMinutes(list[i].start) < toMinutes(list[i - 1].end)) {
          return 'Availability hours must not overlap on the same weekday.';
        }
      }
    }
    return null;
  }

  function renderRows() {
    if (!rows.length) {
      availRowsEl.innerHTML = emptyState('No availability set. Add a row to offer weekly hours.');
      return;
    }
    availRowsEl.innerHTML = rows.map((r, i) => `<div class="avail-row" data-i="${i}">
      <div>
        <label for="avail-wd-${i}">Weekday</label>
        <select id="avail-wd-${i}" data-field="weekday">${WEEKDAY_OPTIONS}</select>
      </div>
      <div>
        <label for="avail-start-${i}">Start (UTC)</label>
        <select id="avail-start-${i}" data-field="start">${START_OPTIONS}</select>
        <span class="hint muted" data-dubai="start"></span>
      </div>
      <div>
        <label for="avail-end-${i}">End (UTC)</label>
        <select id="avail-end-${i}" data-field="end">${END_OPTIONS}</select>
        <span class="hint muted" data-dubai="end"></span>
      </div>
      <button type="button" class="btn btn-danger" data-remove="${i}">Remove</button>
    </div>`).join('');

    availRowsEl.querySelectorAll('.avail-row').forEach((rowEl) => {
      const i = Number(rowEl.dataset.i);
      const wd = rowEl.querySelector('[data-field="weekday"]');
      const st = rowEl.querySelector('[data-field="start"]');
      const en = rowEl.querySelector('[data-field="end"]');
      wd.value = String(rows[i].weekday);
      st.value = rows[i].start;
      en.value = rows[i].end;

      const update = () => {
        rows[i].weekday = Number(wd.value);
        rows[i].start = st.value;
        rows[i].end = en.value;
        rowEl.querySelector('[data-dubai="start"]').textContent = `${utcTimeToDubai(rows[i].start)} Dubai`;
        rowEl.querySelector('[data-dubai="end"]').textContent = `${utcTimeToDubai(rows[i].end)} Dubai`;
      };
      wd.addEventListener('change', update);
      st.addEventListener('change', update);
      en.addEventListener('change', update);

      rowEl.querySelector('[data-remove]').addEventListener('click', () => {
        rows.splice(i, 1);
        renderRows();
      });
      update();
    });
  }

  addBtn.addEventListener('click', () => {
    if (rows.length >= MAX_ROWS) {
      setMsg(availMsg, `At most ${MAX_ROWS} availability rows.`, 'error');
      return;
    }
    rows.push({ weekday: 1, start: '09:00', end: '17:00' });
    renderRows();
  });

  availSaveBtn.addEventListener('click', async () => {
    const problem = validateRows();
    if (problem) {
      setMsg(availMsg, problem, 'error');
      return;
    }
    availSaveBtn.disabled = true;
    addBtn.disabled = true;
    try {
      const payload = {
        availability: rows.map((r) => ({ weekday: Number(r.weekday), startTime: r.start, endTime: r.end })),
      };
      await put('/providers/me/availability', payload);
      setMsg(availMsg, 'Availability saved.', 'success');
    } catch (err) {
      setMsg(availMsg, err.message, 'error');
    } finally {
      availSaveBtn.disabled = false;
      addBtn.disabled = false;
    }
  });

  renderRows();
}
