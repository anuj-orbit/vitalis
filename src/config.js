import { randomBytes } from "node:crypto";

function intOr(value, fallback, min, max) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(String(value).trim())) return fallback;
  const n = Number(value);
  return n >= min && n <= max ? n : fallback;
}

export function loadConfig(env = process.env) {
  const isProduction = env.NODE_ENV === "production";
  let sessionSecret = env.SESSION_SECRET;
  if (isProduction && (!sessionSecret || sessionSecret.length < 32)) {
    throw new Error("SESSION_SECRET is required in production and must be at least 32 characters");
  }
  sessionSecret ||= randomBytes(32).toString("hex");
  return {
    port: intOr(env.PORT, 3000, 0, 65535),
    databaseUrl: env.DATABASE_URL || null,
    sessionSecret,
    adminEmail: env.ADMIN_EMAIL || null,
    adminPassword: env.ADMIN_PASSWORD || null,
    platformFeePct: intOr(env.PLATFORM_FEE_PCT, 20, 0, 100),
    creditPriceAed: intOr(env.CREDIT_PRICE_AED, 5, 1, 100000),
    creditPacks: [10, 25, 50, 100],
    sessionTtlSec: 604800,
    cancelWindowHours: 24,
    slotMinutes: 60,
    bookingHorizonDays: 60,
    bcryptRounds: intOr(env.BCRYPT_ROUNDS, 10, 4, 15),
    isProduction,
  };
}
