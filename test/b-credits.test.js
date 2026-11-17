import test from "node:test";
import assert from "node:assert/strict";
import { adjustCredits, applyLedgerEntry, getBalance, listLedger, packsFor, topUp } from "../src/credits.js";
import { createSimulatedPaymentProvider } from "../src/payments.js";
import { makeEnv } from "./b-support.js";

test("packsFor computes AED and fils", () => {
  const { config } = makeEnv();
  assert.deepEqual(packsFor(config), [
    { credits: 10, amountAed: 50, amountFils: 5000 },
    { credits: 25, amountAed: 125, amountFils: 12500 },
    { credits: 50, amountAed: 250, amountFils: 25000 },
    { credits: 100, amountAed: 500, amountFils: 50000 },
  ]);
  assert.equal(packsFor({ creditPacks: [10], creditPriceAed: 7 })[0].amountFils, 7000);
});

test("topUp credits the balance and records balanceAfter", async () => {
  const env = makeEnv();
  const u = await env.seedUser();
  const r = await topUp(env.deps, { userId: u.id, pack: 25 });
  assert.equal(r.replayed, false);
  assert.equal(r.balance, 25);
  assert.equal(r.entry.balanceAfter, 25);
  assert.equal(r.entry.delta, 25);
  assert.equal(r.entry.reason, "topup");
  assert.equal(r.payment.amountAed, 125);
  assert.match(r.payment.ref, /^sim_/);
  assert.equal((await topUp(env.deps, { userId: u.id, pack: 10 })).balance, 35);
  assert.equal(await getBalance(env.deps, u.id), 35);
});

test("topUp rejects packs that are not offered and bad keys", async () => {
  const env = makeEnv();
  const u = await env.seedUser();
  for (const pack of [5, "10", 0, -10, 10.5, null, undefined]) {
    await assert.rejects(topUp(env.deps, { userId: u.id, pack }), (e) => e.status === 400, String(pack));
  }
  for (const idempotencyKey of ["", "x".repeat(65), 5]) {
    await assert.rejects(topUp(env.deps, { userId: u.id, pack: 10, idempotencyKey }), (e) => e.status === 400);
  }
  assert.equal(await getBalance(env.deps, u.id), 0);
});

test("idempotency key replays without charging again", async () => {
  let charges = 0;
  const inner = createSimulatedPaymentProvider();
  const payments = { charge: (r) => { charges++; return inner.charge(r); } };
  const env = makeEnv({ payments });
  const u = await env.seedUser();
  const a = await topUp(env.deps, { userId: u.id, pack: 10, idempotencyKey: "abc" });
  const b = await topUp(env.deps, { userId: u.id, pack: 10, idempotencyKey: "abc" });
  assert.equal(b.replayed, true);
  assert.equal(b.entry.id, a.entry.id);
  assert.equal(b.balance, 10);
  assert.equal(b.payment.ref, a.payment.ref);
  assert.equal(charges, 1);
  // the same key from another user is independent
  const v = await env.seedUser();
  assert.equal((await topUp(env.deps, { userId: v.id, pack: 10, idempotencyKey: "abc" })).replayed, false);
  assert.equal((await listLedger(env.deps, { userId: u.id })).total, 1);
});

test("concurrent top-ups with one key credit exactly once", async () => {
  const env = makeEnv();
  const u = await env.seedUser();
  const results = await Promise.all(Array.from({ length: 5 }, () => topUp(env.deps, { userId: u.id, pack: 10, idempotencyKey: "race" })));
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.ok(results.every((r) => r.entry.id === results[0].entry.id));
  assert.equal(await getBalance(env.deps, u.id), 10);
});

test("failed payment gives 402 PAYMENT_FAILED and no ledger entry", async () => {
  const env = makeEnv({ payments: createSimulatedPaymentProvider({ fail: true }) });
  const u = await env.seedUser();
  await assert.rejects(topUp(env.deps, { userId: u.id, pack: 10, idempotencyKey: "k" }), (e) => e.status === 402 && e.code === "PAYMENT_FAILED");
  assert.equal((await listLedger(env.deps, { userId: u.id })).total, 0);
});

