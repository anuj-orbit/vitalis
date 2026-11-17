import { createHmac, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { HttpError } from "./middleware.js";

export const SESSION_COOKIE = "vitalis_session";

const b64url = (input) => Buffer.from(input).toString("base64url");

export function hashPassword(password, rounds) {
  return bcrypt.hash(password, rounds);
}

export function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function mac(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest();
}

export function signSession({ uid, exp }, secret) {
  const payload = b64url(JSON.stringify({ uid, exp }));
  return `${payload}.${mac(payload, secret).toString("base64url")}`;
}

export function verifySession(token, secret, nowMs) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const given = Buffer.from(sig, "base64url");
  const expected = mac(payload, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!Number.isInteger(uid) || !Number.isFinite(exp) || exp * 1000 <= nowMs) return null;
    return { uid, exp };
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export function sessionCookie(token, { secure, maxAgeSec }) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie({ secure }) {
  return sessionCookie("", { secure, maxAgeSec: 0 });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validationError(field, message) {
  return new HttpError(400, "VALIDATION", message, { field });
}

export function normalizeEmail(email) {
  if (typeof email !== "string") throw validationError("email", "email must be a string");
  const value = email.trim().toLowerCase();
  if (value.length > 254 || !EMAIL_RE.test(value)) throw validationError("email", "email is invalid");
  return value;
}

function checkPassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw validationError("password", "password must be 8-128 chars");
  }
  return password;
}

export async function register({ stores, config }, { email, password, name }) {
  const cleanEmail = normalizeEmail(email);
  checkPassword(password);
  const cleanName = typeof name === "string" ? name.trim() : "";
  if (cleanName.length < 1 || cleanName.length > 100) throw validationError("name", "name must be 1-100 chars");
  const passwordHash = await hashPassword(password, config.bcryptRounds);
  return stores.users.create({ email: cleanEmail, passwordHash, name: cleanName, role: "consumer" });
}

let dummyHash;

export async function authenticate({ stores, config }, { email, password }) {
  const cleanEmail = normalizeEmail(email);
  if (typeof password !== "string" || password.length === 0 || password.length > 128) {
    throw validationError("password", "password is required");
  }
  const found = await stores.users.findByEmail(cleanEmail);
  if (!found) {
    dummyHash ??= await hashPassword("dummy-password-for-timing", config.bcryptRounds);
    await verifyPassword(password, dummyHash);
    return null;
  }
  if (!(await verifyPassword(password, found.passwordHash))) return null;
  const { passwordHash: _omit, ...user } = found;
  return user;
}

export async function ensureAdmin({ stores, config }) {
  if (!config.adminEmail || !config.adminPassword) return null;
  const email = normalizeEmail(config.adminEmail);
  const existing = await stores.users.findByEmail(email);
  if (existing) {
    if (existing.role !== "admin") await stores.users.setRole(existing.id, "admin");
    return stores.users.findById(existing.id);
  }
  checkPassword(config.adminPassword);
  const passwordHash = await hashPassword(config.adminPassword, config.bcryptRounds);
  try {
    return await stores.users.create({ email, passwordHash, name: "Administrator", role: "admin" });
  } catch (err) {
    if (err.code !== "EMAIL_TAKEN") throw err;
    const raced = await stores.users.findByEmail(email);
    if (raced.role !== "admin") await stores.users.setRole(raced.id, "admin");
    return stores.users.findById(raced.id);
  }
}
