import test from "node:test";
import assert from "node:assert/strict";
import { startApp, client, registerAs } from "./helpers.js";

// Boot an app + client + register a consumer in one go.
async function fresh() {
  const app = await startApp();
  return { app, c: client(app.url) };
}

// Apply as a fresh consumer, then approve the row directly through the store.
async function approvedProvider(app, { email, kind = "yoga", specialty = "Vinyasa", credentials = "RYT-200", licenseNo = null, priceCredits = 10, bio = "" } = {}) {
  const c = client(app.url);
  const { user } = await registerAs(c, app, { email });
  const res = await c.post("/api/providers/apply", { kind, specialty, bio, credentials, licenseNo, priceCredits });
  assert.equal(res.status, 201, `apply setup failed: ${JSON.stringify(res.body)}`);
  const provider = await app.stores.providers.update(res.body.provider.id, { status: "approved" });
  return { user, provider };
}

const valid = { kind: "yoga", specialty: "Vinyasa", bio: "hello", credentials: "RYT-200", priceCredits: 10 };

test("POST /api/providers/apply: auth and role guards", async () => {
  const { app, c } = await fresh();
  try {
    // 401 when there is no session at all
    const anon = client(app.url);
    assert.equal((await anon.post("/api/providers/apply", valid)).status, 401);

    // 403 for an admin
    const admin = client(app.url);
    await registerAs(admin, app, { email: "admin@example.com", role: "admin" });
    const r = await admin.post("/api/providers/apply", valid);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "FORBIDDEN");

    // sanity: a consumer succeeds
    const consumer = client(app.url);
    await registerAs(consumer, app, { email: "consumer@example.com" });
    assert.equal((await consumer.post("/api/providers/apply", valid)).status, 201);
  } finally {
    await app.close();
  }
});

test("POST /api/providers/apply: body validation", async () => {
  const { app, c } = await fresh();
  try {
    const { user } = await registerAs(c, app, { email: "bad@example.com" });
    const cases = [
      { ...valid, kind: "pilot" }, // bad kind
      { ...valid, specialty: "" }, // empty specialty
      { ...valid, specialty: "  " }, // whitespace-only specialty trims to empty
      { ...valid, specialty: "x".repeat(81) }, // specialty > 80
      { ...valid, credentials: undefined }, // credentials missing
      { ...valid, credentials: "" }, // credentials empty
      { ...valid, bio: "x".repeat(2001) }, // bio > 2000
      { ...valid, priceCredits: 0 },
      { ...valid, priceCredits: 1001 },
      { ...valid, priceCredits: 10.5 }, // non-integer
      { ...valid, priceCredits: "10" }, // non-integer type
    ];
    for (const body of cases) {
      const r = await c.post("/api/providers/apply", body);
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.equal(r.body.error.code, "VALIDATION");
    }
    // no provider row was created by any failed attempt
    assert.equal(await app.stores.providers.findByUserId(user.id), null);
    assert.equal((await app.stores.providers.list({})).total, 0);
  } finally {
    await app.close();
  }
});

test("POST /api/providers/apply: doctor needs licenseNo, yoga does not", async () => {
  const { app, c } = await fresh();
  try {
    await registerAs(c, app, { email: "doc@example.com" });
    const missing = await c.post("/api/providers/apply", { ...valid, kind: "doctor" });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.details.field, "licenseNo");

    const withLicense = await c.post("/api/providers/apply", { ...valid, kind: "doctor", licenseNo: "DHA-123" });
    assert.equal(withLicense.status, 201);
    assert.equal(withLicense.body.provider.licenseNo, "DHA-123");
  } finally {
    await app.close();
  }
});

test("POST /api/providers/apply: yoga without licenseNo succeeds with status pending", async () => {
  const { app, c } = await fresh();
  try {
    await registerAs(c, app, { email: "yoga@example.com" });
    const r = await c.post("/api/providers/apply", valid);
    assert.equal(r.status, 201);
    assert.equal(r.body.provider.status, "pending");
    assert.equal(r.body.provider.kind, "yoga");
    assert.equal(r.body.provider.specialty, "Vinyasa");
    assert.equal(r.body.provider.reviewNote, null);
  } finally {
    await app.close();
  }
});

