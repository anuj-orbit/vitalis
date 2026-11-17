import test from "node:test";
import assert from "node:assert/strict";
import { startApp, client, registerAs } from "./helpers.js";

let counter = 0;
const email = () => `user-${++counter}-${Date.now()}@example.com`;

async function adminClient(app) {
  const c = client(app.url);
  const { user } = await registerAs(c, app, { email: email(), role: "admin" });
  return { c, user };
}

// Creates a consumer user (through the API) plus a pending provider row.
async function pendingProvider(app) {
  const c = client(app.url);
  const { user } = await registerAs(c, app, { email: email(), role: "consumer" });
  const provider = await app.stores.providers.create({
    userId: user.id,
    kind: "yoga",
    specialty: "Vinyasa",
    bio: "",
    credentials: "RYT-200",
    licenseNo: null,
    priceCredits: 10,
  });
  return { user, provider };
}

test("admin routes reject anonymous (401) and non-admin consumer/provider (403)", async () => {
  const app = await startApp();
  try {
    const anon = client(app.url);
    const consumer = client(app.url);
    await registerAs(consumer, app, { email: email(), role: "consumer" });
    const providerC = client(app.url);
    await registerAs(providerC, app, { email: email(), role: "provider" });
    const { provider } = await pendingProvider(app);

    for (const path of ["/api/admin/applications", "/api/admin/users"]) {
      assert.equal((await anon.get(path)).status, 401, path);
      assert.equal((await consumer.get(path)).status, 403, path);
      assert.equal((await providerC.get(path)).status, 403, path);
    }
    for (const action of ["approve", "reject"]) {
      const path = `/api/admin/applications/${provider.id}/${action}`;
      assert.equal((await anon.post(path, {})).status, 401, path);
      assert.equal((await consumer.post(path, {})).status, 403, path);
      assert.equal((await providerC.post(path, {})).status, 403, path);
    }
  } finally {
    await app.close();
  }
});

test("applications list defaults to pending and supports status filters and rejects bad status", async () => {
  const app = await startApp();
  try {
    const { c: admin } = await adminClient(app);
    const keep = await pendingProvider(app);
    const approve = await pendingProvider(app);
    const reject = await pendingProvider(app);
    assert.equal((await admin.post(`/api/admin/applications/${approve.provider.id}/approve`, {})).status, 200);
    assert.equal((await admin.post(`/api/admin/applications/${reject.provider.id}/reject`, { note: "no" })).status, 200);

    const def = await admin.get("/api/admin/applications");
    assert.equal(def.status, 200);
    assert.equal(def.body.total, 1);
    assert.equal(def.body.items[0].id, keep.provider.id);
    assert.equal(def.body.items[0].status, "pending");

    assert.equal((await admin.get("/api/admin/applications?status=pending")).body.total, 1);
    assert.equal((await admin.get("/api/admin/applications?status=approved")).body.total, 1);
    assert.equal((await admin.get("/api/admin/applications?status=rejected")).body.total, 1);
    assert.equal((await admin.get("/api/admin/applications?status=all")).body.total, 3);

    const bad = await admin.get("/api/admin/applications?status=bogus");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "VALIDATION");
  } finally {
    await app.close();
  }
});

test("approve flips provider to approved, user role to provider, and stores the reviewNote", async () => {
  const app = await startApp();
  try {
    const { c: admin } = await adminClient(app);
    const { user, provider } = await pendingProvider(app);
    assert.equal((await app.stores.users.findById(user.id)).role, "consumer");

    const res = await admin.post(`/api/admin/applications/${provider.id}/approve`, { note: "  looks good  " });
    assert.equal(res.status, 200);
    assert.equal(res.body.provider.status, "approved");
    assert.equal(res.body.provider.reviewNote, "looks good");
    assert.equal((await app.stores.providers.findById(provider.id)).status, "approved");
    assert.equal((await app.stores.users.findById(user.id)).role, "provider");

    // no note -> reviewNote is null
    const second = await pendingProvider(app);
    const noNote = await admin.post(`/api/admin/applications/${second.provider.id}/approve`, {});
    assert.equal(noNote.status, 200);
    assert.equal(noNote.body.provider.reviewNote, null);
  } finally {
    await app.close();
  }
});

