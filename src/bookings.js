import { randomBytes } from "node:crypto";
import { HttpError } from "./middleware.js";
import { applyLedgerEntry } from "./credits.js";

const DAY_MS = 86400000;
const MIN_MS = 60000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function makeMeetingUrl() {
  return `https://meet.jit.si/vitalis-${randomBytes(9).toString("hex")}`;
}

export function payoutFor(priceCredits, feePct) {
  return Math.floor((priceCredits * (100 - feePct)) / 100);
}

function parseDateStrict(date) {
  const m = typeof date === "string" ? DATE_RE.exec(date) : null;
  if (!m) throw new HttpError(400, "VALIDATION", "date must be YYYY-MM-DD", { field: "date" });
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, "VALIDATION", "date is not a valid calendar date", { field: "date" });
  }
  return t;
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Pure. `date` is a UTC calendar day. Returns [{startsAt: Date, endsAt: Date, available}] ascending.
export function computeSlots({ date, availability, bookings, now, slotMinutes = 60, horizonDays = 60 }) {
  const dayStart = parseDateStrict(date);
  const nowMs = now.getTime();
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  if (dayStart < today || dayStart > today + horizonDays * DAY_MS) {
    throw new HttpError(400, "VALIDATION", `date must be between today and ${horizonDays} days ahead`, { field: "date" });
  }
  const weekday = new Date(dayStart).getUTCDay();
  const starts = new Set();
  for (const row of availability) {
    if (row.weekday !== weekday) continue;
    const end = minutesOf(row.endTime);
    for (let t = minutesOf(row.startTime); t + slotMinutes <= end; t += slotMinutes) {
      starts.add(dayStart + t * MIN_MS);
    }
  }
  const booked = new Set(
    bookings.filter((b) => b.status !== "cancelled").map((b) => new Date(b.startsAt).getTime()),
  );
  return [...starts]
    .sort((a, b) => a - b)
    .filter((s) => s > nowMs)
    .map((s) => ({
      startsAt: new Date(s),
      endsAt: new Date(s + slotMinutes * MIN_MS),
      available: !booked.has(s),
    }));
}

async function loadApprovedProvider(stores, providerId) {
  const provider = Number.isInteger(providerId) ? await stores.providers.findById(providerId) : null;
  if (!provider || provider.status !== "approved") throw new HttpError(404, "NOT_FOUND", "Provider not found");
  return provider;
}

export async function getSlots(deps, { providerId, date }) {
  const { stores, config, now } = deps;
  const dayStart = parseDateStrict(date);
  const provider = await loadApprovedProvider(stores, providerId);
  const availability = await stores.availability.listByProvider(provider.id);
  const bookings = await stores.bookings.listActiveForProvider(provider.id, new Date(dayStart), new Date(dayStart + DAY_MS));
  const slots = computeSlots({
    date, availability, bookings, now: now(),
    slotMinutes: config.slotMinutes, horizonDays: config.bookingHorizonDays,
  });
  return { date, timezone: "UTC", slots };
}

export async function createBooking(deps, { consumer, providerId, startsAt }) {
  const { stores } = deps;
  if (!consumer) throw new HttpError(401, "UNAUTHENTICATED", "Login required");
  if (consumer.role === "admin") throw new HttpError(403, "FORBIDDEN", "Admins cannot book sessions");
  if (!Number.isInteger(providerId) || providerId < 1) throw new HttpError(400, "VALIDATION", "providerId must be a positive integer", { field: "providerId" });
  const start = startsAt instanceof Date ? startsAt : typeof startsAt === "string" ? new Date(startsAt) : null;
  if (!start || Number.isNaN(start.getTime())) throw new HttpError(400, "VALIDATION", "startsAt must be an ISO-8601 timestamp", { field: "startsAt" });

  const provider = await loadApprovedProvider(stores, providerId);
  if (provider.userId === consumer.id) throw new HttpError(422, "SELF_BOOKING", "You cannot book your own session");

  const date = start.toISOString().slice(0, 10);
  let slots;
  try {
    ({ slots } = await getSlots(deps, { providerId, date }));
  } catch (err) {
    if (err instanceof HttpError && err.code === "VALIDATION") throw new HttpError(422, "SLOT_UNAVAILABLE", "Slot is not available");
    throw err;
  }
  const slot = slots.find((s) => s.startsAt.getTime() === start.getTime());
  if (!slot) throw new HttpError(422, "SLOT_UNAVAILABLE", "Slot is not available");
  if (!slot.available) throw new HttpError(409, "SLOT_TAKEN", "Slot is already booked");

  return stores.tx(async (tx) => {
    await tx.users.lockById(consumer.id);
    const current = await tx.providers.findById(providerId);
    if (!current || current.status !== "approved") throw new HttpError(404, "NOT_FOUND", "Provider not found");
    const price = current.priceCredits;
    if ((await tx.ledger.getBalance(consumer.id)) < price) {
      throw new HttpError(402, "INSUFFICIENT_CREDITS", "Insufficient credits");
    }
    const booking = await tx.bookings.insert({
      consumerId: consumer.id, providerId, startsAt: start, durationMin: 60,
      priceCredits: price, meetingUrl: makeMeetingUrl(),
    });
    const entry = await applyLedgerEntry(tx, {
      userId: consumer.id, delta: -price, reason: "booking", bookingId: booking.id,
    });
    return { booking, balance: entry.balanceAfter };
  });
}

