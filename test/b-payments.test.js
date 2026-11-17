import test from "node:test";
import assert from "node:assert/strict";
import { createSimulatedPaymentProvider } from "../src/payments.js";

const req = { userId: 1, credits: 10, amountFils: 5000, currency: "AED", idempotencyKey: "k" };

test("simulated provider succeeds with a sim_ ref", async () => {
  const r = await createSimulatedPaymentProvider().charge(req);
  assert.equal(r.status, "succeeded");
  assert.match(r.ref, /^sim_[0-9a-f]{16}$/);
  assert.equal(r.failureReason, undefined);
});

test("refs are unique", async () => {
  const p = createSimulatedPaymentProvider();
  const refs = new Set();
  for (let i = 0; i < 50; i++) refs.add((await p.charge(req)).ref);
  assert.equal(refs.size, 50);
});

test("fail mode returns failed with a reason", async () => {
  const r = await createSimulatedPaymentProvider({ fail: true }).charge(req);
  assert.equal(r.status, "failed");
  assert.match(r.ref, /^sim_/);
  assert.ok(r.failureReason);
});
