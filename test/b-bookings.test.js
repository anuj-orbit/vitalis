import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelBooking, completeBooking, createBooking, getBooking, listBookings,
} from "../src/bookings.js";
import { getBalance, listLedger } from "../src/credits.js";
import { makeEnv } from "./b-support.js";

const WED_11 = new Date("2026-11-18T11:00:00Z"); // 25h after T0
const AVAIL = [
  { weekday: 2, startTime: "08:00", endTime: "12:00" },
  { weekday: 3, startTime: "08:00", endTime: "12:00" },
];

async function setup(opts = {}) {
  const env = makeEnv(opts.env ?? {});
  const { user: pUser, provider } = await env.seedProvider({ priceCredits: 10, availability: AVAIL });
  const consumer = await env.seedUser();
  await env.fund(consumer.id, opts.funds ?? 50);
  const book = (startsAt = WED_11, who = consumer, providerId = provider.id) =>
    createBooking(env.deps, { consumer: who, providerId, startsAt: startsAt.toISOString?.() ?? startsAt });
  return { env, pUser, provider, consumer, book };
}
const codeOf = (status, code) => (e) => e.status === status && (code === undefined || e.code === code);

test("booking debits the price, snapshots it, and creates a jitsi meeting", async () => {
  const { env, provider, consumer, book } = await setup();
  const { booking, balance } = await book();
  assert.equal(balance, 40);
  assert.equal(booking.status, "confirmed");
  assert.equal(booking.priceCredits, 10);
  assert.equal(booking.durationMin, 60);
  assert.equal(booking.consumerId, consumer.id);
  assert.equal(booking.providerId, provider.id);
  assert.equal(booking.providerKind, "yoga");
  assert.equal(booking.startsAt.toISOString(), WED_11.toISOString());
  assert.match(booking.meetingUrl, /^https:\/\/meet\.jit\.si\/vitalis-[0-9a-f]{18}$/);
  const { items } = await listLedger(env.deps, { userId: consumer.id, reason: "booking" });
  assert.equal(items.length, 1);
  assert.equal(items[0].delta, -10);
  assert.equal(items[0].bookingId, booking.id);
  // price change later does not alter the booking
  await env.stores.providers.update(provider.id, { priceCredits: 99 });
  assert.equal((await env.stores.bookings.findById(booking.id)).priceCredits, 10);
});

test("402 when the balance is short; nothing is written", async () => {
  const { env, consumer, book } = await setup({ funds: 9 });
  await assert.rejects(book(), codeOf(402, "INSUFFICIENT_CREDITS"));
  assert.equal(await getBalance(env.deps, consumer.id), 9);
  assert.equal((await env.stores.bookings.list({})).total, 0);
});

test("exact balance can be fully spent", async () => {
  const { env, consumer, book } = await setup({ funds: 10 });
  assert.equal((await book()).balance, 0);
  assert.equal(await getBalance(env.deps, consumer.id), 0);
});

test("SELF_BOOKING, admin forbidden, unknown/unapproved provider 404", async () => {
  const { env, pUser, provider, book } = await setup();
  await env.fund(pUser.id, 50);
  await assert.rejects(book(WED_11, pUser), codeOf(422, "SELF_BOOKING"));
  const admin = await env.seedUser("admin");
  await assert.rejects(book(WED_11, admin), codeOf(403));
  await assert.rejects(book(WED_11, undefined, 9999), codeOf(404));
  await env.stores.providers.update(provider.id, { status: "pending" });
  await assert.rejects(book(), codeOf(404));
});

test("input validation", async () => {
  const { env, consumer, provider } = await setup();
  const go = (args) => createBooking(env.deps, { consumer, providerId: provider.id, startsAt: WED_11.toISOString(), ...args });
  await assert.rejects(go({ providerId: "1" }), codeOf(400));
  await assert.rejects(go({ providerId: 0 }), codeOf(400));
  await assert.rejects(go({ startsAt: "not a date" }), codeOf(400));
  await assert.rejects(go({ startsAt: undefined }), codeOf(400));
  await assert.rejects(go({ startsAt: 12345 }), codeOf(400));
});

