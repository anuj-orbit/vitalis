import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

test("GET /health returns ok without databases configured", async () => {
  delete process.env.DATABASE_URL;
  delete process.env.MONGODB_URI;
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.postgres, "not_configured");
  } finally {
    server.close();
  }
});

test("GET / serves the home page", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<html/i);
  } finally {
    server.close();
  }
});
