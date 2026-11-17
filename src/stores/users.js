import { HttpError } from "../middleware.js";
import { nextId, pageOf, pageParams } from "./memory.js";

const COLS = "id, email, name, role, created_at";

function mapUser(r) {
  return { id: r.id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at };
}

export function pgUsersRepo(q) {
  return {
    async create({ email, passwordHash, name, role = "consumer" }) {
      try {
        const { rows } = await q.query(
          `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING ${COLS}`,
          [email, passwordHash, name, role],
        );
        return mapUser(rows[0]);
      } catch (err) {
        if (err.code === "23505") throw new HttpError(409, "EMAIL_TAKEN", "Email already registered");
        throw err;
      }
    },
    async findByEmail(email) {
      const { rows } = await q.query(`SELECT ${COLS}, password_hash FROM users WHERE email = $1`, [email]);
      return rows[0] ? { ...mapUser(rows[0]), passwordHash: rows[0].password_hash } : null;
    },
    async findById(id) {
      const { rows } = await q.query(`SELECT ${COLS} FROM users WHERE id = $1`, [id]);
      return rows[0] ? mapUser(rows[0]) : null;
    },
    async lockById(id) {
      const { rows } = await q.query(`SELECT ${COLS} FROM users WHERE id = $1 FOR UPDATE`, [id]);
      return rows[0] ? mapUser(rows[0]) : null;
    },
    async setRole(id, role) {
      const { rows } = await q.query(`UPDATE users SET role = $2 WHERE id = $1 RETURNING ${COLS}`, [id, role]);
      return rows[0] ? mapUser(rows[0]) : null;
    },
    async list({ role, q: search, limit, offset } = {}) {
      const where = [];
      const params = [];
      if (role) {
        params.push(role);
        where.push(`u.role = $${params.length}`);
      }
      if (search) {
        params.push(`%${String(search).replace(/[\\%_]/g, "\\$&")}%`);
        where.push(`(u.email ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const page = pageParams({ limit, offset });
      const total = await q.query(`SELECT count(*)::int AS n FROM users u ${clause}`, params);
      const { rows } = await q.query(
        `SELECT u.id, u.email, u.name, u.role, u.created_at,
           COALESCE((SELECT l.balance_after FROM credit_ledger l WHERE l.user_id = u.id ORDER BY l.id DESC LIMIT 1), 0) AS balance
         FROM users u ${clause} ORDER BY u.id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, page.limit, page.offset],
      );
      return { items: rows.map((r) => ({ ...mapUser(r), balance: r.balance })), total: total.rows[0].n };
    },
  };
}

function publicUser({ passwordHash: _omit, ...user }) {
  return user;
}

export function memUsersRepo(state) {
  return {
    async create({ email, passwordHash, name, role = "consumer" }) {
      if (state.users.some((u) => u.email === email)) {
        throw new HttpError(409, "EMAIL_TAKEN", "Email already registered");
      }
      const row = { id: nextId(state, "users"), email, name, role, createdAt: new Date(), passwordHash };
      state.users.push(row);
      return publicUser(row);
    },
    async findByEmail(email) {
      const row = state.users.find((u) => u.email === email);
      return row ? { ...row } : null;
    },
    async findById(id) {
      const row = state.users.find((u) => u.id === id);
      return row ? publicUser(row) : null;
    },
    async lockById(id) {
      const row = state.users.find((u) => u.id === id);
      return row ? publicUser(row) : null;
    },
    async setRole(id, role) {
      const row = state.users.find((u) => u.id === id);
      if (!row) return null;
      row.role = role;
      return publicUser(row);
    },
    async list({ role, q: search, limit, offset } = {}) {
      const needle = search ? String(search).toLowerCase() : null;
      const rows = state.users
        .filter((u) => (!role || u.role === role))
        .filter((u) => !needle || u.email.toLowerCase().includes(needle) || u.name.toLowerCase().includes(needle))
        .map((u) => {
          const entries = state.ledger.filter((e) => e.userId === u.id);
          const balance = entries.length ? entries[entries.length - 1].balanceAfter : 0;
          return { ...publicUser(u), balance };
        });
      return pageOf(rows, { limit, offset });
    },
  };
}