test("SLOT_UNAVAILABLE: off-grid, outside availability, past, beyond horizon", async () => {
  const { book } = await setup();
  for (const t of [
    "2026-11-18T11:30:00Z", // off-grid
    "2026-11-18T12:00:00Z", // after the last slot
    "2026-11-18T07:00:00Z", // before availability
    "2026-11-19T09:00:00Z", // no availability on Thursday
    "2026-11-17T09:00:00Z", // in the past
    "2027-03-01T09:00:00Z", // beyond horizon
    "2026-11-18T11:00:01Z",
  ]) {
    await assert.rejects(book(t), codeOf(422, "SLOT_UNAVAILABLE"), t);
  }
});

test("a slot that is already booked is 409 SLOT_TAKEN, and is not charged", async () => {
  const { env, provider, book } = await setup();
  await book();
  const other = await env.seedUser();
  await env.fund(other.id, 30);
  await assert.rejects(book(WED_11, other), codeOf(409, "SLOT_TAKEN"));
  assert.equal(await getBalance(env.deps, other.id), 30);
  assert.equal((await env.stores.bookings.listActiveForProvider(provider.id, new Date("2026-11-18T00:00:00Z"), new Date("2026-11-19T00:00:00Z"))).length, 1);
});

test("concurrent bookings of one slot: exactly one wins and only one debit", async () => {
  const { env, provider } = await setup();
  const users = [];
  for (let i = 0; i < 6; i++) { const u = await env.seedUser(); await env.fund(u.id, 20); users.push(u); }
  const results = await Promise.allSettled(users.map((u) =>
    createBooking(env.deps, { consumer: u, providerId: provider.id, startsAt: WED_11.toISOString() })));
  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 5);
  assert.ok(bad.every((r) => r.reason.status === 409 && r.reason.code === "SLOT_TAKEN"));
  const balances = await Promise.all(users.map((u) => getBalance(env.deps, u.id)));
  assert.equal(balances.filter((b) => b === 10).length, 1);
  assert.equal(balances.filter((b) => b === 20).length, 5);
  assert.equal((await listLedger(env.deps, { reason: "booking" })).total, 1);
  assert.equal((await env.stores.bookings.list({})).total, 1);
});

test("concurrent bookings by one consumer cannot overdraw", async () => {
  const { env, consumer, provider } = await setup({ funds: 25 });
  const slots = ["08:00", "09:00", "10:00", "11:00"].map((t) => `2026-11-18T${t}:00Z`);
  const results = await Promise.allSettled(slots.map((startsAt) =>
    createBooking(env.deps, { consumer, providerId: provider.id, startsAt })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.status === 402));
  assert.equal(await getBalance(env.deps, consumer.id), 5);
  assert.equal((await env.stores.bookings.list({ consumerId: consumer.id })).total, 2);
});

test("cancelled slot can be booked again", async () => {
  const { env, consumer, book } = await setup();
  const { booking } = await book();
  await cancelBooking(env.deps, { bookingId: booking.id, actor: consumer });
  const other = await env.seedUser();
  await env.fund(other.id, 10);
  assert.equal((await book(WED_11, other)).balance, 0);
});

test("consumer cancel at 25h: full refund", async () => {
  const { env, consumer, book } = await setup();
  const { booking } = await book();
  const r = await cancelBooking(env.deps, { bookingId: booking.id, actor: consumer });
  assert.equal(r.refundCredits, 10);
  assert.equal(r.booking.status, "cancelled");
  assert.equal(r.booking.cancelledAt.toISOString(), env.clock.now.toISOString());
  assert.equal(await getBalance(env.deps, consumer.id), 50);
  const refunds = await listLedger(env.deps, { userId: consumer.id, reason: "refund" });
  assert.equal(refunds.items[0].bookingId, booking.id);
});

test("consumer cancel exactly at 24h: full refund; at 23h: none (still cancelled)", async () => {
  const a = await setup();
  const b1 = (await a.book()).booking;
  a.env.clock.now = new Date("2026-11-17T11:00:00Z");
  assert.equal((await cancelBooking(a.env.deps, { bookingId: b1.id, actor: a.consumer })).refundCredits, 10);

  const { env, consumer, book } = await setup();
  const { booking } = await book();
  env.clock.now = new Date("2026-11-17T12:00:00Z");
  const r = await cancelBooking(env.deps, { bookingId: booking.id, actor: consumer });
  assert.equal(r.refundCredits, 0);
  assert.equal(r.booking.status, "cancelled");
  assert.equal(await getBalance(env.deps, consumer.id), 40);
  assert.equal((await listLedger(env.deps, { reason: "refund" })).total, 0);
});

