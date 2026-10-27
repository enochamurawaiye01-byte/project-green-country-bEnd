const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../src/app");
const { prisma } = require("../src/config/database");

const originalFindUnique = prisma.user.findUnique;
const originalJwtSecret = process.env.JWT_SECRET;

test.after(() => {
  prisma.user.findUnique = originalFindUnique;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

test("login is rate-limited by client IP without blocking successful logins", async () => {
  prisma.user.findUnique = async () => null;
  process.env.JWT_SECRET = "unit-test-only-secret";
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/api/auth/login`;
    const responses = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      responses.push(
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "unknown@example.org", password: "bad-password" }),
        })
      );
    }

    assert.equal(responses[0].status, 401);
    assert.match(responses[0].headers.get("ratelimit-policy"), /10-in-15min/i);
    assert.equal(responses[10].status, 429);
    const body = await responses[10].json();
    assert.match(body.message, /too many login attempts/i);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
