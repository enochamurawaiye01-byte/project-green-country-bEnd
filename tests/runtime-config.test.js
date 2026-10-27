const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCorsOrigins, validateRuntimeConfig } = require("../src/config/runtime-config");

const valid = {
  DATABASE_URL: "postgresql://example.invalid/database",
  JWT_SECRET: "x".repeat(40),
  NODE_ENV: "production",
  PORT: "10000",
  CORS_ORIGINS: "https://frontend.example.org,https://admin.example.org",
};

test("runtime config accepts Render-compatible production settings", () => {
  assert.deepEqual(validateRuntimeConfig(valid), { port: 10000 });
});

test("runtime config rejects missing secrets and weak JWT keys without echoing values", () => {
  assert.throws(
    () => validateRuntimeConfig({ NODE_ENV: "production" }),
    /DATABASE_URL, JWT_SECRET/
  );
  assert.throws(
    () => validateRuntimeConfig({ ...valid, JWT_SECRET: "not-a-safe-key" }),
    /at least 32 characters/
  );
});

test("production requires HTTPS CORS origins and a valid port", () => {
  assert.throws(
    () => validateRuntimeConfig({ ...valid, CORS_ORIGINS: "" }),
    /CORS_ORIGINS/
  );
  assert.throws(
    () => validateRuntimeConfig({ ...valid, CORS_ORIGINS: "http://frontend.example.org" }),
    /HTTPS/
  );
  assert.throws(
    () => validateRuntimeConfig({ ...valid, PORT: "70000" }),
    /PORT/
  );
});

test("CORS origins reject paths, credentials, and non-HTTP protocols", () => {
  assert.throws(() => parseCorsOrigins("https://frontend.example.org/path"), /origins/);
  assert.throws(() => parseCorsOrigins("https://name:password@frontend.example.org"), /origins/);
  assert.throws(() => parseCorsOrigins("javascript:alert(1)"), /origins/);
});