test("reject sets rejected and reverts an approved provider's role back to consumer", async () => {
  const app = await startApp();
  try {
    const { c: admin } = await adminClient(app);
    const { user, provider } = await pendingProvider(app);

    assert.equal((await admin.post(`/api/admin/applications/${provider.id}/approve`, {})).status, 200);
    assert.equal((await app.stores.users.findById(user.id)).role, "provider");

    const res = await admin.post(`/api/admin/applications/${provider.id}/reject`, { note: "revoked" });
    assert.equal(res.status, 200);
    assert.equal(res.body.provider.status, "rejected");
    assert.equal(res.body.provider.reviewNote, "revoked");
    assert.equal((await app.stores.users.findById(user.id)).role, "consumer");
  } finally {
    await app.close();
  }
});

test("INVALID_STATUS (409) on re-review and 404 for unknown ids", async () => {
  const app = await startApp();
  try {
    const { c: admin } = await adminClient(app);

    const a = await pendingProvider(app);
    assert.equal((await admin.post(`/api/admin/applications/${a.provider.id}/approve`, {})).status, 200);
    const approvedAgain = await admin.post(`/api/admin/applications/${a.provider.id}/approve`, {});
    assert.equal(approvedAgain.status, 409);
    assert.equal(approvedAgain.body.error.code, "INVALID_STATUS");

    const r = await pendingProvider(app);
    assert.equal((await admin.post(`/api/admin/applications/${r.provider.id}/reject`, {})).status, 200);
    const rejectedAgain = await admin.post(`/api/admin/applications/${r.provider.id}/reject`, {});
    assert.equal(rejectedAgain.status, 409);
    assert.equal(rejectedAgain.body.error.code, "INVALID_STATUS");

    assert.equal((await admin.post("/api/admin/applications/999999/approve", {})).status, 404);
    assert.equal((await admin.post("/api/admin/applications/999999/reject", {})).status, 404);
    assert.equal((await admin.post("/api/admin/applications/abc/approve", {})).status, 404);
  } finally {
    await app.close();
  }
});

test("re-approve after a reject works", async () => {
  const app = await startApp();
  try {
    const { c: admin } = await adminClient(app);
    const { user, provider } = await pendingProvider(app);

    assert.equal((await admin.post(`/api/admin/applications/${provider.id}/reject`, { note: "nope" })).status, 200);
    assert.equal((await app.stores.providers.findById(provider.id)).status, "rejected");
    assert.equal((await app.stores.users.findById(user.id)).role, "consumer");

    const res = await admin.post(`/api/admin/applications/${provider.id}/approve`, { note: "ok now" });
    assert.equal(res.status, 200);
    assert.equal(res.body.provider.status, "approved");
    assert.equal(res.body.provider.reviewNote, "ok now");
    assert.equal((await app.stores.users.findById(user.id)).role, "provider");
  } finally {
    await app.close();
  }
});

