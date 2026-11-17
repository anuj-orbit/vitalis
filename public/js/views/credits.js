// Buy credits: balance, pack cards and a simulated top-up flow.
import { get, post } from '../api.js';
import { esc, errorHtml, pageHeader, setMsg } from '../ui.js';
import { aed } from '../format.js';

export async function render(root, ctx) {
  let packs;
  let balance;
  try {
    [packs, balance] = await Promise.all([get('/credits/packs'), get('/credits/balance')]);
  } catch (err) {
    root.innerHTML = errorHtml(err);
    return;
  }

  const price = packs.creditPriceAed;
  const cards = (packs.packs || []).map((p) => `
    <div class="card pack">
      <p class="stat">${esc(String(p.credits))}</p>
      <p>${esc(aed(p.credits, price))}</p>
      <button type="button" class="btn btn-primary" data-pack="${esc(String(p.credits))}">Buy ${esc(String(p.credits))} credits</button>
    </div>`).join('');

  root.innerHTML = `${pageHeader('Buy credits', 'Demo payment: no real card is charged')}
    <section class="card">
      <p class="muted">Current balance</p>
      <p class="stat" id="balance-stat">${esc(String(balance.balance))}</p>
      <p id="balance-aed">${esc(aed(balance.balance, price))}</p>
    </section>
    <div id="msg" class="alert" role="status" hidden></div>
    <h2>Credit packs</h2>
    <div class="grid">${cards || '<p class="empty">No credit packs are available.</p>'}</div>
    <p class="muted">1 credit = ${esc(aed(1, price))}</p>`;

  const msgEl = document.getElementById('msg');
  const balanceStat = document.getElementById('balance-stat');
  const balanceAed = document.getElementById('balance-aed');
  const buttons = Array.from(root.querySelectorAll('button[data-pack]'));

  const onBuy = async (event) => {
    const btn = event.currentTarget;
    const pack = Number(btn.dataset.pack);
    const idempotencyKey = crypto.randomUUID();
    buttons.forEach((b) => { b.disabled = true; });
    setMsg(msgEl, 'Processing payment…', 'info');
    try {
      const res = await post('/credits/topup', { pack, idempotencyKey });
      balanceStat.textContent = String(res.balance);
      balanceAed.textContent = aed(res.balance, price);
      setMsg(msgEl, `Payment succeeded (ref ${res.payment.ref}). Added ${pack} credits for ${aed(pack, price)}. New balance: ${res.balance} credits.`, 'success');
    } catch (err) {
      if (err && err.code === 'PAYMENT_FAILED') {
        setMsg(msgEl, err.message || 'Payment failed. No charge was made.', 'error');
      } else {
        setMsg(msgEl, (err && err.message) || 'Something went wrong. Please try again.', 'error');
      }
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  };

  buttons.forEach((b) => b.addEventListener('click', onBuy));
}
