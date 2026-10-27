const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../src/config/database");
const {
  createPlanting,
  getPlantings,
  approvePlanting,
  rejectPlanting,
  verifyPlanting,
  markPlantingAsTestData,
} = require("../src/controllers/planting.controller");
const { requireAuth } = require("../src/middleware/auth.middleware");

const originalTransaction = prisma.$transaction;
const originalCreate = prisma.plantingRecord.create;
const originalFindMany = prisma.plantingRecord.findMany;
const originalCommerceSchemaFlag = process.env.COMMERCE_SCHEMA_ENABLED;

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
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

function installDatabase(rows) {
  const auditEntries = [];
  prisma.$transaction = async (callback) =>
    callback({
      plantingRecord: {
        async updateMany({ where, data }) {
          const row = rows.find((item) => item.id === where.id);
          if (
            !row ||
            (where.status && row.status !== where.status) ||
            (where.isTestData !== undefined &&
              row.isTestData !== where.isTestData) ||
            (where.verifiedAt === null && row.verifiedAt !== null) ||
            (where.verifiedById === null && row.verifiedById !== null) ||
            (where.submittedById?.not &&
              row.submittedById === where.submittedById.not) ||
            (where.reviewedById?.not &&
              row.reviewedById === where.reviewedById.not)
          ) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        },
        async findUnique({ where, select }) {
          const row = rows.find((item) => item.id === where.id);
          if (!row) return null;
          if (select) {
            return Object.fromEntries(
              Object.keys(select)
                .filter((key) => select[key])
                .map((key) => [key, row[key]])
            );
          }
          return { ...row };
        },
      },
      auditLog: {
        async create({ data }) {
          auditEntries.push(data);
          return data;
        },
      },
    });
  return auditEntries;
}

function request(id, role = "ADMIN", body = {}) {
  return {
    params: { id },
    body,
    user: { id: "reviewer-1", role, status: "ACTIVE" },
  };
}

function row(overrides = {}) {
  return {
    id: "planting-1",
    status: "PENDING",
    reviewedById: null,
    reviewedAt: null,
    rejectionReason: null,
    verifiedAt: null,
    verifiedById: null,
    isTestData: false,
    ...overrides,
  };
}

test.afterEach(() => {
  prisma.$transaction = originalTransaction;
  prisma.plantingRecord.create = originalCreate;
  prisma.plantingRecord.findMany = originalFindMany;
  if (originalCommerceSchemaFlag === undefined) delete process.env.COMMERCE_SCHEMA_ENABLED;
  else process.env.COMMERCE_SCHEMA_ENABLED = originalCommerceSchemaFlag;
});

