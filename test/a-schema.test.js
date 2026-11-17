import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_SQL, migrate } from "../src/schema.js";
import { withPgTx } from "../src/db.js";

// A fake pg pool whose single client records every query it is handed.
// `handler` may throw to simulate a failing statement.
function fakePool(handler) {
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      return handler ? handler(sql) : { rows: [] };
    },
    release: () => calls.push("RELEASE"),
  };
  const pool = { connect: async () => client };
  return { pool, calls };
}

test("SCHEMA_SQL defines all five tables and the key constraints", () => {
  assert.ok(Array.isArray(SCHEMA_SQL));
  assert.ok(SCHEMA_SQL.length >= 5);
  const sql = SCHEMA_SQL.join("\n");
  for (const table of ["users", "providers", "availability", "bookings", "credit_ledger"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`), `missing table ${table}`);
  }

  const uniq = SCHEMA_SQL.find((s) => s.includes("bookings_provider_slot_uniq"));
  assert.ok(uniq, "bookings_provider_slot_uniq index is missing");
  assert.match(uniq, /ON bookings \(provider_id, starts_at\) WHERE status <> 'cancelled'/);

  assert.match(sql, /balance_after integer NOT NULL CHECK \(balance_after >= 0\)/);
});

test("migrate runs everything in one transaction under the advisory lock, then commits and releases", async () => {
  const { pool, calls } = fakePool();
  await migrate(pool);

  assert.equal(calls[0], "BEGIN");
  assert.equal(calls[1], "SELECT pg_advisory_xact_lock(7242024)");
  assert.deepEqual(calls.slice(2, 2 + SCHEMA_SQL.length), SCHEMA_SQL, "statements must run in order");
  assert.equal(calls[2 + SCHEMA_SQL.length], "COMMIT");
  assert.equal(calls[calls.length - 1], "RELEASE");
});

test("migrate rolls back, releases and rethrows when a statement fails", async () => {
  const boom = new Error("boom");
  const failing = SCHEMA_SQL[2];
  const { pool, calls } = fakePool((sql) => {
    if (sql === failing) throw boom;
    return { rows: [] };
  });

  await assert.rejects(migrate(pool), (err) => err === boom);
  assert.equal(calls[0], "BEGIN");
  assert.ok(calls.includes("ROLLBACK"), "ROLLBACK must be issued");
  assert.equal(calls[calls.indexOf("ROLLBACK") - 1], failing, "ROLLBACK follows the failing statement");
  assert.equal(calls[calls.length - 1], "RELEASE");
});

test("withPgTx commits on success and releases the client", async () => {
  const { pool, calls } = fakePool();
  const result = await withPgTx(pool, async () => "value");
  assert.equal(result, "value");
  assert.deepEqual(calls, ["BEGIN", "COMMIT", "RELEASE"]);
});

test("withPgTx rolls back, releases and rethrows when the callback throws", async () => {
  const { pool, calls } = fakePool();
  const boom = new Error("nope");
  await assert.rejects(
    withPgTx(pool, async () => {
      throw boom;
    }),
    (err) => err === boom,
  );
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK", "RELEASE"]);
});