test("provider and admin cancel always refund in full, even late", async () => {
  for (const who of ["provider", "admin"]) {
    const { env, pUser, consumer, book } = await setup();
    const { booking } = await book();
    env.clock.now = new Date("2026-11-18T10:30:00Z"); // 30 minutes before
    const actor = who === "provider" ? pUser : await env.seedUser("admin");
    const r = await cancelBooking(env.deps, { bookingId: booking.id, actor });
    assert.equal(r.refundCredits, 10, who);
    assert.equal(await getBalance(env.deps, consumer.id), 50);
  }
});

test("cancel after the start, twice, unknown id: 409/409/404", async () => {
  const { env, consumer, book } = await setup();
  const { booking } = await book();
  await assert.rejects(cancelBooking(env.deps, { bookingId: 9999, actor: consumer }), codeOf(404));
  env.clock.now = new Date("2026-11-18T11:00:00Z"); // exactly at start
  await assert.rejects(cancelBooking(env.deps, { bookingId: booking.id, actor: consumer }), codeOf(409, "CANCEL_NOT_ALLOWED"));
  env.clock.now = new Date("2026-11-18T12:30:00Z");
  await assert.rejects(cancelBooking(env.deps, { bookingId: booking.id, actor: consumer }), codeOf(409, "CANCEL_NOT_ALLOWED"));
  env.clock.now = new Date("2026-11-17T10:00:00Z");
  await cancelBooking(env.deps, { bookingId: booking.id, actor: consumer });
  await assert.rejects(cancelBooking(env.deps, { bookingId: booking.id, actor: consumer }), codeOf(409, "CANCEL_NOT_ALLOWED"));
  assert.equal(await getBalance(env.deps, consumer.id), 50); // refunded once only
});