test("authorized user approves a pending record and writes an audit entry", async () => {
  const rows = [row()];
  const audit = installDatabase(rows);
  const res = createResponse();

  await approvePlanting(request("planting-1"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(rows[0].status, "APPROVED");
  assert.equal(rows[0].reviewedById, "reviewer-1");
  assert.ok(rows[0].reviewedAt instanceof Date);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "PLANTING_APPROVED");
});

test("authorized user rejects pending record with trimmed reason", async () => {
  const rows = [row()];
  const audit = installDatabase(rows);
  const res = createResponse();

  await rejectPlanting(
    request("planting-1", "REVIEWER", { rejectionReason: "  insufficient evidence  " }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(rows[0].status, "REJECTED");
  assert.equal(rows[0].rejectionReason, "insufficient evidence");
  assert.equal(audit[0].action, "PLANTING_REJECTED");
});

test("rejection without a reason returns 400 without changing the record", async () => {
  const rows = [row()];
  installDatabase(rows);
  const res = createResponse();

  await rejectPlanting(request("planting-1", "ADMIN"), res);

  assert.equal(res.statusCode, 400);
  assert.equal(rows[0].status, "PENDING");
});

test("only review roles can approve or reject", async () => {
  for (const role of [
    "SUPER_ADMIN",
    "ADMIN",
    "PROGRAMME_MANAGER",
    "REVIEWER",
  ]) {
    const approvalRows = [row()];
    installDatabase(approvalRows);
    const approval = createResponse();
    await approvePlanting(request("planting-1", role), approval);
    assert.equal(approval.statusCode, 200, `${role} should approve`);

    const rejectionRows = [row()];
    installDatabase(rejectionRows);
    const rejection = createResponse();
    await rejectPlanting(
      request("planting-1", role, { rejectionReason: "not acceptable" }),
      rejection
    );
    assert.equal(rejection.statusCode, 200, `${role} should reject`);
  }

  for (const role of ["DATA_ENTRY_OFFICER", "REPORT_VIEWER"]) {
    const rows = [row()];
    installDatabase(rows);
    const approval = createResponse();
    await approvePlanting(request("planting-1", role), approval);
    assert.equal(approval.statusCode, 403, `${role} approval should be denied`);
    assert.equal(rows[0].status, "PENDING");

    const rejection = createResponse();
    await rejectPlanting(
      request("planting-1", role, { rejectionReason: "not allowed" }),
      rejection
    );
    assert.equal(rejection.statusCode, 403, `${role} rejection should be denied`);
    assert.equal(rows[0].status, "PENDING");
  }
});

test("unauthenticated requests receive 401 from the existing auth middleware", async () => {
  const req = { headers: {} };
  const res = createResponse();
  let nextCalled = false;

  await requireAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("invalid bearer token receives 401 from the existing auth middleware", async () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "unit-test-secret";
  const req = { headers: { authorization: "Bearer invalid-token" } };
  const res = createResponse();
  let nextCalled = false;

  try {
    await requireAuth(req, res, () => {
      nextCalled = true;
    });
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("missing planting records return 404", async () => {
  installDatabase([]);
  const res = createResponse();

  await approvePlanting(request("missing"), res);

  assert.equal(res.statusCode, 404);
});

test("duplicate and conflicting reviews return 409 without overwriting review data", async () => {
  const reviewedAt = new Date("2028-01-01T00:00:00.000Z");
  const rows = [
    row({
      status: "APPROVED",
      reviewedById: "first-reviewer",
      reviewedAt,
    }),
  ];
  installDatabase(rows);
  const approval = createResponse();
  await approvePlanting(request("planting-1"), approval);
  assert.equal(approval.statusCode, 409);
  assert.equal(rows[0].reviewedById, "first-reviewer");
  assert.equal(rows[0].reviewedAt, reviewedAt);

  const rejection = createResponse();
  await rejectPlanting(
    request("planting-1", "ADMIN", { rejectionReason: "not valid" }),
    rejection
  );
  assert.equal(rejection.statusCode, 409);
  assert.equal(rows[0].reviewedById, "first-reviewer");
  assert.equal(rows[0].reviewedAt, reviewedAt);
});

test("a rejected record cannot later be approved", async () => {
  const reviewedAt = new Date("2028-01-01T00:00:00.000Z");
  const rows = [
    row({
      status: "REJECTED",
      rejectionReason: "invalid evidence",
      reviewedById: "first-reviewer",
      reviewedAt,
    }),
  ];
  installDatabase(rows);
  const res = createResponse();

  await approvePlanting(request("planting-1"), res);

  assert.equal(res.statusCode, 409);
  assert.equal(rows[0].status, "REJECTED");
  assert.equal(rows[0].reviewedById, "first-reviewer");
  assert.equal(rows[0].reviewedAt, reviewedAt);
  assert.equal(rows[0].rejectionReason, "invalid evidence");
});

test("a record cannot be rejected after approval", async () => {
  const rows = [row({ status: "APPROVED", reviewedById: "first-reviewer" })];
  installDatabase(rows);
  const res = createResponse();

  await rejectPlanting(
    request("planting-1", "ADMIN", { rejectionReason: "late rejection" }),
    res
  );

  assert.equal(res.statusCode, 409);
  assert.equal(rows[0].status, "APPROVED");
  assert.equal(rows[0].reviewedById, "first-reviewer");
});

test("concurrent approval and rejection produce one state transition", async () => {
  const rows = [row()];
  const audit = installDatabase(rows);
  const approval = createResponse();
  const rejection = createResponse();

  await Promise.all([
    approvePlanting(request("planting-1", "ADMIN"), approval),
    rejectPlanting(
      request("planting-1", "REVIEWER", { rejectionReason: "duplicate" }),
      rejection
    ),
  ]);

  assert.deepEqual(
    [approval.statusCode, rejection.statusCode].sort(),
    [200, 409]
  );
  assert.equal(audit.length, 1);
  assert.ok(["APPROVED", "REJECTED"].includes(rows[0].status));
});

test("verification is separate from approval and excludes test data", async () => {
  const rows = [
    row({ status: "APPROVED" }),
    row({ id: "test-row", status: "APPROVED", isTestData: true }),
  ];
  const audit = installDatabase(rows);
  const verified = createResponse();

  await verifyPlanting(
    request("planting-1", "PROGRAMME_MANAGER", {
      verificationNotes: "Evidence reviewed against the submitted planting record.",
    }),
    verified
  );
  assert.equal(verified.statusCode, 200);
  assert.equal(rows[0].verifiedById, "reviewer-1");
  assert.ok(rows[0].verifiedAt instanceof Date);
  assert.equal(audit[0].action, "PLANTING_VERIFIED");

  const testRow = createResponse();
  await verifyPlanting(
    request("test-row", "ADMIN", { verificationNotes: "Checked" }),
    testRow
  );
  assert.equal(testRow.statusCode, 409);
  assert.equal(rows[1].isTestData, true);
});

test("only super admins and admins can mark test data, without changing status", async () => {
  const rows = [row({ status: "APPROVED", verifiedAt: new Date(), verifiedById: "reviewer-2" })];
  const audit = installDatabase(rows);
  const denied = createResponse();
  await markPlantingAsTestData(
    request("planting-1", "REVIEWER", { reason: "API fixture" }),
    denied
  );
  assert.equal(denied.statusCode, 403);

  const marked = createResponse();
  await markPlantingAsTestData(
    request("planting-1", "ADMIN", { reason: "API fixture" }),
    marked
  );
  assert.equal(marked.statusCode, 200);
  assert.equal(rows[0].status, "APPROVED");
  assert.equal(rows[0].isTestData, true);
  assert.equal(rows[0].verifiedAt, null);
  assert.equal(audit.length, 1);
});

test("existing planting GET and POST handlers remain available", async () => {
  prisma.plantingRecord.findMany = async () => [{ id: "planting-1" }];
  const getRes = createResponse();
  await getPlantings({}, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.count, 1);

  let audit;
  let plantingSelect;
  prisma.$transaction = async (callback) =>
    callback({
      plantingRecord: {
        async create({ data, select }) {
          plantingSelect = select;
          return { id: "new", ...data };
        },
      },
      auditLog: {
        async create({ data }) {
          audit = data;
        },
      },
    });
  const postRes = createResponse();
  await createPlanting(
    {
      user: { id: "submitter-1", role: "DATA_ENTRY_OFFICER" },
      body: { quantity: 2, plantingDate: "2028-01-03" },
    },
    postRes
  );
  assert.equal(postRes.statusCode, 201);
  assert.equal(postRes.body.planting.status, "PENDING");
  assert.equal(plantingSelect.treeOrderId, undefined);
  assert.equal(plantingSelect.treeDonationId, undefined);
  assert.equal(audit.action, "PLANTING_SUBMITTED");
});

test("planting submission rejects report-only users and malformed evidence", async () => {
  const denied = createResponse();
  await createPlanting(
    {
      user: { id: "reporter-1", role: "REPORT_VIEWER" },
      body: { quantity: 2, plantingDate: "2028-01-03" },
    },
    denied
  );
  assert.equal(denied.statusCode, 403);

  for (const body of [
    { quantity: 2147483648, plantingDate: "2028-01-03" },
    { quantity: 2, plantingDate: "2028-02-30" },
    { quantity: 2, plantingDate: "2028-01-03", latitude: " ", longitude: " " },
    { quantity: 2, plantingDate: "2028-01-03", photoUrls: "not-an-array" },
    { quantity: 2, plantingDate: "2028-01-03", photoUrls: ["javascript:alert(1)"] },
  ]) {
    const invalid = createResponse();
    await createPlanting(
      {
        user: { id: "submitter-1", role: "DATA_ENTRY_OFFICER" },
        body,
      },
      invalid
    );
    assert.equal(invalid.statusCode, 400);
  }
});

test("commerce planting links require an authorized role and a paid, reviewed checkout", async () => {
  process.env.COMMERCE_SCHEMA_ENABLED = "true";
  const denied = createResponse();
  await createPlanting(
    {
      user: { id: "submitter-1", role: "DATA_ENTRY_OFFICER" },
      body: {
        quantity: 2,
        plantingDate: "2028-01-03",
        speciesId: "species-1",
        treeOrderId: "order-1",
      },
    },
    denied
  );
  assert.equal(denied.statusCode, 403);

  prisma.$transaction = async (callback) => callback({
    treeOrder: {
      async updateMany() {
        return { count: 0 };
      },
    },
  });
  const unpaid = createResponse();
  await createPlanting(
    {
      user: { id: "manager-1", role: "PROGRAMME_MANAGER" },
      body: {
        quantity: 2,
        plantingDate: "2028-01-03",
        speciesId: "species-1",
        treeOrderId: "order-1",
      },
    },
    unpaid
  );
  assert.equal(unpaid.statusCode, 400);
});

test("commerce links stay disabled until the reviewed database schema is applied", async () => {
  delete process.env.COMMERCE_SCHEMA_ENABLED;
  let transactions = 0;
  prisma.$transaction = async () => {
    transactions += 1;
  };
  const res = createResponse();
  await createPlanting(
    {
      user: { id: "admin-1", role: "ADMIN" },
      body: {
        quantity: 1,
        plantingDate: "2028-01-03",
        speciesId: "species-1",
        treeDonationId: "donation-1",
      },
    },
    res
  );
  assert.equal(res.statusCode, 503);
  assert.equal(transactions, 0);
});

test("paid, approved orders can only be linked up to their remaining species quantity", async () => {
  process.env.COMMERCE_SCHEMA_ENABLED = "true";
  let createdData;
  let orderStatusUpdate;
  prisma.$transaction = async (callback) => callback({
    treeOrder: {
      async updateMany({ where, data }) {
        if (where.locationReviewStatus === "APPROVED") return { count: 1 };
        orderStatusUpdate = data;
        return { count: 1 };
      },
      async findUnique() {
        return {
          id: "order-1",
          items: [{ speciesId: "species-1", quantity: 5 }],
        };
      },
      async update() {},
    },
    plantingRecord: {
      async findMany() {
        return [{ speciesId: "species-1", quantity: 2 }];
      },
      async create({ data }) {
        createdData = data;
        return {
          id: "planting-commerce-1",
          ...data,
          plantingDate: new Date("2028-01-03"),
        };
      },
    },
    auditLog: {
      async create() {},
    },
  });
  const res = createResponse();
  await createPlanting(
    {
      user: { id: "manager-1", role: "PROGRAMME_MANAGER" },
      body: {
        quantity: 3,
        plantingDate: "2028-01-03",
        speciesId: "species-1",
        treeOrderId: "order-1",
      },
    },
    res
  );

  assert.equal(res.statusCode, 201);
  assert.equal(createdData.treeOrderId, "order-1");
  assert.equal(createdData.treeDonationId, undefined);
  assert.equal(orderStatusUpdate.status, "PROCESSING");
});
