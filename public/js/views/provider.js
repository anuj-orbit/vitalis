// Provider detail: profile, weekly availability and a UTC slot picker with booking.
import { get, post } from '../api.js';
import { esc, errorHtml, emptyState, pageHeader, setMsg } from '../ui.js';
import { aed, kindLabel, formatDubai, WEEKDAYS, utcTimeToDubai, todayUtc, DISCLAIMER } from '../format.js';

export async function render(root, ctx) {
  const id = ctx.params.id;
  let data;
  try {
    data = await get('/providers/' + encodeURIComponent(id));
  } catch (err) {
    root.innerHTML = pageHeader('Provider') + errorHtml(err);
    return;
  }

  const provider = data.provider || {};
  const availability = Array.isArray(data.availability) ? data.availability : [];
  const me = ctx.me;

  const today = todayUtc();
  const horizon = new Date();
  horizon.setUTCDate(horizon.getUTCDate() + 60);
  const maxDate = todayUtc(horizon);

  const availHtml = availability.length
    ? `<ul class="stack">${availability
        .map(
          (a) =>
            `<li>${esc(WEEKDAYS[a.weekday] || 'Unknown day')}: ${esc(a.startTime)}–${esc(a.endTime)} UTC (${esc(utcTimeToDubai(a.startTime))}–${esc(utcTimeToDubai(a.endTime))} Dubai)</li>`
        )
        .join('')}</ul>`
    : emptyState('No weekly availability published.');

  const doctorDisclaimer = provider.kind === 'doctor' ? `<div class="disclaimer">${esc(DISCLAIMER)}</div>` : '';

  root.innerHTML = `
    <p><a class="muted" href="#/providers">← Back to providers</a></p>
    ${pageHeader(provider.name || 'Provider', kindLabel(provider.kind))}
    <div class="grid">
      <article class="card">
        <h2>About</h2>
        <p>${esc(provider.specialty || '')}</p>
        <p>${provider.bio ? esc(provider.bio) : '<span class="muted">No bio provided.</span>'}</p>
        <h3>Credentials</h3>
        <p>${esc(provider.credentials || '')}</p>
        ${provider.licenseNo ? `<p><strong>License number:</strong> ${esc(provider.licenseNo)}</p>` : ''}
        <p class="price">${esc(provider.priceCredits)} credits · ${esc(aed(provider.priceCredits))}</p>
        ${doctorDisclaimer}
      </article>
      <article class="card">
        <h2>Weekly availability (UTC)</h2>
        ${availHtml}
      </article>
    </div>
    <section aria-labelledby="book-h">
      <h2 id="book-h">Book a session</h2>
      <div class="form">
        <label for="slot-date">Date (UTC)</label>
        <input id="slot-date" type="date" min="${esc(today)}" max="${esc(maxDate)}" value="${esc(today)}">
        <p class="hint muted">Times are shown in Dubai time (GST, UTC+4). The date you pick is a UTC calendar day.</p>
      </div>
      ${doctorDisclaimer}
      <div id="slots" class="slots" aria-live="polite"></div>
      <div id="booking-area" class="stack"></div>
    </section>
  `;

  const slotsEl = root.querySelector('#slots');
  const bookingEl = root.querySelector('#booking-area');
  const dateInput = root.querySelector('#slot-date');
  let selected = null;

  function roleNote() {
    if (me.user && me.user.role === 'admin') return 'Admins cannot make bookings.';
    if (me.provider && Number(me.provider.id) === Number(provider.id)) {
      return 'This is your own provider profile, so you cannot book your own sessions.';
    }
    return null;
  }

  function handleBookError(err, msgEl) {
    if (err && err.status === 402) {
      setMsg(msgEl, (err.message || 'Not enough credits.') + ' ', 'error');
      const link = document.createElement('a');
      link.href = '#/credits';
      link.textContent = 'Buy credits';
      msgEl.appendChild(link);
      return;
    }
    if (err && err.status === 409 && err.code === 'SLOT_TAKEN') {
      setMsg(msgEl, 'That time was just taken. Reloading available times.', 'error');
      loadSlots();
      return;
    }
    setMsg(msgEl, (err && err.message) || 'Booking failed. Please try again.', 'error');
  }

  function renderBooking() {
    if (!selected) {
      bookingEl.innerHTML = '';
      return;
    }
    const note = roleNote();
    if (note) {
      bookingEl.innerHTML = `<p class="alert alert-info" role="status">${esc(note)}</p>`;
      return;
    }
    bookingEl.innerHTML = `<button type="button" class="btn btn-primary" id="book-btn">Book this session</button><div id="book-confirm"></div>`;
    const bookBtn = bookingEl.querySelector('#book-btn');
    const confirmEl = bookingEl.querySelector('#book-confirm');
    bookBtn.addEventListener('click', () => {
      if (!me.user) {
        ctx.navigate('#/login?next=' + encodeURIComponent(location.hash));
        return;
      }
      bookBtn.disabled = true;
      confirmEl.innerHTML = `
        <p>Selected time: <strong>${esc(formatDubai(selected))}</strong></p>
        <p>This session costs <strong>${esc(provider.priceCredits)} credits</strong> (${esc(aed(provider.priceCredits))}).</p>
        <button type="button" class="btn btn-primary" id="confirm-book">Confirm booking</button>
        <p class="alert alert-error" id="book-msg" role="alert" hidden></p>
      `;
      const confirmBtn = confirmEl.querySelector('#confirm-book');
      const msgEl = confirmEl.querySelector('#book-msg');
      confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        setMsg(msgEl, '', 'error');
        try {
          const res = await post('/bookings', { providerId: Number(provider.id), startsAt: selected });
          const balance = res && res.balance;
          bookingEl.innerHTML = `<div class="alert alert-success" role="status">Booked for ${esc(formatDubai(selected))}. Your balance is now ${esc(balance)} credits. <a href="#/bookings">View my bookings</a></div>`;
        } catch (err) {
          confirmBtn.disabled = false;
          handleBookError(err, msgEl);
        }
      });
    });
  }

  async function loadSlots() {
    selected = null;
    bookingEl.innerHTML = '';
    const date = dateInput.value;
    if (!date) {
      slotsEl.innerHTML = emptyState('Choose a date to see available times.');
      return;
    }
    slotsEl.innerHTML = '<p class="loading" role="status">Loading times…</p>';
    let res;
    try {
      res = await get(`/providers/${encodeURIComponent(id)}/slots?date=${encodeURIComponent(date)}`);
    } catch (err) {
      slotsEl.innerHTML = errorHtml(err);
      return;
    }
    const slots = Array.isArray(res.slots) ? res.slots : [];
    if (!slots.length) {
      slotsEl.innerHTML = emptyState('No times available on this date.');
      return;
    }
    slotsEl.innerHTML = slots
      .map(
        (s) =>
          `<button type="button" class="slot" data-starts="${esc(s.startsAt)}" aria-pressed="false" ${s.available ? '' : 'disabled'}>${esc(formatDubai(s.startsAt))}</button>`
      )
      .join('');
    slotsEl.querySelectorAll('button.slot').forEach((btn) => {
      btn.addEventListener('click', () => {
        selected = btn.getAttribute('data-starts');
        slotsEl.querySelectorAll('button.slot').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
        renderBooking();
      });
    });
  }

  dateInput.addEventListener('change', loadSlots);
  await loadSlots();
}