test("POST /api/providers/apply: 409 ALREADY_APPLIED while pending and while approved", async () => {
  const { app, c } = await fresh();
  try {
    await registerAs(c, app, { email: "pending@example.com" });
    assert.equal((await c.post("/api/providers/apply", valid)).status, 201);
    const again = await c.post("/api/providers/apply", valid);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "ALREADY_APPLIED");

    // approved provider row (registerAs provider role) also gives 409
    const p = client(app.url);
    await registerAs(p, app, { email: "approved@example.com", role: "provider" });
    const r = await p.post("/api/providers/apply", valid);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "ALREADY_APPLIED");
  } finally {
    await app.close();
  }
});

test("POST /api/providers/apply: rejected application can re-apply (200, pending, reviewNote cleared)", async () => {
  const { app, c } = await fresh();
  try {
    const { user } = await registerAs(c, app, { email: "reapply@example.com" });
    const first = await c.post("/api/providers/apply", valid);
    assert.equal(first.status, 201);
    const id = first.body.provider.id;
    await app.stores.providers.update(id, { status: "rejected", reviewNote: "Not enough detail" });
    assert.equal((await app.stores.providers.findById(id)).reviewNote, "Not enough detail");

    const second = await c.post("/api/providers/apply", { ...valid, specialty: "Hatha" });
    assert.equal(second.status, 200);
    assert.equal(second.body.provider.id, id);
    assert.equal(second.body.provider.status, "pending");
    assert.equal(second.body.provider.specialty, "Hatha");
    assert.equal(second.body.provider.reviewNote, null);
    // role was never promoted
    assert.equal((await app.stores.users.findById(user.id)).role, "consumer");
  } finally {
    await app.close();
  }
});

test("GET /api/providers: lists only approved, no email, filters by kind/specialty/q", async () => {
  const { app } = await fresh();
  try {
    await approvedProvider(app, { email: "a@example.com", kind: "yoga", specialty: "Vinyasa" });
    await approvedProvider(app, { email: "b@example.com", kind: "fitness", specialty: "HIIT" });
    await approvedProvider(app, { email: "c@example.com", kind: "doctor", specialty: "Cardiology", licenseNo: "D-1" });

    // a pending and a rejected provider must be hidden
    const pc = client(app.url);
    await registerAs(pc, app, { email: "pend@example.com" });
    await pc.post("/api/providers/apply", valid);
    const rc = client(app.url);
    await registerAs(rc, app, { email: "rej@example.com" });
    const rej = await rc.post("/api/providers/apply", { ...valid, specialty: "Rejected" });
    await app.stores.providers.update(rej.body.provider.id, { status: "rejected" });

    const c = client(app.url);
    let r = await c.get("/api/providers");
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 3);
    assert.equal(r.body.items.length, 3);
    for (const item of r.body.items) {
      assert.equal(item.status, "approved");
      assert.ok(!("email" in item), "list items must not expose email");
    }

    // kind filter
    r = await c.get("/api/providers?kind=fitness");
    assert.equal(r.body.total, 1);
    assert.equal(r.body.items[0].kind, "fitness");

    // specialty is a case-insensitive exact match
    assert.equal((await c.get("/api/providers?specialty=vinyasa")).body.total, 1);
    assert.equal((await c.get("/api/providers?specialty=VINYASA")).body.total, 1);
    assert.equal((await c.get("/api/providers?specialty=Viny")).body.total, 0);

    // q searches name/specialty/bio
    assert.equal((await c.get("/api/providers?q=cardio")).body.total, 1);
    assert.equal((await c.get("/api/providers?q=zzz")).body.total, 0);

    // invalid kind
    const bad = await c.get("/api/providers?kind=pilot");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "VALIDATION");

    // rejected/pending never appear even with a matching specialty
    assert.equal((await c.get("/api/providers?specialty=Rejected")).body.total, 0);
  } finally {
    await app.close();
  }
});

