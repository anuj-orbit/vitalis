import test from "node:test";
import assert from "node:assert/strict";
import { startApp, client } from "./helpers.js";
import { createMemoryStores } from "../src/stores/index.js";
import { loadConfig } from "../src/config.js";
import {
  SESSION_COOKIE,
  signSession,
  verifySession,
  sessionCookie,
  clearSessionCookie,
  parseCookies,
  register,
  ensureAdmin,
  verifyPassword,
} from "../src/auth.js";

const SECRET = "s".repeat(32);

// A minimal deps object for unit-level calls into src/auth.js.
function unitDeps(overrides = {}) {
  const config = {
    ...loadConfig({ SESSION_SECRET: SECRET, BCRYPT_ROUNDS: "4" }),
    adminEmail: null,
    adminPassword: null,
    ...overrides,
  };
  const stores = createMemoryStores();
  return { stores, config, deps: { stores, config, now: () => new Date() } };
}

// ---------------------------------------------------------------------------
// signSession / verifySession
// ---------------------------------------------------------------------------

test("signSession/verifySession round trip", () => {
  const exp = 2_000_000_000;
  const token = signSession({ uid: 42, exp }, SECRET);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(verifySession(token, SECRET, 1_700_000_000_000), { uid: 42, exp });
  // exp is in seconds and only rejected once exp*1000 <= nowMs
  assert.deepEqual(verifySession(token, SECRET, exp * 1000 - 1), { uid: 42, exp });
});

test("verifySession rejects tampered tokens", () => {
  const token = signSession({ uid: 7, exp: 2_000_000_000 }, SECRET);
  const [payload, sig] = token.split(".");
  // payload swapped but signature reused
  const badPayload = payload.slice(0, -1) + (payload.endsWith("A") ? "B" : "A");
  assert.equal(verifySession(`${badPayload}.${sig}`, SECRET, 0), null);
  // signature byte flipped (first char changes real bits)
  const badSig = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  assert.equal(verifySession(`${payload}.${badSig}`, SECRET, 0), null);
  // signed with a different secret
  assert.equal(verifySession(token, "z".repeat(32), 0), null);
});

test("verifySession rejects expired tokens and bad claims", () => {
  const nowMs = 1_700_000_000_000;
  const nowSec = nowMs / 1000;
  assert.equal(verifySession(signSession({ uid: 1, exp: nowSec - 1 }, SECRET), SECRET, nowMs), null);
  // boundary: exp*1000 === nowMs is expired
  assert.equal(verifySession(signSession({ uid: 1, exp: nowSec }, SECRET), SECRET, nowMs), null);
  assert.ok(verifySession(signSession({ uid: 1, exp: nowSec + 1 }, SECRET), SECRET, nowMs));
  assert.equal(verifySession(signSession({ uid: "1", exp: nowSec + 1 }, SECRET), SECRET, nowMs), null);
  assert.equal(verifySession(signSession({ uid: 1, exp: "soon" }, SECRET), SECRET, nowMs), null);
});

