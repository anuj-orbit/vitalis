import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMemoryStores } from "../src/stores/index.js";
import { createSimulatedPaymentProvider } from "../src/payments.js";

export async function startApp({ now, payments, config } = {}) {
  const stores = createMemoryStores();
  const cfg = {
    ...loadConfig({ SESSION_SECRET: "x".repeat(32), BCRYPT_ROUNDS: "4" }),
    sessionSecret: "x".repeat(32),
    bcryptRounds: 4,
    ...config,
  };
  const app = createApp({
    config: cfg,
    stores,
    payments: payments ?? createSimulatedPaymentProvider(),
    now: now ?? (() => new Date()),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    stores,
    config: cfg,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

export function client(url) {
  let cookie = "";
  async function call(method, path, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (cookie) init.headers.cookie = cookie;
    if (body !== undefined) {
      init.headers["content-type"] ??= "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res = await fetch(url + path, init);
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0];
      cookie = pair.endsWith("=") ? "" : pair;
    }
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }
  return {
    get: (path, headers) => call("GET", path, undefined, headers),
    post: (path, body, headers) => call("POST", path, body, headers),
    put: (path, body, headers) => call("PUT", path, body, headers),
  };
}

// registerAs(c, app, {email, role}) registers through the API, then upgrades the role via the store.
export async function registerAs(c, app, { email, role = "consumer", name = "Test User", password = "password123" } = {}) {
  const res = await c.post("/api/auth/register", { email, password, name });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  let user = res.body.user;
  let provider = null;
  if (role === "admin") {
    user = await app.stores.users.setRole(user.id, "admin");
  } else if (role === "provider") {
    user = await app.stores.users.setRole(user.id, "provider");
    const created = await app.stores.providers.create({
      userId: user.id,
      kind: "yoga",
      specialty: "Vinyasa",
      bio: "",
      credentials: "RYT-200",
      licenseNo: null,
      priceCredits: 10,
    });
    provider = await app.stores.providers.update(created.id, { status: "approved" });
  }
  return { user, provider };
}
