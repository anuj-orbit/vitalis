// Public landing page: hero, categories, credits explainer and featured providers.
import { get } from '../api.js';
import { esc, errorHtml, emptyState } from '../ui.js';
import { aed, kindLabel } from '../format.js';

const CATEGORIES = [
  { kind: 'yoga', label: 'Yoga trainers', blurb: 'Stretching, mobility and mindfulness sessions.' },
  { kind: 'fitness', label: 'Fitness trainers', blurb: 'Strength, conditioning and personal training.' },
  { kind: 'doctor', label: 'Doctors', blurb: 'Talk to licensed doctors online.' },
];

function providerCard(p) {
  return `<article class="card">
    <h3><a href="#/providers/${esc(p.id)}">${esc(p.name)}</a></h3>
    <p class="muted">${esc(kindLabel(p.kind))}</p>
    <p>${esc(p.specialty)}</p>
    <p class="price">${esc(p.priceCredits)} credits · ${esc(aed(p.priceCredits))}</p>
  </article>`;
}

export async function render(root, ctx) {
  const me = ctx.me;
  const cta = me.user
    ? '<a class="btn btn-primary" href="#/dashboard">Go to dashboard</a>'
    : '<a class="btn btn-primary" href="#/register">Create an account</a>';

  root.innerHTML = `
    <section class="hero">
      <h1>Online yoga, fitness and doctor sessions</h1>
      <p>Book live online sessions with vetted trainers and doctors. Pay with credits — 1 credit = 5 AED.</p>
      <div class="row">
        <a class="btn btn-primary" href="#/providers">Find a provider</a>
        ${cta}
      </div>
    </section>
    <section aria-labelledby="cats-h">
      <h2 id="cats-h">Browse by category</h2>
      <div class="grid">
        ${CATEGORIES.map((c) => `<article class="card"><h3><a href="#/providers?kind=${esc(c.kind)}">${esc(c.label)}</a></h3><p class="muted">${esc(c.blurb)}</p></article>`).join('')}
      </div>
    </section>
    <section aria-labelledby="how-h">
      <h2 id="how-h">How credits work</h2>
      <p>1 credit = 5 AED. Buy a pack of credits and spend them on any session. Unused credits stay in your account.</p>
      <div class="grid" id="packs"><p class="loading" role="status">Loading packs…</p></div>
    </section>
    <section aria-labelledby="featured-h">
      <h2 id="featured-h">Featured providers</h2>
      <div class="grid" id="featured"><p class="loading" role="status">Loading providers…</p></div>
    </section>
  `;

  const packsEl = root.querySelector('#packs');
  const featuredEl = root.querySelector('#featured');

  const [packsRes, providersRes] = await Promise.allSettled([
    get('/credits/packs'),
    get('/providers?limit=6'),
  ]);

  if (packsRes.status === 'fulfilled') {
    const data = packsRes.value || {};
    const packs = Array.isArray(data.packs) ? data.packs : [];
    packsEl.innerHTML = packs.length
      ? packs
          .map((p) => `<article class="card pack"><p class="stat">${esc(p.credits)}</p><p class="muted">credits</p><p class="price">${esc(p.amountAed)} AED</p></article>`)
          .join('')
      : emptyState('No credit packs are available right now.');
  } else {
    packsEl.innerHTML = errorHtml(packsRes.reason);
  }

  if (providersRes.status === 'fulfilled') {
    const items = (providersRes.value && providersRes.value.items) || [];
    featuredEl.innerHTML = items.length ? items.map(providerCard).join('') : emptyState('No providers to show yet.');
  } else {
    featuredEl.innerHTML = errorHtml(providersRes.reason);
  }
}
