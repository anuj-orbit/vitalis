// Provider application / re-application (login required, admins excluded).
import { get, post } from '../api.js';
import { esc, errorHtml, setMsg, pageHeader, statusBadge } from '../ui.js';
import { aed } from '../format.js';

const KINDS = ['yoga', 'fitness', 'doctor'];

export async function render(root, ctx) {
  const me = ctx.me;
  if (me.user && me.user.role === 'admin') {
    root.innerHTML =
      pageHeader('Become a provider') +
      '<div class="alert alert-info" role="status">Admins cannot apply to become a provider.</div>';
    return;
  }

  let data;
  try {
    data = await get('/providers/me');
  } catch (err) {
    root.innerHTML = pageHeader('Become a provider') + errorHtml(err);
    return;
  }

  const provider = data.provider || null;

  if (provider && provider.status === 'pending') {
    root.innerHTML =
      pageHeader('Application under review', 'We review every application before it goes live.') +
      `<p>Status: ${statusBadge(provider.status)}</p>` +
      '<div class="alert alert-info" role="status">Your application is under review. We will let you know once it is approved.</div>' +
      '<p><a class="btn btn-ghost" href="#/dashboard">Back to dashboard</a></p>';
    return;
  }

  if (provider && provider.status === 'approved') {
    root.innerHTML =
      pageHeader('You are a provider') +
      '<div class="alert alert-success" role="status">Your provider profile is approved.</div>' +
      '<p><a class="btn btn-primary" href="#/provider">Go to your provider area</a></p>';
    return;
  }

  const isReapply = !!provider;
  const p = provider || {};
  const kind = KINDS.includes(p.kind) ? p.kind : 'yoga';
  const v = (x) => (x == null ? '' : String(x));
  const sel = (value) => (value === kind ? ' selected' : '');

  root.innerHTML = `
    ${pageHeader(isReapply ? 'Re-apply to become a provider' : 'Become a provider', 'An admin reviews every application before it goes live.')}
    ${isReapply && p.reviewNote ? `<div class="alert alert-error" role="alert"><strong>Previous review note:</strong> ${esc(p.reviewNote)}</div>` : ''}
    <form class="form wide" id="apply-form" novalidate>
      <label for="kind">Category</label>
      <select id="kind" name="kind">
        <option value="yoga"${sel('yoga')}>Yoga trainer</option>
        <option value="fitness"${sel('fitness')}>Fitness trainer</option>
        <option value="doctor"${sel('doctor')}>Doctor</option>
      </select>
      <p class="hint" id="err-kind" role="alert" hidden></p>

      <label for="specialty">Specialty <span class="hint">(1–80 characters)</span></label>
      <input id="specialty" name="specialty" type="text" maxlength="80" required value="${esc(v(p.specialty))}">
      <p class="hint" id="err-specialty" role="alert" hidden></p>

      <label for="bio">Bio <span class="hint">(up to 2000 characters)</span></label>
      <textarea id="bio" name="bio" rows="5" maxlength="2000">${esc(v(p.bio))}</textarea>
      <p class="hint" id="err-bio" role="alert" hidden></p>

      <label for="credentials">Credentials <span class="hint">(1–2000 characters)</span></label>
      <textarea id="credentials" name="credentials" rows="4" maxlength="2000" required>${esc(v(p.credentials))}</textarea>
      <p class="hint" id="err-credentials" role="alert" hidden></p>

      <label for="licenseNo">License number <span class="hint" id="license-hint"></span></label>
      <input id="licenseNo" name="licenseNo" type="text" maxlength="80" value="${esc(v(p.licenseNo))}">
      <p class="hint" id="err-licenseNo" role="alert" hidden></p>

      <label for="priceCredits">Price per session (credits) <span class="hint">(1–1000)</span></label>
      <input id="priceCredits" name="priceCredits" type="number" min="1" max="1000" step="1" required value="${esc(v(p.priceCredits))}">
      <p class="hint" id="price-preview" aria-live="polite"></p>
      <p class="hint" id="err-priceCredits" role="alert" hidden></p>

      <p class="alert alert-error" id="form-msg" role="alert" hidden></p>
      <p><button class="btn btn-primary" type="submit" id="apply-submit">Submit application</button></p>
    </form>
  `;

  const form = root.querySelector('#apply-form');
  const kindEl = root.querySelector('#kind');
  const specialtyEl = root.querySelector('#specialty');
  const bioEl = root.querySelector('#bio');
  const credentialsEl = root.querySelector('#credentials');
  const licenseEl = root.querySelector('#licenseNo');
  const priceEl = root.querySelector('#priceCredits');
  const licenseHint = root.querySelector('#license-hint');
  const previewEl = root.querySelector('#price-preview');
  const formMsg = root.querySelector('#form-msg');
  const submitBtn = root.querySelector('#apply-submit');

  const errEls = {
    kind: root.querySelector('#err-kind'),
    specialty: root.querySelector('#err-specialty'),
    bio: root.querySelector('#err-bio'),
    credentials: root.querySelector('#err-credentials'),
    licenseNo: root.querySelector('#err-licenseNo'),
    priceCredits: root.querySelector('#err-priceCredits'),
  };
  const fieldEls = {
    kind: kindEl,
    specialty: specialtyEl,
    bio: bioEl,
    credentials: credentialsEl,
    licenseNo: licenseEl,
    priceCredits: priceEl,
  };

  function clearErrors() {
    setMsg(formMsg, '', 'error');
    for (const el of Object.values(errEls)) setMsg(el, '', 'error');
  }

  function showFieldError(key, msg) {
    const el = errEls[key];
    if (el) {
      setMsg(el, msg, 'error');
      const field = fieldEls[key];
      if (field) field.focus();
    } else {
      setMsg(formMsg, msg, 'error');
    }
  }

  function updateLicenseState() {
    const isDoctor = kindEl.value === 'doctor';
    licenseEl.required = isDoctor;
    licenseHint.textContent = isDoctor ? '(required for doctors)' : '(optional)';
  }

  function updatePreview() {
    const n = Number(priceEl.value);
    previewEl.textContent = Number.isInteger(n) && n >= 1 ? `${n} credits = ${aed(n)}` : '';
  }

  kindEl.addEventListener('change', updateLicenseState);
  priceEl.addEventListener('input', updatePreview);
  updateLicenseState();
  updatePreview();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    const submittedKind = kindEl.value;
    const specialty = specialtyEl.value.trim();
    const bio = bioEl.value.trim();
    const credentials = credentialsEl.value.trim();
    const licenseNo = licenseEl.value.trim();
    const priceCredits = Number(priceEl.value);

    if (!specialty || specialty.length > 80) {
      showFieldError('specialty', 'Specialty must be 1–80 characters.');
      return;
    }
    if (bio.length > 2000) {
      showFieldError('bio', 'Bio must be at most 2000 characters.');
      return;
    }
    if (!credentials || credentials.length > 2000) {
      showFieldError('credentials', 'Credentials must be 1–2000 characters.');
      return;
    }
    if (licenseNo.length > 80) {
      showFieldError('licenseNo', 'License number must be at most 80 characters.');
      return;
    }
    if (submittedKind === 'doctor' && !licenseNo) {
      showFieldError('licenseNo', 'License number is required for doctors.');
      return;
    }
    if (!Number.isInteger(priceCredits) || priceCredits < 1 || priceCredits > 1000) {
      showFieldError('priceCredits', 'Price must be a whole number between 1 and 1000.');
      return;
    }

    const body = { kind: submittedKind, specialty, bio, credentials, priceCredits };
    if (licenseNo) body.licenseNo = licenseNo;

    submitBtn.disabled = true;
    try {
      await post('/providers/apply', body);
      await ctx.refreshMe();
      root.innerHTML =
        pageHeader('Application submitted') +
        '<div class="alert alert-success" role="status">Your application was submitted and is pending admin review.</div>' +
        '<p><a class="btn btn-ghost" href="#/dashboard">Back to dashboard</a></p>';
    } catch (err) {
      submitBtn.disabled = false;
      if (err && err.code === 'ALREADY_APPLIED') {
        setMsg(formMsg, (err && err.message) || 'You already have an application under review.', 'error');
        return;
      }
      const field = err && err.details && err.details.field;
      if (field && errEls[field]) showFieldError(field, (err && err.message) || 'Invalid value.');
      else setMsg(formMsg, (err && err.message) || 'Submission failed. Please try again.', 'error');
    }
  });
}
