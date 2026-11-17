// Runs only when TEST_DATABASE_URL points at a disposable Postgres database.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../src/schema.js";
import { createPgStores } from "../src/stores/index.js";
import { loadConfig } from "../src/config.js";
import { createSimulatedPaymentProvider } from "../src/payments.js";
import { adjustCredits, applyLedgerEntry, getBalance, topUp } from "../src/credits.js";
import { cancelBooking, completeBooking, createBooking } from "../src/bookings.js";

const url = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-11-17T10:00:00Z");
const SLOT = "2026-11-18T11:00:00.000Z";

test("postgres stores", { skip: url ? false : "TEST_DATABASE_URL is not set" }, async (t) => {
  const pool = new pg.Pool({ connectionString: url, max: 12 });
  t.after(() => pool.end());

  await migrate(pool);
  await migrate(pool); // idempotent

  const stores = createPgStores(pool);
  const config = loadConfig({ SESSION_SECRET: "s".repeat(40) });
  const deps = { stores, config, payments: createSimulatedPaymentProvider(), now: () => NOW };
  const tag = randomBytes(4).toString("hex");
  const mkUser = (name, role = "consumer") =>
    stores.users.create({ email: `${name}-${tag}@example.com`, passwordHash: "x", name, role });
  const fund = (userId, delta) =>
    stores.tx((tx) => applyLedgerEntry(tx, { userId, delta, reason: "adjust", note: "seed" }));

  const pUser = await mkUser("prov", "provider");
  let provider = await stores.providers.create({
    userId: pUser.id, kind: "yoga", specialty: "Vinyasa", bio: "", credentials: "RYT", licenseNo: null, priceCredits: 10,
  });
  provider = await stores.providers.update(provider.id, { status: "approved" });
  await stores.availability.replaceForProvider(provider.id, [{ weekday: 3, startTime: "08:00", endTime: "12:00" }]);

  await t.test("top-up is idempotent and ledger rows are consistent", async () => {
    const u = await mkUser("topper");
    const a = await topUp(deps, { userId: u.id, pack: 10, idempotencyKey: "k" });
    const b = await topUp(deps, { userId: u.id, pack: 10, idempotencyKey: "k" });
    assert.equal(b.replayed, true);
    assert.equal(b.entry.id, a.entry.id);
    assert.equal(await getBalance(deps, u.id), 10);
    await assert.rejects(adjustCredits(deps, { adminId: u.id, userId: u.id, delta: -11, note: "n" }), (e) => e.status === 402);
    const raced = await Promise.all(Array.from({ length: 5 }, () => topUp(deps, { userId: u.id, pack: 25, idempotencyKey: "race" })));
    assert.equal(raced.filter((r) => !r.replayed).length, 1);
    assert.equal(await getBalance(deps, u.id), 35);
  });

  await t.test("concurrent booking of one slot: one 201, rest 409 SLOT_TAKEN, one debit", async () => {
    const users = [];
    for (let i = 0; i < 6; i++) { const u = await mkUser(`race${i}`); await fund(u.id, 20); users.push(u); }
    const results = await Promise.allSettled(users.map((u) =>
      createBooking(deps, { consumer: u, providerId: provider.id, startsAt: SLOT })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "SLOT_TAKEN"));
    const balances = await Promise.all(users.map((u) => getBalance(deps, u.id)));
    assert.deepEqual(balances.slice().sort(), [10, 20, 20, 20, 20, 20]);

    const winner = results.find((r) => r.status === "fulfilled").value.booking;
    const consumer = users[balances.indexOf(10)];
    // cancel (25h ahead) refunds once, frees the slot, and the index allows rebooking
    const [c1, c2] = await Promise.allSettled([
      cancelBooking(deps, { bookingId: winner.id, actor: consumer }),
      cancelBooking(deps, { bookingId: winner.id, actor: consumer }),
    ]);
    assert.equal([c1, c2].filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(await getBalance(deps, consumer.id), 20);
    await createBooking(deps, { consumer: users[0], providerId: provider.id, startsAt: SLOT });
  });

  await t.test("FOR UPDATE prevents a negative balance under 10 parallel bookings", async () => {
    const u = await mkUser("greedy");
    await fund(u.id, 25);
    const slots = ["08:00", "09:00", "10:00", "11:00"].map((h) => `2026-11-25T${h}:00.000Z`);
    const attempts = [...slots, ...slots, ...slots.slice(0, 2)];
    const results = await Promise.allSettled(attempts.map((startsAt) =>
      createBooking(deps, { consumer: u, providerId: provider.id, startsAt })));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(ok, 2);
    assert.equal(await getBalance(deps, u.id), 5);
    const { rows } = await pool.query("SELECT min(balance_after) AS m FROM credit_ledger WHERE user_id = $1", [u.id]);
    assert.ok(rows[0].m >= 0);
  });

  await t.test("complete pays the provider once", async () => {
    const u = await mkUser("payer");
    await fund(u.id, 10);
    const { booking } = await createBooking(deps, { consumer: u, providerId: provider.id, startsAt: "2026-12-02T09:00:00.000Z" });
    const late = { ...deps, now: () => new Date("2026-12-02T10:00:00Z") };
    const before = await getBalance(deps, pUser.id);
    const results = await Promise.allSettled([
      completeBooking(late, { bookingId: booking.id, actor: pUser }),
      completeBooking(late, { bookingId: booking.id, actor: pUser }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(await getBalance(deps, pUser.id), before + 8);
  });
});
