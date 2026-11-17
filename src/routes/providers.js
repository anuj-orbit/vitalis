import express from "express";
import { HttpError, asyncHandler, requireAuth } from "../middleware.js";

const KINDS = ["yoga", "fitness", "doctor"];
const PROFILE_FIELDS = ["specialty", "bio", "credentials", "licenseNo", "priceCredits"];

const bad = (field, message) => new HttpError(400, "VALIDATION", message, { field });

export function parsePaging(query) {
  const out = {};
  for (const key of ["limit", "offset"]) {
    if (query[key] === undefined) continue;
    if (!/^\d+$/.test(String(query[key]))) throw bad(key, `${key} must be a non-negative integer`);
    out[key] = Number(query[key]);
  }
  if (out.limit !== undefined && (out.limit < 1 || out.limit > 100)) throw bad("limit", "limit must be 1-100");
  return out;
}

export function parseId(value) {
  if (!/^\d{1,9}$/.test(String(value))) throw new HttpError(404, "NOT_FOUND", "Not found");
  return Number(value);
}

function str(value, field, { min = 0, max }) {
  if (typeof value !== "string") throw bad(field, `${field} must be a string`);
  const v = value.trim();
  if (v.length < min || v.length > max) {
    throw bad(field, `${field} must be ${min ? `${min}-` : "at most "}${max} chars`);
  }
  return v;
}

const validators = {
  specialty: (v) => str(v, "specialty", { min: 1, max: 80 }),
  bio: (v) => str(v, "bio", { max: 2000 }),
  credentials: (v) => str(v, "credentials", { min: 1, max: 2000 }),
  licenseNo: (v) => (v === null || v === "" ? null : str(v, "licenseNo", { max: 80 }) || null),
  priceCredits: (v) => {
    if (!Number.isInteger(v) || v < 1 || v > 1000) throw bad("priceCredits", "priceCredits must be an integer 1-1000");
    return v;
  },
};

const HOUR = /^(\d{2}):00$/;

export function parseAvailability(input) {
  if (!Array.isArray(input) || input.length > 28) throw bad("availability", "availability must be an array of at most 28 rows");
  const rows = input.map((r, i) => {
    const field = `availability[${i}]`;
    if (!r || typeof r !== "object") throw bad(field, "row must be an object");
    if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6) throw bad(field, "weekday must be 0-6");
    const s = HOUR.exec(r.startTime ?? "");
    const e = HOUR.exec(r.endTime ?? "");
    if (!s || !e) throw bad(field, "startTime and endTime must be HH:00");
    const start = Number(s[1]);
    const end = Number(e[1]);
    if (start > 23 || end < 1 || end > 24 || start >= end) throw bad(field, "startTime must be before endTime (00:00-24:00)");
    return { weekday: r.weekday, startTime: r.startTime, endTime: r.endTime, start, end };
  });
  const sorted = [...rows].sort((a, b) => a.weekday - b.weekday || a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].weekday === sorted[i - 1].weekday && sorted[i].start < sorted[i - 1].end) {
      throw bad("availability", "availability rows must not overlap");
    }
  }
  return sorted.map(({ weekday, startTime, endTime }) => ({ weekday, startTime, endTime }));
}

function publicProvider({ email: _email, ...rest }) {
  return rest;
}

export function providersRouter({ stores }) {
  const router = express.Router();
  const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const { kind, specialty, q } = req.query;
      if (kind !== undefined && !KINDS.includes(kind)) throw bad("kind", "kind must be yoga, fitness or doctor");
      for (const [k, v] of Object.entries({ specialty, q })) {
        if (v !== undefined && (typeof v !== "string" || v.length > 100)) throw bad(k, `${k} must be a string of at most 100 chars`);
      }
      const { items, total } = await stores.providers.list({
        status: "approved",
        kind,
        specialty,
        q,
        ...parsePaging(req.query),
      });
      res.json({ items: items.map(publicProvider), total });
    }),
  );

  router.get(
    "/me",
    requireAuth,
    asyncHandler(async (req, res) => {
      const provider = await stores.providers.findByUserId(req.user.id);
      res.json({
        provider,
        availability: provider ? await stores.availability.listByProvider(provider.id) : [],
      });
    }),
  );

  router.post(
    "/apply",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (req.user.role === "admin") throw new HttpError(403, "FORBIDDEN", "Admins cannot apply as providers");
      const input = body(req);
      if (!KINDS.includes(input.kind)) throw bad("kind", "kind must be yoga, fitness or doctor");
      const data = {
        kind: input.kind,
        specialty: validators.specialty(input.specialty),
        bio: input.bio === undefined ? "" : validators.bio(input.bio),
        credentials: validators.credentials(input.credentials),
        licenseNo: input.licenseNo === undefined ? null : validators.licenseNo(input.licenseNo),
        priceCredits: validators.priceCredits(input.priceCredits),
      };
      if (data.kind === "doctor" && !data.licenseNo) throw bad("licenseNo", "licenseNo is required for doctors");
      const existing = await stores.providers.findByUserId(req.user.id);
      if (existing) {
        if (existing.status !== "rejected") throw new HttpError(409, "ALREADY_APPLIED", "You have already applied");
        const provider = await stores.providers.update(existing.id, { ...data, status: "pending", reviewNote: null });
        return res.status(200).json({ provider });
      }
      const provider = await stores.providers.create({ userId: req.user.id, ...data });
      res.status(201).json({ provider });
    }),
  );

  const requireProvider = asyncHandler(async (req, _res, next) => {
    if (!req.user) throw new HttpError(401, "UNAUTHENTICATED", "Login required");
    req.provider = await stores.providers.findByUserId(req.user.id);
    if (!req.provider) throw new HttpError(404, "NOT_FOUND", "No provider profile");
    next();
  });

  router.put(
    "/me",
    requireProvider,
    asyncHandler(async (req, res) => {
      const input = body(req);
      const patch = {};
      for (const field of PROFILE_FIELDS) if (input[field] !== undefined) patch[field] = validators[field](input[field]);
      const licenseNo = "licenseNo" in patch ? patch.licenseNo : req.provider.licenseNo;
      if (req.provider.kind === "doctor" && !licenseNo) throw bad("licenseNo", "licenseNo is required for doctors");
      const provider = await stores.providers.update(req.provider.id, patch);
      res.json({ provider });
    }),
  );

  router.put(
    "/me/availability",
    requireProvider,
    asyncHandler(async (req, res) => {
      const rows = parseAvailability(body(req).availability);
      const availability = await stores.tx(async (tx) => tx.availability.replaceForProvider(req.provider.id, rows));
      res.json({ availability });
    }),
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const provider = await stores.providers.findById(parseId(req.params.id));
      if (!provider || provider.status !== "approved") throw new HttpError(404, "NOT_FOUND", "Provider not found");
      res.json({
        provider: publicProvider(provider),
        availability: await stores.availability.listByProvider(provider.id),
      });
    }),
  );

  return router;
}