test("a review note longer than 500 chars is rejected with 400 and changes nothing", async () => {
  const app = await startApp();
  try {
    const { c: admin } = await adminClient(app);
    const { user, provider } = await pendingProvider(app);

    const res = await admin.post(`/api/admin/applications/${provider.id}/approve`, { note: "x".repeat(501) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION");
    assert.equal((await app.stores.providers.findById(provider.id)).status, "pending");
    assert.equal((await app.stores.users.findById(user.id)).role, "consumer");
  } finally {
    await app.close();
  }
});

test("GET /admin/users returns numeric balance, role/q filters, paging, and never leaks passwordHash", async () => {
  const app = await startApp();
  try {
    const { c: admin } = await adminClient(app);
    const alice = await app.stores.users.create({ email: email(), passwordHash: "hash-a", name: "Alice Smith", role: "consumer" });
    const bob = await app.stores.users.create({ email: email(), passwordHash: "hash-b", name: "Bob Jones", role: "consumer" });
    await app.stores.users.create({ email: email(), passwordHash: "hash-c", name: "Carol Vet", role: "provider" });
    await app.stores.ledger.insert({ userId: alice.id, delta: 40, reason: "topup", balanceAfter: 40 });

    const all = await admin.get("/api/admin/users");
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 4); // admin + alice + bob + carol
    const aliceRow = all.body.items.find((u) => u.id === alice.id);
    const bobRow = all.body.items.find((u) => u.id === bob.id);
    assert.equal(aliceRow.balance, 40);
    assert.equal(bobRow.balance, 0);
    assert.equal(typeof bobRow.balance, "number");
    for (const u of all.body.items) {
      assert.equal("passwordHash" in u, false);
      assert.equal(u.passwordHash, undefined);
    }
    assert.equal(JSON.stringify(all.body).includes("passwordHash"), false);

    // role filter
    assert.equal((await admin.get("/api/admin/users?role=consumer")).body.total, 2);
    assert.equal((await admin.get("/api/admin/users?role=provider")).body.total, 1);
    assert.equal((await admin.get("/api/admin/users?role=admin")).body.total, 1);
    assert.equal((await admin.get("/api/admin/users?role=nope")).status, 400);

    // q filter (case-insensitive over email/name)
    const byName = await admin.get("/api/admin/users?q=alice");
    assert.equal(byName.body.total, 1);
    assert.equal(byName.body.items[0].id, alice.id);
    const byName2 = await admin.get("/api/admin/users?q=jones");
    assert.equal(byName2.body.items[0].id, bob.id);

    // paging
    const page = await admin.get("/api/admin/users?limit=1&offset=1");
    assert.equal(page.body.items.length, 1);
    assert.equal(page.body.total, 4);
  } finally {
    await app.close();
  }
});

test("memory tx rolls back all writes when the callback throws and still works afterwards", async () => {
  const app = await startApp();
  try {
    const ghostEmail = email();
    await assert.rejects(
      app.stores.tx(async (tx) => {
        await tx.users.create({ email: ghostEmail, passwordHash: "h", name: "Ghost", role: "consumer" });
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await app.stores.users.findByEmail(ghostEmail), null);
    assert.equal((await app.stores.users.list({})).total, 0);

    // a committed tx persists
    const keptEmail = email();
    await app.stores.tx(async (tx) => {
      await tx.users.create({ email: keptEmail, passwordHash: "h", name: "Kept", role: "consumer" });
    });
    assert.ok(await app.stores.users.findByEmail(keptEmail));

    // rollback does not wedge the mutex
    const afterEmail = email();
    await app.stores.tx(async (tx) => {
      await tx.users.create({ email: afterEmail, passwordHash: "h", name: "After", role: "consumer" });
    });
    assert.ok(await app.stores.users.findByEmail(afterEmail));
  } finally {
    await app.close();
  }
});

test("memory tx is re-entrant through txStores.tx", async () => {
  const app = await startApp();
  try {
    const nestedEmail = email();
    const result = await app.stores.tx(async (tx) =>
      tx.tx(async (inner) => {
        await inner.users.create({ email: nestedEmail, passwordHash: "h", name: "Nested", role: "consumer" });
        return "done";
      }),
    );
    assert.equal(result, "done");
    assert.ok(await app.stores.users.findByEmail(nestedEmail));
  } finally {
    await app.close();
  }
});

test("concurrent memory tx calls are serialized, not interleaved", async () => {
  const app = await startApp();
  try {
    let active = 0;
    let maxActive = 0;
    const run = () =>
      app.stores.tx(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      });
    await Promise.all([run(), run(), run(), run()]);
    assert.equal(maxActive, 1);

    // a read-modify-write across concurrent txs yields a consistent final state
    const u = await app.stores.users.create({ email: email(), passwordHash: "h", name: "Flipper", role: "consumer" });
    const flip = () =>
      app.stores.tx(async (tx) => {
        const current = await tx.users.findById(u.id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await tx.users.setRole(u.id, current.role === "consumer" ? "provider" : "consumer");
      });
    await Promise.all([flip(), flip()]);
    assert.equal((await app.stores.users.findById(u.id)).role, "consumer");
  } finally {
    await app.close();
  }
});