test("verifySession rejects malformed tokens", () => {
  const malformed = [undefined, null, 42, {}, [], "", "abc", "a.b", "a.b.c", ".", "abc.", ".abc", "eyJ1aWQiOjF9"];
  for (const bad of malformed) {
    assert.equal(verifySession(bad, SECRET, 0), null, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

test("sessionCookie sets the expected attributes, Secure only when requested", () => {
  const plain = sessionCookie("tok", { secure: false, maxAgeSec: 604800 });
  assert.equal(plain, "vitalis_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800");
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.match(plain, /Path=\//);
  assert.match(plain, /Max-Age=604800/);
  assert.doesNotMatch(plain, /Secure/);

  const secure = sessionCookie("tok", { secure: true, maxAgeSec: 60 });
  assert.equal(secure, "vitalis_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure");
});

test("clearSessionCookie keeps attributes and expires immediately", () => {
  const plain = clearSessionCookie({ secure: false });
  assert.equal(plain, "vitalis_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  const secure = clearSessionCookie({ secure: true });
  assert.equal(secure, "vitalis_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
});

test("parseCookies parses, decodes, and ignores junk/duplicates", () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies("a=1; b=2"), { a: "1", b: "2" });
  assert.deepEqual(parseCookies("vitalis_session=abc.def; other=x"), { vitalis_session: "abc.def", other: "x" });
  assert.deepEqual(parseCookies("name=hello%20world"), { name: "hello world" });
  assert.deepEqual(parseCookies("flag; x=1"), { x: "1" });
  assert.deepEqual(parseCookies("a=1; a=2"), { a: "1" });
  assert.deepEqual(parseCookies("a=bad%zz"), { a: "bad%zz" });
});

// ---------------------------------------------------------------------------
// HTTP: auth flow
// ---------------------------------------------------------------------------

test("HTTP: register, me, logout, me again", async () => {
  const app = await startApp();
  try {
    const c = client(app.url);

    const reg = await c.post("/api/auth/register", {
      email: "flow@example.com",
      password: "password123",
      name: "Flow User",
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.email, "flow@example.com");
    assert.equal(reg.body.user.role, "consumer");
    assert.equal(reg.body.user.name, "Flow User");
    assert.equal(reg.body.user.passwordHash, undefined);

    const setCookie = reg.headers.get("set-cookie");
    assert.ok(setCookie.startsWith(`${SESSION_COOKIE}=`));
    assert.doesNotMatch(setCookie, /;\s*Secure/i);

    // the stored hash must never appear in a response body
    const hash = (await app.stores.users.findByEmail("flow@example.com")).passwordHash;
    assert.ok(hash && hash.length > 10);
    assert.ok(!JSON.stringify(reg.body).includes(hash));

    let me = await c.get("/api/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, "flow@example.com");
    assert.equal(me.body.user.passwordHash, undefined);
    assert.equal(me.body.provider, null);
    assert.ok(!JSON.stringify(me.body).includes(hash));

    const out = await c.post("/api/auth/logout");
    assert.equal(out.status, 204);
    assert.match(out.headers.get("set-cookie"), /Max-Age=0/);

    me = await c.get("/api/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.user, null);
  } finally {
    await app.close();
  }
});

test("HTTP: login succeeds and never leaks the password hash", async () => {
  const app = await startApp();
  try {
    const registrar = client(app.url);
    await registrar.post("/api/auth/register", { email: "login@example.com", password: "password123", name: "Log In" });
    const hash = (await app.stores.users.findByEmail("login@example.com")).passwordHash;

    const c = client(app.url);
    const res = await c.post("/api/auth/login", { email: "login@example.com", password: "password123" });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, "login@example.com");
    assert.equal(res.body.user.passwordHash, undefined);
    assert.ok(!JSON.stringify(res.body).includes(hash));
    assert.ok(res.headers.get("set-cookie").startsWith(`${SESSION_COOKIE}=`));
    // the fresh session works
    assert.equal((await c.get("/api/auth/me")).body.user.email, "login@example.com");
  } finally {
    await app.close();
  }
});

test("HTTP: duplicate email gives 409 EMAIL_TAKEN", async () => {
  const app = await startApp();
  try {
    const c = client(app.url);
    const body = { email: "dup@example.com", password: "password123", name: "Dup" };
    assert.equal((await c.post("/api/auth/register", body)).status, 201);
    const second = await c.post("/api/auth/register", body);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "EMAIL_TAKEN");
  } finally {
    await app.close();
  }
});

test("HTTP: wrong password and unknown email both give 401 INVALID_CREDENTIALS", async () => {
  const app = await startApp();
  try {
    const c = client(app.url);
    await c.post("/api/auth/register", { email: "known@example.com", password: "password123", name: "Known" });

    const wrong = await c.post("/api/auth/login", { email: "known@example.com", password: "wrongpassword" });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, "INVALID_CREDENTIALS");

    const unknown = await c.post("/api/auth/login", { email: "nobody@example.com", password: "password123" });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.code, "INVALID_CREDENTIALS");
  } finally {
    await app.close();
  }
});

test("HTTP: validation errors give 400 VALIDATION with the offending field", async () => {
  const app = await startApp();
  try {
    const c = client(app.url);
    const cases = [
      [{ email: "not-an-email", password: "password123", name: "X" }, "email"],
      [{ email: "short@example.com", password: "short", name: "X" }, "password"],
      [{ email: "noname@example.com", password: "password123", name: "   " }, "name"],
    ];
    for (const [body, field] of cases) {
      const res = await c.post("/api/auth/register", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error.code, "VALIDATION");
      assert.equal(res.body.error.details.field, field);
    }
    assert.equal((await app.stores.users.list({})).total, 0);
  } finally {
    await app.close();
  }
});

test("HTTP: non-JSON POST with a body gives 415 UNSUPPORTED_MEDIA_TYPE", async () => {
  const app = await startApp();
  try {
    const c = client(app.url);
    const res = await c.post("/api/auth/login", "plain text body", { "content-type": "text/plain" });
    assert.equal(res.status, 415);
    assert.equal(res.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  } finally {
    await app.close();
  }
});

test("HTTP: register/login are rate limited to 20 per window", async () => {
  const app = await startApp();
  try {
    const c = client(app.url);
    for (let i = 0; i < 20; i++) {
      const res =
        i % 2 === 0
          ? await c.post("/api/auth/register", { email: `rl${i}@example.com`, password: "password123", name: "RL" })
          : await c.post("/api/auth/login", { email: "nobody@example.com", password: "password123" });
      assert.notEqual(res.status, 429, `request ${i + 1} should not be limited`);
    }
    const blocked = await c.post("/api/auth/login", { email: "nobody@example.com", password: "password123" });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, "RATE_LIMITED");
  } finally {
    await app.close();
  }
});

test("HTTP: session cookie carries Secure when config.isProduction", async () => {
  const app = await startApp({ config: { isProduction: true, cookieSecure: true } });
  try {
    const c = client(app.url);
    const reg = await c.post("/api/auth/register", {
      email: "secure@example.com",
      password: "password123",
      name: "Secure",
    });
    assert.equal(reg.status, 201);
    const setCookie = reg.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /;\s*Secure/);

    const out = await c.post("/api/auth/logout");
    const cleared = out.headers.get("set-cookie");
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /;\s*Secure/);
  } finally {
    await app.close();
  }
});

test("HTTP: expired and tampered session cookies are ignored", async () => {
  const fixedNow = new Date("2026-01-01T00:00:00Z");
  const app = await startApp({ now: () => fixedNow });
  try {
    const c = client(app.url);
    const reg = await c.post("/api/auth/register", { email: "exp@example.com", password: "password123", name: "Exp" });
    assert.equal(reg.status, 201);
    assert.equal((await c.get("/api/auth/me")).body.user.email, "exp@example.com");

    const nowSec = Math.floor(fixedNow.getTime() / 1000);
    const expired = signSession({ uid: reg.body.user.id, exp: nowSec - 1 }, app.config.sessionSecret);
    const tampered = `${expired.slice(0, -2)}aa`;

    const c2 = client(app.url);
    assert.equal((await c2.get("/api/auth/me", { cookie: `${SESSION_COOKIE}=${expired}` })).body.user, null);
    assert.equal((await c2.get("/api/auth/me", { cookie: `${SESSION_COOKIE}=${tampered}` })).body.user, null);
    assert.equal((await c2.get("/api/auth/me", { cookie: `${SESSION_COOKIE}=garbage` })).body.user, null);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// ensureAdmin
// ---------------------------------------------------------------------------

test("ensureAdmin returns null when admin config is missing", async () => {
  const { deps, stores } = unitDeps();
  assert.equal(await ensureAdmin(deps), null);
  assert.equal(await ensureAdmin({ ...deps, config: { ...deps.config, adminEmail: "a@example.com" } }), null);
  assert.equal(await ensureAdmin({ ...deps, config: { ...deps.config, adminPassword: "adminpass123" } }), null);
  assert.equal((await stores.users.list({})).total, 0);
});

test("ensureAdmin creates the admin from config and is idempotent", async () => {
  const { deps, stores } = unitDeps({ adminEmail: "admin@example.com", adminPassword: "adminpass123" });
  const first = await ensureAdmin(deps);
  assert.equal(first.role, "admin");
  assert.equal(first.email, "admin@example.com");
  const second = await ensureAdmin(deps);
  assert.equal(second.id, first.id);
  assert.equal(second.role, "admin");
  assert.equal((await stores.users.list({ role: "admin" })).total, 1);
  assert.equal(await verifyPassword("adminpass123", (await stores.users.findByEmail("admin@example.com")).passwordHash), true);
});

test("ensureAdmin promotes an existing user without resetting the password", async () => {
  const { deps, stores } = unitDeps({ adminEmail: "boss@example.com", adminPassword: "differentpass123" });
  const user = await register(deps, { email: "boss@example.com", password: "originalpass123", name: "Boss" });
  const before = await stores.users.findByEmail("boss@example.com");

  const promoted = await ensureAdmin(deps);
  assert.equal(promoted.id, user.id);
  assert.equal(promoted.role, "admin");

  const after = await stores.users.findByEmail("boss@example.com");
  assert.equal(after.passwordHash, before.passwordHash);
  assert.equal(await verifyPassword("originalpass123", after.passwordHash), true);
  assert.equal(await verifyPassword("differentpass123", after.passwordHash), false);

  // already admin: no duplicate, same row
  const again = await ensureAdmin(deps);
  assert.equal(again.id, user.id);
  assert.equal((await stores.users.list({})).total, 1);
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

test("loadConfig throws in production without a 32+ char SESSION_SECRET", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ NODE_ENV: "production", SESSION_SECRET: "short" }), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ NODE_ENV: "production", SESSION_SECRET: "x".repeat(31) }), /SESSION_SECRET/);
  const ok = loadConfig({ NODE_ENV: "production", SESSION_SECRET: "x".repeat(32) });
  assert.equal(ok.sessionSecret, "x".repeat(32));
  assert.equal(ok.isProduction, true);
});

test("loadConfig applies defaults", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.databaseUrl, null);
  assert.equal(cfg.adminEmail, null);
  assert.equal(cfg.adminPassword, null);
  assert.equal(cfg.platformFeePct, 20);
  assert.equal(cfg.creditPriceAed, 5);
  assert.deepEqual(cfg.creditPacks, [10, 25, 50, 100]);
  assert.equal(cfg.sessionTtlSec, 604800);
  assert.equal(cfg.cancelWindowHours, 24);
  assert.equal(cfg.slotMinutes, 60);
  assert.equal(cfg.bookingHorizonDays, 60);
  assert.equal(cfg.bcryptRounds, 10);
  assert.equal(cfg.isProduction, false);
  assert.match(cfg.sessionSecret, /^[0-9a-f]{64}$/);
});

test("loadConfig falls back to 20 for an invalid PLATFORM_FEE_PCT", () => {
  for (const bad of ["abc", "", "150", "-5", "10.5", "101"]) {
    assert.equal(loadConfig({ PLATFORM_FEE_PCT: bad }).platformFeePct, 20, JSON.stringify(bad));
  }
  assert.equal(loadConfig({ PLATFORM_FEE_PCT: "10" }).platformFeePct, 10);
  assert.equal(loadConfig({ PLATFORM_FEE_PCT: "0" }).platformFeePct, 0);
  assert.equal(loadConfig({ PLATFORM_FEE_PCT: "100" }).platformFeePct, 100);
});