// Returns {booking, provider} if actor may see the booking; throws 404/403 otherwise.
async function authorize(stores, booking, actor) {
  if (!booking) throw new HttpError(404, "NOT_FOUND", "Booking not found");
  const provider = await stores.providers.findById(booking.providerId);
  const isConsumer = booking.consumerId === actor.id;
  const isProvider = !!provider && provider.userId === actor.id;
  const isAdmin = actor.role === "admin";
  if (!isConsumer && !isProvider && !isAdmin) throw new HttpError(403, "FORBIDDEN", "Not allowed");
  return { provider, isConsumer, isProvider, isAdmin };
}

export async function getBooking(deps, { bookingId, actor }) {
  const booking = await deps.stores.bookings.findById(bookingId);
  await authorize(deps.stores, booking, actor);
  return booking;
}

export async function cancelBooking(deps, { bookingId, actor }) {
  const { config, now } = deps;
  return deps.stores.tx(async (tx) => {
    const booking = await tx.bookings.lockById(bookingId);
    const who = await authorize(tx, booking, actor);
    const at = now();
    if (booking.status !== "confirmed" || at.getTime() >= booking.startsAt.getTime()) {
      throw new HttpError(409, "CANCEL_NOT_ALLOWED", "This booking can no longer be cancelled");
    }
    const lateConsumer = who.isConsumer && !who.isProvider && !who.isAdmin &&
      booking.startsAt.getTime() - at.getTime() < config.cancelWindowHours * 3600000;
    const refundCredits = lateConsumer ? 0 : booking.priceCredits;
    const updated = await tx.bookings.update(bookingId, { status: "cancelled", cancelledAt: at });
    if (refundCredits > 0) {
      await applyLedgerEntry(tx, {
        userId: booking.consumerId, delta: refundCredits, reason: "refund", bookingId,
      });
    }
    return { booking: updated, refundCredits };
  });
}

export async function completeBooking(deps, { bookingId, actor }) {
  const { config, now } = deps;
  return deps.stores.tx(async (tx) => {
    const booking = await tx.bookings.lockById(bookingId);
    const who = await authorize(tx, booking, actor);
    if (!who.isProvider && !who.isAdmin) throw new HttpError(403, "FORBIDDEN", "Only the provider or an admin can complete a booking");
    const at = now();
    const endMs = booking.startsAt.getTime() + booking.durationMin * MIN_MS;
    if (booking.status !== "confirmed" || at.getTime() < endMs) {
      throw new HttpError(409, "NOT_COMPLETABLE", "This booking cannot be completed");
    }
    const payoutCredits = payoutFor(booking.priceCredits, config.platformFeePct);
    const updated = await tx.bookings.update(bookingId, { status: "completed", completedAt: at, payoutCredits });
    if (payoutCredits > 0) {
      await applyLedgerEntry(tx, {
        userId: who.provider.userId, delta: payoutCredits, reason: "payout", bookingId,
      });
    }
    return { booking: updated, payoutCredits };
  });
}

const STATUSES = ["confirmed", "cancelled", "completed"];

export async function listBookings(deps, { actor, as = "consumer", scope = "all", status, limit, offset }) {
  const { stores, now } = deps;
  if (!["consumer", "provider"].includes(as)) throw new HttpError(400, "VALIDATION", "as must be consumer or provider", { field: "as" });
  if (!["upcoming", "past", "all"].includes(scope)) throw new HttpError(400, "VALIDATION", "scope must be upcoming, past or all", { field: "scope" });
  if (status !== undefined && !STATUSES.includes(status)) throw new HttpError(400, "VALIDATION", "invalid status", { field: "status" });
  const filter = { limit, offset, order: "desc" };
  if (as === "provider") {
    const provider = await stores.providers.findByUserId(actor.id);
    if (!provider) throw new HttpError(403, "FORBIDDEN", "You are not a provider");
    filter.providerId = provider.id;
  } else {
    filter.consumerId = actor.id;
  }
  if (scope === "upcoming") {
    filter.startsFrom = now();
    filter.order = "asc";
    filter.status = status ?? "confirmed";
  } else {
    if (scope === "past") filter.startsBefore = now();
    if (status) filter.status = status;
  }
  return stores.bookings.list(filter);
}