test("adjust adds and subtracts, never below zero", async () => {
  const env = makeEnv();
  const admin = await env.seedUser("admin");
  const u = await env.seedUser();
  const up = await adjustCredits(env.deps, { adminId: admin.id, userId: u.id, delta: 20, note: " promo " });
  assert.equal(up.balance, 20);
  assert.equal(up.entry.reason, "adjust");
  assert.equal(up.entry.note, "promo");
  assert.equal(up.entry.createdBy, admin.id);
  assert.equal((await adjustCredits(env.deps, { adminId: admin.id, userId: u.id, delta: -20, note: "clawback" })).balance, 0);
  await assert.rejects(adjustCredits(env.deps, { adminId: admin.id, userId: u.id, delta: -1, note: "n" }), (e) => e.status === 402 && e.code === "INSUFFICIENT_CREDITS");
  assert.equal(await getBalance(env.deps, u.id), 0);
});

test("adjust validation and unknown user", async () => {
  const env = makeEnv();
  const admin = await env.seedUser("admin");
  const u = await env.seedUser();
  const ok = { adminId: admin.id, userId: u.id, delta: 5, note: "n" };
  for (const bad of [{ delta: 0 }, { delta: 1.5 }, { delta: 100001 }, { delta: "5" }, { note: "" }, { note: "  " }, { note: "x".repeat(201) }, { note: 3 }, { userId: "1" }]) {
    await assert.rejects(adjustCredits(env.deps, { ...ok, ...bad }), (e) => e.status === 400, JSON.stringify(bad));
  }
  await assert.rejects(adjustCredits(env.deps, { ...ok, userId: 9999 }), (e) => e.status === 404);
  assert.equal((await listLedger(env.deps, {})).total, 0);
});

test("concurrent debits never overdraw", async () => {
  const env = makeEnv();
  const admin = await env.seedUser("admin");
  const u = await env.seedUser();
  await env.fund(u.id, 10);
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => adjustCredits(env.deps, { adminId: admin.id, userId: u.id, delta: -3, note: "d" })),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.status === 402));
  assert.equal(await getBalance(env.deps, u.id), 1);
});

