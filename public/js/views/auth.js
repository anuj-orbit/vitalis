// Login and register (serves both routes; decided by ctx.path).
import { post } from '../api.js';
import { esc, setMsg, pageHeader } from '../ui.js';
import { buildQuery } from '../router.js';

export async function render(root, ctx) {
  const isRegister = ctx.path === '/register';
  const rawNext = typeof ctx.query.next === 'string' ? ctx.query.next : '';
  const next = rawNext.startsWith('#/') && rawNext !== '#//' ? rawNext : '';

  const otherBase = isRegister ? '#/login' : '#/register';
  const otherHref = otherBase + (next ? buildQuery({ next }) : '');

  const registerForm = `
    ${pageHeader('Create your account', 'Book yoga, fitness and doctor sessions with credits.')}
    <form class="form" id="auth-form" novalidate>
      <label for="name">Full name</label>
      <input id="name" name="name" type="text" autocomplete="name" maxlength="100" required>
      <p class="hint" id="err-name" role="alert" hidden></p>

      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" required>
      <p class="hint" id="err-email" role="alert" hidden></p>

      <label for="password">Password <span class="hint">(8–128 characters)</span></label>
      <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
      <p class="hint" id="err-password" role="alert" hidden></p>

      <p class="alert alert-error" id="form-msg" role="alert" hidden></p>
      <p><button class="btn btn-primary" type="submit" id="auth-submit">Create account</button></p>
    </form>
    <p class="muted">Already have an account? <a href="${esc(otherHref)}">Log in</a>.</p>
  `;

  const loginForm = `
    ${pageHeader('Log in', 'Welcome back to Vitalis.')}
    <form class="form" id="auth-form" novalidate>
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" required>
      <p class="hint" id="err-email" role="alert" hidden></p>

      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <p class="hint" id="err-password" role="alert" hidden></p>

      <p class="alert alert-error" id="form-msg" role="alert" hidden></p>
      <p><button class="btn btn-primary" type="submit" id="auth-submit">Log in</button></p>
    </form>
    <p class="muted">No account yet? <a href="${esc(otherHref)}">Create one</a>.</p>
  `;

  root.innerHTML = isRegister ? registerForm : loginForm;

  const form = root.querySelector('#auth-form');
  const emailEl = root.querySelector('#email');
  const passwordEl = root.querySelector('#password');
  const nameEl = root.querySelector('#name');
  const formMsg = root.querySelector('#form-msg');
  const submitBtn = root.querySelector('#auth-submit');
  const errEls = {
    email: root.querySelector('#err-email'),
    password: root.querySelector('#err-password'),
    name: nameEl ? root.querySelector('#err-name') : null,
  };
  const fieldEls = { email: emailEl, password: passwordEl, name: nameEl };

  function clearErrors() {
    setMsg(formMsg, '', 'error');
    for (const el of Object.values(errEls)) if (el) setMsg(el, '', 'error');
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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    const email = emailEl.value.trim();
    const password = passwordEl.value;
    const name = isRegister && nameEl ? nameEl.value.trim() : '';

    if (!email) {
      showFieldError('email', 'Email is required.');
      return;
    }
    if (!password) {
      showFieldError('password', 'Password is required.');
      return;
    }
    if (isRegister) {
      if (!name) {
        showFieldError('name', 'Name is required.');
        return;
      }
      if (password.length < 8 || password.length > 128) {
        showFieldError('password', 'Password must be 8–128 characters.');
        return;
      }
    }

    const body = isRegister ? { name, email, password } : { email, password };
    submitBtn.disabled = true;
    try {
      await post(isRegister ? '/auth/register' : '/auth/login', body);
      const me = await ctx.refreshMe();
      const dest = next || (me.user && me.user.role === 'admin' ? '#/admin/applications' : '#/dashboard');
      ctx.navigate(dest);
    } catch (err) {
      submitBtn.disabled = false;
      const field = err && err.details && err.details.field;
      if (field && errEls[field]) showFieldError(field, (err && err.message) || 'Invalid value.');
      else setMsg(formMsg, (err && err.message) || 'Something went wrong. Please try again.', 'error');
    }
  });
}