test("concurrent cancels refund once", async () => {
  const { env, consumer, pUser, book } = await setup();
  const { booking } = await book();
  const results = await Promise.allSettled([
    cancelBooking(env.deps, { bookingId: booking.id, actor: consumer }),
    cancelBooking(env.deps, { bookingId: booking.id, actor: pUser }),
    cancelBooking(env.deps, { bookingId: booking.id, actor: consumer }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(await getBalance(env.deps, consumer.id), 50);
});

test("complete: before the end is 409; after the end pays floor(price*0.8)", async () => {
  const { env, pUser, book } = await setup();
  const { booking } = await book();
  env.clock.now = new Date("2026-11-18T11:59:59Z");
  await assert.rejects(completeBooking(env.deps, { bookingId: booking.id, actor: pUser }), codeOf(409, "NOT_COMPLETABLE"));
  env.clock.now = new Date("2026-11-18T12:00:00Z");
  const r = await completeBooking(env.deps, { bookingId: booking.id, actor: pUser });
  assert.equal(r.payoutCredits, 8);
  assert.equal(r.booking.status, "completed");
  assert.equal(r.booking.payoutCredits, 8);
  assert.equal(r.booking.completedAt.toISOString(), "2026-11-18T12:00:00.000Z");
  assert.equal(await getBalance(env.deps, pUser.id), 8);
  const payouts = await listLedger(env.deps, { userId: pUser.id, reason: "payout" });
  assert.equal(payouts.items[0].bookingId, booking.id);
});

test("payout rounds down and respects PLATFORM_FEE_PCT", async () => {
  const ten = await setup({ env: { env: { PLATFORM_FEE_PCT: "10" } } });
  const b = (await ten.book()).booking;
  ten.env.clock.now = new Date("2026-11-18T13:00:00Z");
  assert.equal((await completeBooking(ten.env.deps, { bookingId: b.id, actor: ten.pUser })).payoutCredits, 9);

  const odd = await setup();
  await odd.env.stores.providers.update(odd.provider.id, { priceCredits: 7 });
  const b2 = (await odd.book()).booking;
  odd.env.clock.now = new Date("2026-11-18T13:00:00Z");
  assert.equal((await completeBooking(odd.env.deps, { bookingId: b2.id, actor: odd.pUser })).payoutCredits, 5);

  const one = await setup();
  await one.env.stores.providers.update(one.provider.id, { priceCredits: 1 });
  const b3 = (await one.book()).booking;
  one.env.clock.now = new Date("2026-11-18T13:00:00Z");
  const r = await completeBooking(one.env.deps, { bookingId: b3.id, actor: one.pUser });
  assert.equal(r.payoutCredits, 0);
  assert.equal((await listLedger(one.env.deps, { reason: "payout" })).total, 0);
});

test("completing twice (even concurrently) pays once; cancelled/completed cannot flip", async () => {
  const { env, pUser, consumer, book } = await setup();
  const { booking } = await book();
  env.clock.now = new Date("2026-11-18T13:00:00Z");
  const results = await Promise.allSettled([
    completeBooking(env.deps, { bookingId: booking.id, actor: pUser }),
    completeBooking(env.deps, { bookingId: booking.id, actor: pUser }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "NOT_COMPLETABLE");
  assert.equal(await getBalance(env.deps, pUser.id), 8);
  await assert.rejects(cancelBooking(env.deps, { bookingId: booking.id, actor: consumer }), codeOf(409));
  assert.equal(await getBalance(env.deps, consumer.id), 40);

  const second = await book(new Date("2026-11-19T00:00:00Z")).catch(() => null);
  assert.equal(second, null); // unavailable slot, sanity
});

test("a cancelled booking cannot be completed", async () => {
  const { env, pUser, consumer, book } = await setup();
  const { booking } = await book();
  await cancelBooking(env.deps, { bookingId: booking.id, actor: consumer });
  env.clock.now = new Date("2026-11-18T13:00:00Z");
  await assert.rejects(completeBooking(env.deps, { bookingId: booking.id, actor: pUser }), codeOf(409, "NOT_COMPLETABLE"));
});

test("access control: get, cancel, complete", async () => {
  const { env, pUser, consumer, book } = await setup();
  const { booking } = await book();
  const stranger = await env.seedUser();
  const admin = await env.seedUser("admin");
  const otherProvider = (await env.seedProvider()).user;
  for (const actor of [stranger, otherProvider]) {
    await assert.rejects(getBooking(env.deps, { bookingId: booking.id, actor }), codeOf(403));
    await assert.rejects(cancelBooking(env.deps, { bookingId: booking.id, actor }), codeOf(403));
    await assert.rejects(completeBooking(env.deps, { bookingId: booking.id, actor }), codeOf(403));
  }
  for (const actor of [consumer, pUser, admin]) {
    assert.equal((await getBooking(env.deps, { bookingId: booking.id, actor })).id, booking.id);
  }
  env.clock.now = new Date("2026-11-18T13:00:00Z");
  await assert.rejects(completeBooking(env.deps, { bookingId: booking.id, actor: consumer }), codeOf(403));
  await assert.rejects(getBooking(env.deps, { bookingId: 9999, actor: admin }), codeOf(404));
  assert.equal((await completeBooking(env.deps, { bookingId: booking.id, actor: admin })).payoutCredits, 8);
  assert.equal(await getBalance(env.deps, pUser.id), 8); // goes to the provider, not the admin
});

test("listBookings: scopes, status, as=provider", async () => {
  const { env, pUser, consumer, book } = await setup();
  const b1 = (await book(new Date("2026-11-17T11:00:00Z"))).booking;
  const b2 = (await book(new Date("2026-11-18T08:00:00Z"))).booking;
  const b3 = (await book(new Date("2026-11-18T09:00:00Z"))).booking;
  await cancelBooking(env.deps, { bookingId: b3.id, actor: consumer });
  env.clock.now = new Date("2026-11-17T12:30:00Z");
  const ids = async (args) => (await listBookings(env.deps, { actor: consumer, ...args })).items.map((b) => b.id);
  assert.deepEqual(await ids({ scope: "upcoming" }), [b2.id]);
  assert.deepEqual(await ids({ scope: "upcoming", status: "cancelled" }), [b3.id]);
  assert.deepEqual(await ids({ scope: "past" }), [b1.id]);
  assert.deepEqual(await ids({ scope: "all" }), [b3.id, b2.id, b1.id]);
  assert.deepEqual(await ids({}), [b3.id, b2.id, b1.id]);
  assert.deepEqual(await ids({ scope: "all", limit: 1, offset: 1 }), [b2.id]);
  assert.equal((await listBookings(env.deps, { actor: consumer, scope: "all" })).total, 3);
  const asProvider = await listBookings(env.deps, { actor: pUser, as: "provider", scope: "all" });
  assert.equal(asProvider.total, 3);
  assert.equal(asProvider.items[0].consumerName, consumer.name);
  assert.equal((await listBookings(env.deps, { actor: pUser, scope: "all" })).total, 0); // as consumer
  await assert.rejects(listBookings(env.deps, { actor: consumer, as: "provider" }), codeOf(403));
  await assert.rejects(listBookings(env.deps, { actor: consumer, as: "x" }), codeOf(400));
  await assert.rejects(listBookings(env.deps, { actor: consumer, scope: "x" }), codeOf(400));
  await assert.rejects(listBookings(env.deps, { actor: consumer, status: "x" }), codeOf(400));
});

test("HTTP: full flow book -> list -> get -> cancel -> admin list", async () => {
  const { env, pUser, consumer, provider } = await setup();
  const admin = await env.seedUser("admin");
  const srv = await env.serve();
  try {
    let r = await srv.call("GET", `/api/providers/${provider.id}/slots?date=2026-11-18`);
    assert.equal(r.status, 200);
    assert.equal(r.body.timezone, "UTC");
    assert.equal(r.body.slots.length, 4);
    assert.equal(r.body.slots[0].startsAt, "2026-11-18T08:00:00.000Z");
    assert.equal(r.body.slots[0].endsAt, "2026-11-18T09:00:00.000Z");
    assert.equal((await srv.call("GET", `/api/providers/${provider.id}/slots?date=bad`)).status, 400);
    assert.equal((await srv.call("GET", `/api/providers/${provider.id}/slots`)).status, 400);
    assert.equal((await srv.call("GET", `/api/providers/9999/slots?date=2026-11-18`)).status, 404);
    assert.equal((await srv.call("GET", `/api/providers/abc/slots?date=2026-11-18`)).status, 404);

    const body = { providerId: provider.id, startsAt: "2026-11-18T11:00:00.000Z" };
    assert.equal((await srv.call("POST", "/api/bookings", { body })).status, 401);
    assert.equal((await srv.call("POST", "/api/bookings", { user: admin, body })).status, 403);
    assert.equal((await srv.call("POST", "/api/bookings", { user: pUser, body })).status, 422);
    r = await srv.call("POST", "/api/bookings", { user: consumer, body });
    assert.equal(r.status, 201);
    assert.equal(r.body.balance, 40);
    const id = r.body.booking.id;
    assert.equal((await srv.call("POST", "/api/bookings", { user: consumer, body })).status, 409);
    assert.equal((await srv.call("GET", `/api/providers/${provider.id}/slots?date=2026-11-18`)).body.slots[3].available, false);

    r = await srv.call("GET", "/api/bookings?scope=upcoming", { user: consumer });
    assert.equal(r.body.total, 1);
    assert.equal((await srv.call("GET", "/api/bookings?as=provider", { user: pUser })).body.total, 1);
    assert.equal((await srv.call("GET", "/api/bookings?as=provider", { user: consumer })).status, 403);
    assert.equal((await srv.call("GET", "/api/bookings?limit=1000", { user: consumer })).status, 400);
    assert.equal((await srv.call("GET", `/api/bookings/${id}`, { user: consumer })).body.booking.meetingUrl.startsWith("https://meet.jit.si/vitalis-"), true);
    const stranger = await env.seedUser();
    assert.equal((await srv.call("GET", `/api/bookings/${id}`, { user: stranger })).status, 403);
    assert.equal((await srv.call("GET", "/api/bookings/999", { user: consumer })).status, 404);
    assert.equal((await srv.call("POST", `/api/bookings/${id}/complete`, { user: pUser })).status, 409);

    assert.equal((await srv.call("GET", "/api/admin/bookings", { user: consumer })).status, 403);
    r = await srv.call("GET", `/api/admin/bookings?providerId=${provider.id}&status=confirmed`, { user: admin });
    assert.equal(r.body.total, 1);
    assert.equal((await srv.call("GET", "/api/admin/bookings?status=zzz", { user: admin })).status, 400);
    assert.equal((await srv.call("GET", "/api/admin/bookings?consumerId=x", { user: admin })).status, 400);

    r = await srv.call("POST", `/api/bookings/${id}/cancel`, { user: consumer });
    assert.equal(r.status, 200);
    assert.equal(r.body.refundCredits, 10);
    assert.equal((await srv.call("GET", "/api/credits/balance", { user: consumer })).body.balance, 50);
    assert.equal((await srv.call("POST", `/api/bookings/${id}/cancel`, { user: consumer })).status, 409);
  } finally {
    await srv.close();
  }
});
