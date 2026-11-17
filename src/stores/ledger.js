import { HttpError } from "../middleware.js";
import { nextId } from "./memory.js";

const COLS = `id, user_id, delta, reason, booking_id, balance_after, ref, note, created_by, created_at`;

function mapRow(r) {
  return {
    id: r.id,
    userId: r.user_id,
    delta: r.delta,
    reason: r.reason,
    bookingId: r.booking_id,
    balanceAfter: r.balance_after,
    ref: r.ref,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export function clampPaging({ limit, offset } = {}) {
  const l = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
  const o = Number.isInteger(offset) && offset > 0 ? offset : 0;
  return { limit: l, offset: o };
}

export function pgLedgerRepo(q) {
  return {
    async getBalance(userId) {
      const { rows } = await q.query(
        `SELECT balance_after FROM credit_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
        [userId],
      );
      return rows.length ? rows[0].balance_after : 0;
    },
    async insert({ userId, delta, reason, bookingId = null, balanceAfter, ref = null, note = null, createdBy = null }) {
      try {
        const { rows } = await q.query(
          `INSERT INTO credit_ledger (user_id, delta, reason, booking_id, balance_after, ref, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`,
          [userId, delta, reason, bookingId, balanceAfter, ref, note, createdBy],
        );
        return mapRow(rows[0]);
      } catch (err) {
        if (err && err.code === "23505") throw new HttpError(409, "DUPLICATE_ENTRY");
        throw err;
      }
    },
    async findByRef(ref) {
      const { rows } = await q.query(`SELECT ${COLS} FROM credit_ledger WHERE ref = $1`, [ref]);
      return rows.length ? mapRow(rows[0]) : null;
    },
    async list({ userId, reason, limit, offset } = {}) {
      const p = clampPaging({ limit, offset });
      const where = [];
      const params = [];
      if (userId != null) { params.push(userId); where.push(`user_id = $${params.length}`); }
      if (reason != null) { params.push(reason); where.push(`reason = $${params.length}`); }
      const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = await q.query(`SELECT count(*)::int AS n FROM credit_ledger ${w}`, params);
      const { rows } = await q.query(
        `SELECT ${COLS} FROM credit_ledger ${w} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, p.limit, p.offset],
      );
      return { items: rows.map(mapRow), total: total.rows[0].n };
    },
  };
}

export function memLedgerRepo(state) {
  return {
    async getBalance(userId) {
      for (let i = state.ledger.length - 1; i >= 0; i--) {
        if (state.ledger[i].userId === userId) return state.ledger[i].balanceAfter;
      }
      return 0;
    },
    async insert({ userId, delta, reason, bookingId = null, balanceAfter, ref = null, note = null, createdBy = null }) {
      if (ref != null && state.ledger.some((e) => e.ref === ref)) throw new HttpError(409, "DUPLICATE_ENTRY");
      if (bookingId != null && state.ledger.some((e) => e.bookingId === bookingId && e.reason === reason)) {
        throw new HttpError(409, "DUPLICATE_ENTRY");
      }
      const entry = {
        id: nextId(state, "ledger"),
        userId, delta, reason, bookingId, balanceAfter, ref, note, createdBy,
        createdAt: new Date(),
      };
      state.ledger.push(entry);
      return { ...entry };
    },
    async findByRef(ref) {
      const e = state.ledger.find((x) => x.ref === ref);
      return e ? { ...e } : null;
    },
    async list({ userId, reason, limit, offset } = {}) {
      const p = clampPaging({ limit, offset });
      const all = state.ledger
        .filter((e) => (userId == null || e.userId === userId) && (reason == null || e.reason === reason))
        .sort((a, b) => b.id - a.id);
      return { items: all.slice(p.offset, p.offset + p.limit).map((e) => ({ ...e })), total: all.length };
    },
  };
}
