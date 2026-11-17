import { HttpError } from "./middleware.js";

export const LEDGER_REASONS = ["topup", "booking", "refund", "payout", "adjust"];

export function packsFor(config) {
  return config.creditPacks.map((credits) => {
    const amountAed = credits * config.creditPriceAed;
    return { credits, amountAed, amountFils: amountAed * 100 };
  });
}

// Parses ?limit=&offset= from a query object. Throws 400 VALIDATION on bad input.
export function parsePaging(query = {}) {
  const out = {};
  if (query.limit !== undefined) {
    if (!/^\d+$/.test(String(query.limit)) || Number(query.limit) < 1 || Number(query.limit) > 100) {
      throw new HttpError(400, "VALIDATION", "limit must be 1-100", { field: "limit" });
    }
    out.limit = Number(query.limit);
  }
  if (query.offset !== undefined) {
    if (!/^\d+$/.test(String(query.offset)) || Number(query.offset) > 1e9) {
      throw new HttpError(400, "VALIDATION", "offset must be a non-negative integer", { field: "offset" });
    }
    out.offset = Number(query.offset);
  }
  return out;
}

// Must run inside stores.tx. Locks the user row, so concurrent entries for one user serialise
// and the balance can never go below zero.
export async function applyLedgerEntry(txStores, { userId, delta, reason, bookingId = null, ref = null, note = null, createdBy = null }) {
  if (!Number.isInteger(delta) || delta === 0) throw new HttpError(400, "VALIDATION", "delta must be a non-zero integer", { field: "delta" });
  if (!LEDGER_REASONS.includes(reason)) throw new HttpError(400, "VALIDATION", "invalid ledger reason", { field: "reason" });
  const user = await txStores.users.lockById(userId);
  if (!user) throw new HttpError(404, "NOT_FOUND", "User not found");
  const balance = await txStores.ledger.getBalance(userId);
  const next = balance + delta;
  if (next < 0) throw new HttpError(402, "INSUFFICIENT_CREDITS", "Insufficient credits");
  return txStores.ledger.insert({ userId, delta, reason, bookingId, balanceAfter: next, ref, note, createdBy });
}

export async function getBalance(deps, userId) {
  return deps.stores.ledger.getBalance(userId);
}

function gatewayRefFromNote(note) {
  const m = /gateway (\S+)$/.exec(note || "");
  return m ? m[1] : null;
}

export async function topUp(deps, { userId, pack, idempotencyKey }) {
  const { stores, config, payments } = deps;
  if (!Number.isInteger(pack) || !config.creditPacks.includes(pack)) {
    throw new HttpError(400, "VALIDATION", `pack must be one of ${config.creditPacks.join(", ")}`, { field: "pack" });
  }
  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 64) {
      throw new HttpError(400, "VALIDATION", "idempotencyKey must be 1-64 characters", { field: "idempotencyKey" });
    }
  }
  const amountAed = pack * config.creditPriceAed;
  const ref = idempotencyKey ? `topup:${userId}:${idempotencyKey}` : null;

  const replay = async (entry) => ({
    entry,
    balance: await stores.ledger.getBalance(userId),
    payment: { ref: gatewayRefFromNote(entry.note), amountAed },
    replayed: true,
  });

  if (ref) {
    const existing = await stores.ledger.findByRef(ref);
    if (existing) return replay(existing);
  }

  const payment = await payments.charge({
    userId,
    credits: pack,
    amountFils: amountAed * 100,
    currency: "AED",
    idempotencyKey: ref ?? undefined,
  });
  if (!payment || payment.status !== "succeeded") {
    throw new HttpError(402, "PAYMENT_FAILED", "Payment failed", payment?.failureReason ? { reason: payment.failureReason } : undefined);
  }

  try {
    const entry = await stores.tx((tx) =>
      applyLedgerEntry(tx, {
        userId,
        delta: pack,
        reason: "topup",
        ref: ref ?? `topup:${payment.ref}`,
        note: `pack ${pack} credits, ${amountAed} AED, gateway ${payment.ref}`,
      }));
    return { entry, balance: entry.balanceAfter, payment: { ref: payment.ref, amountAed }, replayed: false };
  } catch (err) {
    if (ref && err instanceof HttpError && err.code === "DUPLICATE_ENTRY") {
      const existing = await stores.ledger.findByRef(ref);
      if (existing) return replay(existing);
    }
    throw err;
  }
}

export async function adjustCredits(deps, { adminId, userId, delta, note }) {
  if (!Number.isInteger(userId) || userId < 1) throw new HttpError(400, "VALIDATION", "userId must be a positive integer", { field: "userId" });
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000) {
    throw new HttpError(400, "VALIDATION", "delta must be a non-zero integer, at most 100000 in magnitude", { field: "delta" });
  }
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (trimmed.length < 1 || trimmed.length > 200) throw new HttpError(400, "VALIDATION", "note must be 1-200 characters", { field: "note" });
  const entry = await deps.stores.tx((tx) =>
    applyLedgerEntry(tx, { userId, delta, reason: "adjust", note: trimmed, createdBy: adminId }));
  return { entry, balance: entry.balanceAfter };
}

export async function listLedger(deps, { userId, reason, limit, offset } = {}) {
  if (reason !== undefined && reason !== null && !LEDGER_REASONS.includes(reason)) {
    throw new HttpError(400, "VALIDATION", "invalid reason", { field: "reason" });
  }
  return deps.stores.ledger.list({ userId, reason: reason ?? undefined, limit, offset });
}
