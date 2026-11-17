import { HttpError } from "../middleware.js";
import { nextId, pageOf, pageParams } from "./memory.js";

const SELECT = `SELECT p.id, p.user_id, u.name, u.email, p.kind, p.specialty, p.bio, p.credentials, p.license_no,
  p.price_credits, p.status, p.review_note, p.created_at
  FROM providers p JOIN users u ON u.id = p.user_id`;

function mapProvider(r) {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    email: r.email,
    kind: r.kind,
    specialty: r.specialty,
    bio: r.bio,
    credentials: r.credentials,
    licenseNo: r.license_no,
    priceCredits: r.price_credits,
    status: r.status,
    reviewNote: r.review_note,
    createdAt: r.created_at,
  };
}

const PATCH_COLUMNS = {
  specialty: "specialty",
  bio: "bio",
  credentials: "credentials",
  licenseNo: "license_no",
  priceCredits: "price_credits",
  kind: "kind",
  status: "status",
  reviewNote: "review_note",
};

const escapeLike = (s) => `%${String(s).replace(/[\\%_]/g, "\\$&")}%`;

export function pgProvidersRepo(q) {
  const one = async (where, param) => {
    const { rows } = await q.query(`${SELECT} WHERE ${where}`, [param]);
    return rows[0] ? mapProvider(rows[0]) : null;
  };
  return {
    async create({ userId, kind, specialty, bio, credentials, licenseNo, priceCredits }) {
      let id;
      try {
        const { rows } = await q.query(
          `INSERT INTO providers (user_id, kind, specialty, bio, credentials, license_no, price_credits)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [userId, kind, specialty, bio ?? "", credentials, licenseNo ?? null, priceCredits],
        );
        id = rows[0].id;
      } catch (err) {
        if (err.code === "23505") throw new HttpError(409, "ALREADY_APPLIED", "Provider application already exists");
        throw err;
      }
      return one("p.id = $1", id);
    },
    findById: (id) => one("p.id = $1", id),
    findByUserId: (userId) => one("p.user_id = $1", userId),
    async update(id, patch) {
      const sets = [];
      const params = [id];
      for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
        if (patch[key] !== undefined) {
          params.push(patch[key]);
          sets.push(`${column} = $${params.length}`);
        }
      }
      if (sets.length) await q.query(`UPDATE providers SET ${sets.join(", ")} WHERE id = $1`, params);
      return one("p.id = $1", id);
    },
    async list({ status, kind, specialty, q: search, limit, offset } = {}) {
      const where = [];
      const params = [];
      const add = (sql, value) => {
        params.push(value);
        where.push(sql.replaceAll("$$", `$${params.length}`));
      };
      if (status) add("p.status = $$", status);
      if (kind) add("p.kind = $$", kind);
      if (specialty) add("lower(p.specialty) = lower($$)", specialty);
      if (search) add("(u.name ILIKE $$ OR p.specialty ILIKE $$ OR p.bio ILIKE $$)", escapeLike(search));
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const page = pageParams({ limit, offset });
      const total = await q.query(
        `SELECT count(*)::int AS n FROM providers p JOIN users u ON u.id = p.user_id ${clause}`,
        params,
      );
      const { rows } = await q.query(
        `${SELECT} ${clause} ORDER BY p.id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, page.limit, page.offset],
      );
      return { items: rows.map(mapProvider), total: total.rows[0].n };
    },
  };
}

export function memProvidersRepo(state) {
  const view = (row) => {
    const user = state.users.find((u) => u.id === row.userId);
    return { ...row, name: user.name, email: user.email };
  };
  return {
    async create({ userId, kind, specialty, bio, credentials, licenseNo, priceCredits }) {
      if (state.providers.some((p) => p.userId === userId)) {
        throw new HttpError(409, "ALREADY_APPLIED", "Provider application already exists");
      }
      const row = {
        id: nextId(state, "providers"),
        userId,
        kind,
        specialty,
        bio: bio ?? "",
        credentials,
        licenseNo: licenseNo ?? null,
        priceCredits,
        status: "pending",
        reviewNote: null,
        createdAt: new Date(),
      };
      state.providers.push(row);
      return view(row);
    },
    async findById(id) {
      const row = state.providers.find((p) => p.id === id);
      return row ? view(row) : null;
    },
    async findByUserId(userId) {
      const row = state.providers.find((p) => p.userId === userId);
      return row ? view(row) : null;
    },
    async update(id, patch) {
      const row = state.providers.find((p) => p.id === id);
      if (!row) return null;
      for (const key of Object.keys(PATCH_COLUMNS)) if (patch[key] !== undefined) row[key] = patch[key];
      return view(row);
    },
    async list({ status, kind, specialty, q: search, limit, offset } = {}) {
      const needle = search ? String(search).toLowerCase() : null;
      const rows = state.providers
        .map(view)
        .filter((p) => !status || p.status === status)
        .filter((p) => !kind || p.kind === kind)
        .filter((p) => !specialty || p.specialty.toLowerCase() === String(specialty).toLowerCase())
        .filter(
          (p) =>
            !needle ||
            [p.name, p.specialty, p.bio].some((f) => f.toLowerCase().includes(needle)),
        )
        .sort((a, b) => a.id - b.id);
      return pageOf(rows, { limit, offset });
    },
  };
}
