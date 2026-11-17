import test from "node:test";
import assert from "node:assert/strict";
import { computeSlots, getSlots, makeMeetingUrl, payoutFor } from "../src/bookings.js";
import { makeEnv, T0 } from "./b-support.js";

const iso = (s) => s.startsAt.toISOString();
const base = { now: T0, bookings: [] };

test("weekday mapping uses UTC day (2026-11-17 is Tuesday, 2)", () => {
  const availability = [{ weekday: 2, startTime: "11:00", endTime: "13:00" }, { weekday: 3, startTime: "08:00", endTime: "09:00" }];
  assert.deepEqual(computeSlots({ ...base, date: "2026-11-17", availability }).map(iso), [
    "2026-11-17T11:00:00.000Z", "2026-11-17T12:00:00.000Z",
  ]);
  assert.deepEqual(computeSlots({ ...base, date: "2026-11-18", availability }).map(iso), ["2026-11-18T08:00:00.000Z"]);
  assert.deepEqual(computeSlots({ ...base, date: "2026-11-19", availability }), []);
});

test("60-minute stepping drops a partial tail; endsAt is +60min", () => {
  const slots = computeSlots({ ...base, date: "2026-11-18", availability: [{ weekday: 3, startTime: "08:00", endTime: "10:30" }] });
  assert.equal(slots.length, 2);
  assert.equal(slots[0].endsAt.toISOString(), "2026-11-18T09:00:00.000Z");
  assert.ok(slots.every((s) => s.available));
});

test("24:00 end time is supported", () => {
  const slots = computeSlots({ ...base, date: "2026-11-18", availability: [{ weekday: 3, startTime: "22:00", endTime: "24:00" }] });
  assert.deepEqual(slots.map(iso), ["2026-11-18T22:00:00.000Z", "2026-11-18T23:00:00.000Z"]);
});

test("multiple rows are merged, de-duplicated and sorted", () => {
  const availability = [
    { weekday: 3, startTime: "14:00", endTime: "16:00" },
    { weekday: 3, startTime: "08:00", endTime: "10:00" },
    { weekday: 3, startTime: "09:00", endTime: "11:00" },
  ];
  const slots = computeSlots({ ...base, date: "2026-11-18", availability });
  assert.deepEqual(slots.map(iso), ["08:00", "09:00", "10:00", "14:00", "15:00"].map((t) => `2026-11-18T${t}:00.000Z`));
});

test("slots at or before now are removed", () => {
  const availability = [{ weekday: 2, startTime: "08:00", endTime: "13:00" }];
  const slots = computeSlots({ ...base, date: "2026-11-17", availability });
  assert.deepEqual(slots.map(iso), ["11:00", "12:00"].map((t) => `2026-11-17T${t}:00.000Z`)); // 10:00 == now is dropped
});

test("booked slots are unavailable; cancelled bookings free the slot", () => {
  const availability = [{ weekday: 3, startTime: "08:00", endTime: "11:00" }];
  const bookings = [
    { startsAt: new Date("2026-11-18T08:00:00Z"), status: "confirmed" },
    { startsAt: new Date("2026-11-18T09:00:00Z"), status: "cancelled" },
    { startsAt: new Date("2026-11-18T10:00:00Z"), status: "completed" },
  ];
  const slots = computeSlots({ now: T0, date: "2026-11-18", availability, bookings });
  assert.deepEqual(slots.map((s) => s.available), [false, true, false]);
});

test("date validation: format, calendar, past, beyond horizon", () => {
  const availability = [];
  for (const date of ["2026-1-1", "nope", undefined, "2026-02-30", "2026-11-16", "2027-02-01"]) {
    assert.throws(() => computeSlots({ ...base, date, availability }), (e) => e.status === 400 && e.code === "VALIDATION", String(date));
  }
  assert.doesNotThrow(() => computeSlots({ ...base, date: "2026-11-17", availability }));
  assert.doesNotThrow(() => computeSlots({ ...base, date: "2027-01-16", availability })); // today + 60d
  assert.throws(() => computeSlots({ ...base, date: "2027-01-17", availability }), (e) => e.status === 400);
});

test("getSlots reads availability and active bookings from the stores", async () => {
  const env = makeEnv();
  const { provider } = await env.seedProvider();
  const consumer = await env.seedUser();
  await env.stores.bookings.insert({
    consumerId: consumer.id, providerId: provider.id, startsAt: new Date("2026-11-17T11:00:00Z"),
    durationMin: 60, priceCredits: 10, meetingUrl: "https://meet.jit.si/vitalis-x",
  });
  const res = await getSlots(env.deps, { providerId: provider.id, date: "2026-11-17" });
  assert.equal(res.timezone, "UTC");
  assert.deepEqual(res.slots.map((s) => [s.startsAt.toISOString().slice(11, 16), s.available]), [["11:00", false]]);
});

test("getSlots: unknown or unapproved provider is 404", async () => {
  const env = makeEnv();
  const { provider } = await env.seedProvider({ status: "pending" });
  for (const providerId of [provider.id, 9999]) {
    await assert.rejects(getSlots(env.deps, { providerId, date: "2026-11-17" }), (e) => e.status === 404);
  }
});

test("meeting urls are jitsi links with random suffix", () => {
  const a = makeMeetingUrl();
  assert.match(a, /^https:\/\/meet\.jit\.si\/vitalis-[0-9a-f]{18}$/);
  assert.notEqual(a, makeMeetingUrl());
});

test("payoutFor floors", () => {
  assert.equal(payoutFor(10, 20), 8);
  assert.equal(payoutFor(7, 20), 5); // 5.6 -> 5
  assert.equal(payoutFor(1, 20), 0);
  assert.equal(payoutFor(10, 10), 9);
  assert.equal(payoutFor(10, 0), 10);
  assert.equal(payoutFor(10, 100), 0);
});