test("GET /api/providers: limit/offset paging with total", async () => {
  const { app } = await fresh();
  try {
    for (const [i, s] of ["One", "Two", "Three"].entries()) {
      await approvedProvider(app, { email: `p${i}@example.com`, specialty: s });
    }
    const c = client(app.url);
    const p1 = await c.get("/api/providers?limit=2&offset=0");
    assert.equal(p1.body.total, 3);
    assert.equal(p1.body.items.length, 2);
    const p2 = await c.get("/api/providers?limit=2&offset=2");
    assert.equal(p2.body.total, 3);
    assert.equal(p2.body.items.length, 1);
    assert.ok(p1.body.items[0].id < p2.body.items[0].id, "ordered by id asc");

    assert.equal((await c.get("/api/providers?limit=0")).status, 400);
    assert.equal((await c.get("/api/providers?limit=101")).status, 400);
  } finally {
    await app.close();
  }
});

test("GET /api/providers/:id: 200 approved with availability, 404 otherwise", async () => {
  const { app } = await fresh();
  try {
    const { provider } = await approvedProvider(app, { email: "det@example.com", specialty: "Yoga Det" });
    // give it some availability through the API for the provider role
    const row = await app.stores.availability.replaceForProvider(provider.id, [
      { weekday: 1, startTime: "09:00", endTime: "10:00" },
    ]);
    assert.equal(row.length, 1);

    const c = client(app.url);
    const ok = await c.get(`/api/providers/${provider.id}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.provider.id, provider.id);
    assert.ok(!("email" in ok.body.provider), "detail must not expose email");
    assert.equal(ok.body.availability.length, 1);
    assert.equal(ok.body.availability[0].weekday, 1);

    // pending provider is hidden
    const pc = client(app.url);
    await registerAs(pc, app, { email: "hide-pending@example.com" });
    const pending = await pc.post("/api/providers/apply", valid);
    assert.equal((await c.get(`/api/providers/${pending.body.provider.id}`)).status, 404);

    // rejected provider is hidden
    const rc = client(app.url);
    await registerAs(rc, app, { email: "hide-rej@example.com" });
    const rejected = await rc.post("/api/providers/apply", valid);
    await app.stores.providers.update(rejected.body.provider.id, { status: "rejected" });
    assert.equal((await c.get(`/api/providers/${rejected.body.provider.id}`)).status, 404);

    // unknown and non-numeric ids
    assert.equal((await c.get("/api/providers/999999")).status, 404);
    assert.equal((await c.get("/api/providers/abc")).status, 404);
  } finally {
    await app.close();
  }
});

test("GET /api/providers/me: provider is null for a user without a provider row", async () => {
  const { app } = await fresh();
  try {
    const c = client(app.url);
    await registerAs(c, app, { email: "noprov@example.com" });
    const r = await c.get("/api/providers/me");
    assert.equal(r.status, 200);
    assert.equal(r.body.provider, null);
    assert.deepEqual(r.body.availability, []);

    // 401 unauthenticated
    assert.equal((await client(app.url).get("/api/providers/me")).status, 401);
  } finally {
    await app.close();
  }
});

test("PUT /api/providers/me: partial update and guards", async () => {
  const { app } = await fresh();
  try {
    const c = client(app.url);
    const { provider } = await registerAs(c, app, { email: "prof@example.com", role: "provider" });
    const before = await app.stores.providers.findById(provider.id);

    const r = await c.put("/api/providers/me", { specialty: "Power Yoga" });
    assert.equal(r.status, 200);
    assert.equal(r.body.provider.specialty, "Power Yoga");
    // untouched fields are unchanged
    assert.equal(r.body.provider.credentials, before.credentials);
    assert.equal(r.body.provider.priceCredits, before.priceCredits);
    assert.equal(r.body.provider.bio, before.bio);
    assert.equal(r.body.provider.kind, before.kind);

    // kind is not changeable
    const k = await c.put("/api/providers/me", { kind: "doctor", specialty: "Still Yoga" });
    assert.equal(k.status, 200);
    assert.equal(k.body.provider.kind, "yoga");
    assert.equal(k.body.provider.specialty, "Still Yoga");

    // priceCredits validation
    assert.equal((await c.put("/api/providers/me", { priceCredits: 0 })).status, 400);

    // 401 unauthenticated
    assert.equal((await client(app.url).put("/api/providers/me", { specialty: "X" })).status, 401);

    // 404 when a logged-in user has no provider row
    const consumer = client(app.url);
    await registerAs(consumer, app, { email: "put-noprov@example.com" });
    const nf = await consumer.put("/api/providers/me", { specialty: "X" });
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error.code, "NOT_FOUND");
  } finally {
    await app.close();
  }
});

test("PUT /api/providers/me: a doctor cannot blank licenseNo", async () => {
  const { app } = await fresh();
  try {
    const c = client(app.url);
    await registerAs(c, app, { email: "doc2@example.com" });
    const apply = await c.post("/api/providers/apply", { ...valid, kind: "doctor", licenseNo: "DHA-9" });
    assert.equal(apply.status, 201);

    const r = await c.put("/api/providers/me", { licenseNo: "" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.details.field, "licenseNo");
    // still has its license
    assert.equal((await app.stores.providers.findById(apply.body.provider.id)).licenseNo, "DHA-9");

    // setting a real value works
    const ok = await c.put("/api/providers/me", { licenseNo: "DHA-99" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.provider.licenseNo, "DHA-99");
  } finally {
    await app.close();
  }
});

test("PUT /api/providers/me/availability: valid save returns sorted Slot[] with ids", async () => {
  const { app } = await fresh();
  try {
    const c = client(app.url);
    await registerAs(c, app, { email: "avail@example.com", role: "provider" });
    const r = await c.put("/api/providers/me/availability", {
      availability: [
        { weekday: 3, startTime: "10:00", endTime: "11:00" },
        { weekday: 1, startTime: "09:00", endTime: "10:00" },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.availability.length, 2);
    assert.equal(r.body.availability[0].weekday, 1);
    assert.equal(r.body.availability[1].weekday, 3);
    for (const slot of r.body.availability) {
      assert.equal(typeof slot.id, "number");
      assert.ok(slot.id > 0);
      assert.equal(typeof slot.providerId, "number");
    }
    // sort order is by weekday then startTime
    const sorted = await c.put("/api/providers/me/availability", {
      availability: [
        { weekday: 2, startTime: "14:00", endTime: "15:00" },
        { weekday: 2, startTime: "08:00", endTime: "09:00" },
      ],
    });
    assert.deepEqual(
      sorted.body.availability.map((s) => s.startTime),
      ["08:00", "14:00"],
    );
  } finally {
    await app.close();
  }
});

test("PUT /api/providers/me/availability: replace semantics and empty clears", async () => {
  const { app } = await fresh();
  try {
    const c = client(app.url);
    await registerAs(c, app, { email: "replace@example.com", role: "provider" });
    await c.put("/api/providers/me/availability", {
      availability: [
        { weekday: 1, startTime: "09:00", endTime: "10:00" },
        { weekday: 2, startTime: "09:00", endTime: "10:00" },
      ],
    });
    const second = await c.put("/api/providers/me/availability", {
      availability: [{ weekday: 5, startTime: "12:00", endTime: "13:00" }],
    });
    assert.equal(second.body.availability.length, 1);
    assert.equal(second.body.availability[0].weekday, 5);

    // the store reflects only the replacement set
    const me = await c.get("/api/providers/me");
    assert.equal(me.body.availability.length, 1);
    assert.equal(me.body.availability[0].weekday, 5);

    // empty array clears everything
    const cleared = await c.put("/api/providers/me/availability", { availability: [] });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body.availability, []);
    assert.deepEqual((await c.get("/api/providers/me")).body.availability, []);
  } finally {
    await app.close();
  }
});

test("PUT /api/providers/me/availability: overlap rejected, adjacency and cross-weekday allowed", async () => {
  const { app } = await fresh();
  try {
    const c = client(app.url);
    await registerAs(c, app, { email: "ov@example.com", role: "provider" });

    const overlap = await c.put("/api/providers/me/availability", {
      availability: [
        { weekday: 1, startTime: "09:00", endTime: "11:00" },
        { weekday: 1, startTime: "10:00", endTime: "12:00" },
      ],
    });
    assert.equal(overlap.status, 400);
    assert.equal(overlap.body.error.code, "VALIDATION");

    // nested overlap (contained) also rejected
    const nested = await c.put("/api/providers/me/availability", {
      availability: [
        { weekday: 2, startTime: "09:00", endTime: "13:00" },
        { weekday: 2, startTime: "10:00", endTime: "11:00" },
      ],
    });
    assert.equal(nested.status, 400);

    // adjacent rows on the same weekday are fine
    const adjacent = await c.put("/api/providers/me/availability", {
      availability: [
        { weekday: 1, startTime: "09:00", endTime: "10:00" },
        { weekday: 1, startTime: "10:00", endTime: "11:00" },
      ],
    });
    assert.equal(adjacent.status, 200);
    assert.equal(adjacent.body.availability.length, 2);

    // the same hours on different weekdays are fine
    const crossDay = await c.put("/api/providers/me/availability", {
      availability: [
        { weekday: 1, startTime: "09:00", endTime: "10:00" },
        { weekday: 2, startTime: "09:00", endTime: "10:00" },
      ],
    });
    assert.equal(crossDay.status, 200);
    assert.equal(crossDay.body.availability.length, 2);
  } finally {
    await app.close();
  }
});

test("PUT /api/providers/me/availability: bounds validation", async () => {
  const { app } = await fresh();
  try {
    const c = client(app.url);
    await registerAs(c, app, { email: "bounds@example.com", role: "provider" });
    const put = (availability) => c.put("/api/providers/me/availability", { availability });

    const cases = [
      [{ weekday: 7, startTime: "09:00", endTime: "10:00" }], // weekday > 6
      [{ weekday: -1, startTime: "09:00", endTime: "10:00" }], // weekday < 0
      [{ weekday: 1, startTime: "09:30", endTime: "10:00" }], // not HH:00
      [{ weekday: 1, startTime: "9:00", endTime: "10:00" }], // not HH:00 (needs 2 digits)
      [{ weekday: 1, startTime: "24:00", endTime: "24:00" }], // start > 23 and start>=end
      [{ weekday: 1, startTime: "09:00", endTime: "09:00" }], // start >= end
      [{ weekday: 1, startTime: "11:00", endTime: "10:00" }], // start > end
      "not-an-array", // non-array
      null, // non-array
      Array.from({ length: 29 }, (_, i) => ({ weekday: 0, startTime: `${String(i % 23).padStart(2, "0")}:00`, endTime: `${String((i % 23) + 1).padStart(2, "0")}:00` })), // > 28 rows
    ];
    for (const availability of cases) {
      const r = await put(availability);
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(availability)}`);
      assert.equal(r.body.error.code, "VALIDATION");
    }

    // endTime 24:00 is allowed
    const ok = await put([{ weekday: 1, startTime: "23:00", endTime: "24:00" }]);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.availability.length, 1);
    assert.equal(ok.body.availability[0].endTime, "24:00");

    // a full 28-row week-day grid is accepted
    const full = Array.from({ length: 28 }, (_, i) => ({
      weekday: Math.floor(i / 4),
      startTime: `${String((i % 4) * 2).padStart(2, "0")}:00`,
      endTime: `${String((i % 4) * 2 + 2).padStart(2, "0")}:00`,
    }));
    assert.equal((await put(full)).status, 200);
    assert.equal((await put(full)).body.availability.length, 28);
  } finally {
    await app.close();
  }
});

test("PUT /api/providers/me/availability: 401 unauthenticated, 404 without provider row", async () => {
  const { app } = await fresh();
  try {
    // 401 with no session
    const anon = client(app.url);
    assert.equal((await anon.put("/api/providers/me/availability", { availability: [] })).status, 401);

    // 404 for a logged-in user with no provider row
    const c = client(app.url);
    await registerAs(c, app, { email: "av-noprov@example.com" });
    const r = await c.put("/api/providers/me/availability", { availability: [] });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "NOT_FOUND");
  } finally {
    await app.close();
  }
});