test("applyLedgerEntry inside a tx is rolled back when a later step throws", async () => {
  const env = makeEnv();
  const u = await env.seedUser();
  await env.fund(u.id, 5);
  await assert.rejects(
    env.stores.tx(async (tx) => {
      await applyLedgerEntry(tx, { userId: u.id, delta: 100, reason: "adjust", note: "x" });
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await getBalance(env.deps, u.id), 5);
  assert.equal((await listLedger(env.deps, { userId: u.id })).total, 1);
  // store still usable after rollback
  assert.equal((await env.fund(u.id, 1)).balanceAfter, 6);
});

test("applyLedgerEntry validates inputs and duplicate refs", async () => {
  const env = makeEnv();
  const u = await env.seedUser();
  const run = (args) => env.stores.tx((tx) => applyLedgerEntry(tx, { userId: u.id, reason: "adjust", ...args }));
  await assert.rejects(run({ delta: 0 }), (e) => e.status === 400);
  await assert.rejects(run({ delta: 1, reason: "bogus" }), (e) => e.status === 400);
  await run({ delta: 1, ref: "r1" });
  await assert.rejects(run({ delta: 1, ref: "r1" }), (e) => e.status === 409 && e.code === "DUPLICATE_ENTRY");
  assert.equal(await getBalance(env.deps, u.id), 1);
});

test("ledger is newest first, balanceAfter is a running sum, filters and paging work", async () => {
  const env = makeEnv();
  const admin = await env.seedUser("admin");
  const u = await env.seedUser();
  const other = await env.seedUser();
  await topUp(env.deps, { userId: u.id, pack: 10 });
  await adjustCredits(env.deps, { adminId: admin.id, userId: u.id, delta: -4, note: "a" });
  await adjustCredits(env.deps, { adminId: admin.id, userId: u.id, delta: 7, note: "b" });
  await topUp(env.deps, { userId: other.id, pack: 100 });
  const { items, total } = await listLedger(env.deps, { userId: u.id });
  assert.equal(total, 3);
  assert.deepEqual(items.map((e) => e.balanceAfter), [13, 6, 10]);
  assert.ok(items[0].id > items[1].id && items[1].id > items[2].id);
  let running = 0;
  for (const e of [...items].reverse()) { running += e.delta; assert.equal(e.balanceAfter, running); }
  assert.equal((await listLedger(env.deps, { userId: u.id, reason: "topup" })).total, 1);
  assert.equal((await listLedger(env.deps, {})).total, 4);
  const page = await listLedger(env.deps, { userId: u.id, limit: 1, offset: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].balanceAfter, 6);
  await assert.rejects(listLedger(env.deps, { reason: "nope" }), (e) => e.status === 400);
});

test("HTTP: packs, balance, topup (201 then 200 replay), ledger, admin adjust", async () => {
  const env = makeEnv();
  const srv = await env.serve();
  try {
    const u = await env.seedUser();
    const admin = await env.seedUser("admin");
    let r = await srv.call("GET", "/api/credits/packs");
    assert.equal(r.status, 200);
    assert.equal(r.body.creditPriceAed, 5);
    assert.deepEqual(r.body.packs[0], { credits: 10, amountAed: 50 });
    assert.equal((await srv.call("GET", "/api/credits/balance")).status, 401);
    r = await srv.call("POST", "/api/credits/topup", { user: u, body: { pack: 25, idempotencyKey: "k1" } });
    assert.equal(r.status, 201);
    assert.equal(r.body.balance, 25);
    assert.equal(r.body.replayed, undefined);
    r = await srv.call("POST", "/api/credits/topup", { user: u, body: { pack: 25, idempotencyKey: "k1" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.replayed, true);
    assert.equal((await srv.call("POST", "/api/credits/topup", { user: u, body: { pack: 7 } })).status, 400);
    assert.equal((await srv.call("GET", "/api/credits/balance", { user: u })).body.balance, 25);
    assert.equal((await srv.call("GET", "/api/credits/ledger?reason=topup&limit=5", { user: u })).body.total, 1);
    assert.equal((await srv.call("GET", "/api/credits/ledger?limit=0", { user: u })).status, 400);
    assert.equal((await srv.call("GET", "/api/credits/ledger?reason=zzz", { user: u })).status, 400);

    assert.equal((await srv.call("POST", "/api/admin/credits/adjust", { user: u, body: { userId: u.id, delta: 5, note: "x" } })).status, 403);
    r = await srv.call("POST", "/api/admin/credits/adjust", { user: admin, body: { userId: u.id, delta: -30, note: "x" } });
    assert.equal(r.status, 402);
    r = await srv.call("POST", "/api/admin/credits/adjust", { user: admin, body: { userId: u.id, delta: -5, note: "x" } });
    assert.equal(r.status, 201);
    assert.equal(r.body.balance, 20);
    assert.equal((await srv.call("POST", "/api/admin/credits/adjust", { user: admin, body: { userId: 999, delta: 5, note: "x" } })).status, 404);
    r = await srv.call("GET", `/api/admin/credits/ledger?userId=${u.id}`, { user: admin });
    assert.equal(r.body.total, 2);
    assert.equal((await srv.call("GET", "/api/admin/credits/ledger", { user: u })).status, 403);
    assert.equal((await srv.call("GET", "/api/admin/credits/ledger?userId=abc", { user: admin })).status, 400);
  } finally {
    await srv.close();
  }
});

test("HTTP: failed payment gives 402 PAYMENT_FAILED", async () => {
  const env = makeEnv({ payments: createSimulatedPaymentProvider({ fail: true }) });
  const srv = await env.serve();
  try {
    const u = await env.seedUser();
    const r = await srv.call("POST", "/api/credits/topup", { user: u, body: { pack: 10 } });
    assert.equal(r.status, 402);
    assert.equal(r.body.error.code, "PAYMENT_FAILED");
  } finally {
    await srv.close();
  }
});
