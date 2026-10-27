const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const app = require("../src/app");
const { prisma } = require("../src/config/database");
const { requireAuth } = require("../src/middleware/auth.middleware");
const {
  login,
  createAccount,
} = require("../src/controllers/auth.controller");

const originalTransaction = prisma.$transaction;
const originalFindUnique = prisma.user.findUnique;
const originalUpdate = prisma.user.update;
const originalHash = bcrypt.hash;
const originalCompare = bcrypt.compare;
const originalJwtSecret = process.env.JWT_SECRET;
const TEST_JWT_SECRET = "auth-account-tests-only-secret";

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function request(body, role = "ADMIN") {
  return {
    body,
    ip: "127.0.0.1",
    user: { id: "actor-1", role },
    get(name) {
      return name.toLowerCase() === "user-agent" ? "test-agent" : undefined;
    },
  };
}

function validAccount(overrides = {}) {
  return {
    fullName: "Field Reviewer",
    email: "  REVIEWER@example.org ",
    password: "a-secure-password",
    role: "REVIEWER",
    ...overrides,
  };
}

test.afterEach(() => {
  prisma.$transaction = originalTransaction;
  prisma.user.findUnique = originalFindUnique;
  prisma.user.update = originalUpdate;
  bcrypt.hash = originalHash;
  bcrypt.compare = originalCompare;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

test("existing administrator login still verifies the password and returns a bearer token", async () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  const passwordHash = await bcrypt.hash("correct-horse-battery", 4);
  const user = {
    id: "existing-super-admin",
    fullName: "Existing Super Admin",
    email: "admin@example.org",
    passwordHash,
    role: "SUPER_ADMIN",
    status: "ACTIVE",
  };
  let lastLoginUpdate;
  prisma.user.findUnique = async ({ where }) => {
    assert.deepEqual(where, { email: "admin@example.org" });
    return user;
  };
  prisma.user.update = async ({ data }) => {
    lastLoginUpdate = data;
  };

  const res = response();
  await login(
    { body: { email: " ADMIN@example.org ", password: "correct-horse-battery" } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.id, "existing-super-admin");
  assert.equal(res.body.user.role, "SUPER_ADMIN");
  assert.equal(res.body.user.passwordHash, undefined);
  assert.equal(jwt.verify(res.body.token, TEST_JWT_SECRET).sub, user.id);
  assert.ok(lastLoginUpdate.lastLoginAt instanceof Date);

  const invalidPassword = response();
  await login(
    { body: { email: user.email, password: "incorrect-password" } },
    invalidPassword
  );
  assert.equal(invalidPassword.statusCode, 401);
});

test("admin account creation hashes passwords, returns safe fields, and writes an audit log", async () => {
  let createData;
  let createSelect;
  let auditData;
  let hashRounds;
  bcrypt.hash = async (password, rounds) => {
    hashRounds = rounds;
    return `hashed:${password}`;
  };
  prisma.$transaction = async (callback) =>
    callback({
      user: {
        async create({ data, select }) {
          createData = data;
          createSelect = select;
          return {
            id: "new-user",
            fullName: data.fullName,
            email: data.email,
            phone: data.phone,
            role: data.role,
            status: data.status,
            createdAt: new Date("2026-10-28T00:00:00.000Z"),
          };
        },
      },
      auditLog: {
        async create({ data }) {
          auditData = data;
        },
      },
    });

  const res = response();
  await createAccount(request(validAccount({ phone: "+234 800 000 0000" })), res);

  assert.equal(res.statusCode, 201);
  assert.equal(createData.email, "reviewer@example.org");
  assert.equal(createData.passwordHash, "hashed:a-secure-password");
  assert.equal(hashRounds, 12);
  assert.equal(createData.role, "REVIEWER");
  assert.equal(createData.status, "ACTIVE");
  assert.equal(createSelect.passwordHash, undefined);
  assert.equal(res.body.user.passwordHash, undefined);
  assert.equal(auditData.actorId, "actor-1");
  assert.equal(auditData.action, "USER_ACCOUNT_CREATED");
  assert.equal(auditData.entityType, "User");
  assert.deepEqual(auditData.metadata, {
    email: "reviewer@example.org",
    role: "REVIEWER",
  });
});

test("only Super Admins can grant SUPER_ADMIN or ADMIN roles", async () => {
  let transactionCalls = 0;
  prisma.$transaction = async () => {
    transactionCalls += 1;
    throw new Error("Unexpected transaction");
  };

  for (const role of ["ADMIN", "PROGRAMME_MANAGER", "REPORT_VIEWER"]) {
    const res = response();
    await createAccount(request(validAccount({ role: "SUPER_ADMIN" }), role), res);
    assert.equal(res.statusCode, 403, `${role} must not grant SUPER_ADMIN`);
  }

  const adminRole = response();
  await createAccount(request(validAccount({ role: "ADMIN" }), "ADMIN"), adminRole);
  assert.equal(adminRole.statusCode, 403);
  assert.equal(adminRole.body.error.code, "ROLE_NOT_PERMITTED");
  assert.equal(transactionCalls, 0);

  let createdRole;
  prisma.$transaction = async (callback) =>
    callback({
      user: {
        async create({ data }) {
          createdRole = data.role;
          return {
            id: "new-super-admin",
            fullName: data.fullName,
            email: data.email,
            phone: null,
            role: data.role,
            status: data.status,
            createdAt: new Date(),
          };
        },
      },
      auditLog: { async create() {} },
    });
  const superAdmin = response();
  await createAccount(
    request(validAccount({ role: "SUPER_ADMIN" }), "SUPER_ADMIN"),
    superAdmin
  );
  assert.equal(superAdmin.statusCode, 201);
  assert.equal(createdRole, "SUPER_ADMIN");
});

test("account creation rejects invalid input and mass-assigned fields", async () => {
  let transactionCalled = false;
  prisma.$transaction = async () => {
    transactionCalled = true;
    throw new Error("Invalid input must not reach persistence");
  };

  const invalidRequests = [
    validAccount({ email: "not-an-email" }),
    validAccount({ password: "short" }),
    validAccount({ role: "COMMUNITY_MEMBER" }),
    validAccount({ isSuperAdmin: true }),
    { fullName: "Missing role", email: "valid@example.org", password: "long-enough-password" },
  ];

  for (const body of invalidRequests) {
    const res = response();
    await createAccount(request(body), res);
    assert.ok([400, 403].includes(res.statusCode));
  }
  assert.equal(transactionCalled, false);
});

test("duplicate email returns conflict without leaking account data", async () => {
  prisma.$transaction = async () => {
    const error = new Error("Unique constraint");
    error.code = "P2002";
    throw error;
  };
  const res = response();

  await createAccount(request(validAccount()), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, "EMAIL_ALREADY_EXISTS");
  assert.equal(res.body.user, undefined);
});

test("public registration is disabled and account creation requires authentication", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const registration = await fetch(`${origin}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validAccount()),
    });
    assert.equal(registration.status, 404);
    assert.equal((await registration.json()).error.code, "NOT_FOUND");

    const accountCreation = await fetch(`${origin}/api/auth/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validAccount()),
    });
    assert.equal(accountCreation.status, 401);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("account permissions use the current database role, not the JWT role claim", async () => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  prisma.user.findUnique = async ({ where }) => ({
    id: where.id,
    fullName: "Current Administrator",
    email: "admin@example.org",
    role: "ADMIN",
    status: "ACTIVE",
  });
  const token = jwt.sign(
    { sub: "admin-1", role: "SUPER_ADMIN" },
    TEST_JWT_SECRET,
    { expiresIn: "5m" }
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const address = server.address();
    const res = await fetch(`http://127.0.0.1:${address.port}/api/auth/accounts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validAccount({ role: "SUPER_ADMIN" })),
    });

    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, "ROLE_NOT_PERMITTED");
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("authentication fails safely when JWT configuration is missing", async () => {
  delete process.env.JWT_SECRET;
  const res = response();
  let nextCalled = false;

  await requireAuth(
    { headers: { authorization: "Bearer token" } },
    res,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.message, "Authentication is not configured.");
  assert.equal(nextCalled, false);
});
