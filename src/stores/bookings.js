import { HttpError } from "../middleware.js";
import { nextId } from "./memory.js";
import { clampPaging } from "./ledger.js";

const SELECT = `SELECT b.id, b.consumer_id, cu.name AS consumer_name, b.provider_id, pu.name AS provider_name,
  p.kind AS provider_kind, b.starts_at, b.duration_min, b.price_credits, b.status, b.meeting_url,
  b.payout_credits, b.cancelled_at, b.completed_at, b.created_at
  FROM bookings b
  JOIN users cu ON cu.id = b.consumer_id
  JOIN providers p ON p.id = b.provider_id
  JOIN users pu ON pu.id = p.user_id`;

function mapRow(r) {
  return {
    id: r.id,
    consumerId: r.consumer_id,
    consumerName: r.consumer_name,
    providerId: r.provider_id,
    providerName: r.provider_name,
    providerKind: r.provider_kind,
    startsAt: r.starts_at,
    durationMin: r.duration_min,
    priceCredits: r.price_credits,
    status: r.status,
    meetingUrl: r.meeting_url,
    payoutCredits: r.payout_credits,
    cancelledAt: r.cancelled_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
  };
}

const UPDATE_COLS = { status: "status", cancelledAt: "cancelled_at", completedAt: "completed_at", payoutCredits: "payout_credits" };

export function pgBookingsRepo(q) {
  const one = async (id, lock) => {
    const { rows } = await q.query(`${SELECT} WHERE b.id = $1${lock ? " FOR UPDATE OF b" : ""}`, [id]);
    return rows.length ? mapRow(rows[0]) : null;
  };
  return {
    async insert({ consumerId, providerId, startsAt, durationMin = 60, priceCredits, meetingUrl }) {
      let id;
      try {
        const { rows } = await q.query(
          `INSERT INTO bookings (consumer_id, provider_id, starts_at, duration_min, price_credits, meeting_url)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [consumerId, providerId, startsAt, durationMin, priceCredits, meetingUrl],
        );
        id = rows[0].id;
      } catch (err) {
        if (err && err.code === "23505") throw new HttpError(409, "SLOT_TAKEN");
        throw err;
      }
      return one(id, false);
    },
    findById: (id) => one(id, false),
    lockById: (id) => one(id, true),
    async update(id, patch) {
      const sets = [];
      const params = [id];
      for (const [key, col] of Object.entries(UPDATE_COLS)) {
        if (patch[key] !== undefined) { params.push(patch[key]); sets.push(`${col} = $${params.length}`); }
      }
      if (sets.length) await q.query(`UPDATE bookings SET ${sets.join(", ")} WHERE id = $1`, params);
      return one(id, false);
    },
    async listActiveForProvider(providerId, from, to) {
      const { rows } = await q.query(
        `${SELECT} WHERE b.provider_id = $1 AND b.status <> 'cancelled' AND b.starts_at >= $2 AND b.starts_at < $3
         ORDER BY b.starts_at`,
        [providerId, from, to],
      );
      return rows.map(mapRow);
    },
    async list({ consumerId, providerId, status, startsFrom, startsBefore, order = "asc", limit, offset } = {}) {
      const p = clampPaging({ limit, offset });
      const where = [];
      const params = [];
      const add = (cond, v) => { params.push(v); where.push(cond.replace("?", `$${params.length}`)); };
      if (consumerId != null) add("b.consumer_id = ?", consumerId);
      if (providerId != null) add("b.provider_id = ?", providerId);
      if (status != null) add("b.status = ?", status);
      if (startsFrom != null) add("b.starts_at >= ?", startsFrom);
      if (startsBefore != null) add("b.starts_at < ?", startsBefore);
      const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = await q.query(`SELECT count(*)::int AS n FROM bookings b ${w}`, params);
      const dir = order === "desc" ? "DESC" : "ASC";
      const { rows } = await q.query(
        `${SELECT} ${w} ORDER BY b.starts_at ${dir}, b.id ${dir} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, p.limit, p.offset],
      );
      return { items: rows.map(mapRow), total: total.rows[0].n };
    },
  };
}

export function memBookingsRepo(state) {
  const decorate = (b) => {
    const consumer = state.users.find((u) => u.id === b.consumerId);
    const provider = state.providers.find((x) => x.id === b.providerId);
    const providerUser = provider && state.users.find((u) => u.id === provider.userId);
    return {
      ...b,
      consumerName: consumer ? consumer.name : null,
      providerName: providerUser ? providerUser.name : (provider?.name ?? null),
      providerKind: provider ? provider.kind : null,
    };
  };
  const find = (id) => state.bookings.find((b) => b.id === id);
  return {
    async insert({ consumerId, providerId, startsAt, durationMin = 60, priceCredits, meetingUrl }) {
      const t = new Date(startsAt).getTime();
      if (state.bookings.some((b) => b.providerId === providerId && b.status !== "cancelled" && b.startsAt.getTime() === t)) {
        throw new HttpError(409, "SLOT_TAKEN");
      }
      const row = {
        id: nextId(state, "bookings"),
        consumerId, providerId, startsAt: new Date(t), durationMin, priceCredits,
        status: "confirmed", meetingUrl, payoutCredits: null, cancelledAt: null, completedAt: null,
        createdAt: new Date(),
      };
      state.bookings.push(row);
      return decorate(row);
    },
    async findById(id) {
      const b = find(id);
      return b ? decorate(b) : null;
    },
    async lockById(id) {
      const b = find(id);
      return b ? decorate(b) : null;
    },
    async update(id, patch) {
      const b = find(id);
      if (!b) return null;
      for (const key of Object.keys(UPDATE_COLS)) {
        if (patch[key] !== undefined) b[key] = patch[key];
      }
      return decorate(b);
    },
    async listActiveForProvider(providerId, from, to) {
      return state.bookings
        .filter((b) => b.providerId === providerId && b.status !== "cancelled" && b.startsAt >= from && b.startsAt < to)
        .sort((a, b) => a.startsAt - b.startsAt)
        .map(decorate);
    },
    async list({ consumerId, providerId, status, startsFrom, startsBefore, order = "asc", limit, offset } = {}) {
      const p = clampPaging({ limit, offset });
      const dir = order === "desc" ? -1 : 1;
      const all = state.bookings
        .filter((b) =>
          (consumerId == null || b.consumerId === consumerId) &&
          (providerId == null || b.providerId === providerId) &&
          (status == null || b.status === status) &&
          (startsFrom == null || b.startsAt >= startsFrom) &&
          (startsBefore == null || b.startsAt < startsBefore))
        .sort((a, b) => dir * (a.startsAt - b.startsAt || a.id - b.id));
      return { items: all.slice(p.offset, p.offset + p.limit).map(decorate), total: all.length };
    },
  };
}
