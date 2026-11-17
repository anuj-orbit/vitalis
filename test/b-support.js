// Shared setup for the credits/bookings tests (in-memory stores, mutable clock).
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMemoryStores } from "../src/stores/index.js";
import { createSimulatedPaymentProvider } from "../src/payments.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";

export const T0 = new Date("2026-11-17T10:00:00Z"); // a Tuesday (weekday 2)

export function makeEnv({ now = T0, payments = createSimulatedPaymentProvider(), env = {} } = {}) {
  const clock = { now: new Date(now) };
  const config = loadConfig({ SESSION_SECRET: "s".repeat(40), BCRYPT_ROUNDS: "4", ...env });
  const stores = createMemoryStores();
  const deps = { stores, config, payments, now: () => new Date(clock.now) };
  let n = 0;

  async function seedUser(role = "consumer", name = `User ${++n}`) {
    return stores.users.create({ email: `u${++n}@example.com`, passwordHash: "x", name, role });
  }

  async function seedProvider({ priceCredits = 10, kind = "yoga", status = "approved", availability } = {}) {
    const user = await seedUser("provider", `Provider ${++n}`);
    let provider = await stores.providers.create({
      userId: user.id, kind, specialty: "Vinyasa", bio: "", credentials: "RYT-200",
      licenseNo: kind === "doctor" ? "L-1" : null, priceCredits,
    });
    if (status !== "pending") provider = await stores.providers.update(provider.id, { status });
    // Tuesday 08:00-12:00 UTC by default
    await stores.availability.replaceForProvider(
      provider.id,
      availability ?? [{ weekday: 2, startTime: "08:00", endTime: "12:00" }],
    );
    return { user, provider };
  }

  async function fund(userId, credits) {
    const { applyLedgerEntry } = await import("../src/credits.js");
    return stores.tx((tx) => applyLedgerEntry(tx, { userId, delta: credits, reason: "adjust", note: "seed" }));
  }

  function cookieFor(user) {
    const token = signSession({ uid: user.id, exp: Math.floor(clock.now.getTime() / 1000) + 3600 }, config.sessionSecret);
    return `${SESSION_COOKIE}=${token}`;
  }

  async function serve() {
    const server = createApp(deps).listen(0);
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, { user, body } = {}) => {
      const res = await fetch(url + path, {
        method,
        headers: { "content-type": "application/json", ...(user ? { cookie: cookieFor(user) } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    return { url, call, close: () => new Promise((r) => server.close(r)) };
  }

  return { clock, config, stores, deps, seedUser, seedProvider, fund, cookieFor, serve };
}
