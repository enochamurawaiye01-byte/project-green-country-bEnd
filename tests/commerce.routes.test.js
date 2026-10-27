const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../src/app");

const originalCommerceSchemaFlag = process.env.COMMERCE_SCHEMA_ENABLED;
let server;
let origin;

test.before(async () => {
  delete process.env.COMMERCE_SCHEMA_ENABLED;
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  if (originalCommerceSchemaFlag === undefined) delete process.env.COMMERCE_SCHEMA_ENABLED;
  else process.env.COMMERCE_SCHEMA_ENABLED = originalCommerceSchemaFlag;
});

test("commerce API stays explicitly unavailable until the database schema is enabled", async () => {
  for (const [path, method] of [
    ["/api/trees", "GET"],
    ["/api/orders", "POST"],
    ["/api/donations", "POST"],
  ]) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: method === "POST" ? { "content-type": "application/json" } : {},
      body: method === "POST" ? "{}" : undefined,
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error.code, "COMMERCE_SCHEMA_UNAVAILABLE");
  }
});

test("health endpoint returns liveness only", async () => {
  const response = await fetch(`${origin}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, status: "ok" });
});

test("admin catalogue remains protected by authentication before the schema gate", async () => {
  const response = await fetch(`${origin}/api/trees/admin`);
  assert.equal(response.status, 401);
});

test("malformed and oversized JSON receive explicit client errors", async () => {
  const malformed = await fetch(`${origin}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "INVALID_JSON");

  const oversized = await fetch(`${origin}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(102400) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "REQUEST_TOO_LARGE");
});
