const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../src/app");
const { prisma } = require("../src/config/database");
const {
  createGrowthUpdate,
  listPublicByPlantingRecord,
  getPublicGrowthUpdate,
  getGrowthUpdate,
  approveGrowthUpdate,
  rejectGrowthUpdate,
} = require("../src/controllers/growth-update.controller");

const originalGrowthCreate = prisma.growthUpdate.create;
const originalGrowthFindMany = prisma.growthUpdate.findMany;
const originalGrowthFindUnique = prisma.growthUpdate.findUnique;
const originalGrowthFindFirst = prisma.growthUpdate.findFirst;
const originalPlantingFindUnique = prisma.plantingRecord.findUnique;
const originalLocationFindUnique = prisma.plantingLocation.findUnique;
const originalTransaction = prisma.$transaction;

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

function request(body = {}, role = "DATA_ENTRY_OFFICER", id = "growth-1") {
  return {
    params: { id, plantingRecordId: "planting-1", locationId: "location-1" },
    body,
    user: { id: "user-1", role, status: "ACTIVE" },
  };
}

function validInput(overrides = {}) {
  return {
    plantingRecordId: "planting-1",
    locationId: "location-1",
    observationDate: "2026-10-22T10:00:00.000Z",
    growthStage: "EARLY_GROWTH",
    condition: "HEALTHY",
    treesInspected: 10,
    treesSurviving: 8,
    treesDead: 2,
    averageHeightCm: 25.5,
    notes: "Healthy growth observed.",
    photoUrls: ["https://example.org/growth.jpg"],
    latitude: 8.5,
    longitude: 4.55,
    ...overrides,
  };
}

test.afterEach(() => {
  prisma.growthUpdate.create = originalGrowthCreate;
  prisma.growthUpdate.findMany = originalGrowthFindMany;
  prisma.growthUpdate.findUnique = originalGrowthFindUnique;
  prisma.growthUpdate.findFirst = originalGrowthFindFirst;
  prisma.plantingRecord.findUnique = originalPlantingFindUnique;
  prisma.plantingLocation.findUnique = originalLocationFindUnique;
  prisma.$transaction = originalTransaction;
});

test("authenticated authorized user can submit a valid observation", async () => {
  prisma.plantingRecord.findUnique = async () => ({
    id: "planting-1",
    locationId: "location-1",
  });
  prisma.plantingLocation.findUnique = async () => ({ id: "location-1" });
  prisma.growthUpdate.create = async ({ data }) => ({ id: "growth-1", ...data });
  const res = response();

  await createGrowthUpdate(request(validInput()), res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.growthUpdate.submittedById, "user-1");
  assert.equal(res.body.growthUpdate.status, "PENDING");
  assert.equal(res.body.growthUpdate.isPublic, false);
  assert.equal(res.body.growthUpdate.treesInspected, 10);
});

test("negative, impossible counts and invalid coordinates are rejected", async () => {
  for (const input of [
    validInput({ treesInspected: -1 }),
    validInput({ treesInspected: 2147483648 }),
    validInput({ treesSurviving: 9, treesDead: 2 }),
    validInput({ treesSurviving: -1, treesDead: 1 }),
    validInput({ latitude: 91 }),
    validInput({ longitude: 181 }),
    validInput({ latitude: 8, longitude: "" }),
    validInput({ latitude: " ", longitude: " " }),
    validInput({ averageHeightCm: " " }),
  ]) {
    const res = response();
    await createGrowthUpdate(request(input), res);
    assert.equal(res.statusCode, 400);
  }
});

test("future dates, invalid enum values and invalid photo URLs are rejected", async () => {
  const cases = [
    validInput({ observationDate: "2999-01-01T00:00:00.000Z" }),
    validInput({ observationDate: "2026-02-30" }),
    validInput({ growthStage: "VERY_MATURE" }),
    validInput({ condition: "UNKNOWN" }),
    validInput({ photoUrls: ["not-a-url"] }),
  ];
  for (const input of cases) {
    const res = response();
    await createGrowthUpdate(request(input), res);
    assert.equal(res.statusCode, 400);
  }
});

test("missing planting and location references return 404", async () => {
  prisma.plantingRecord.findUnique = async () => null;
  const res = response();

  await createGrowthUpdate(request(validInput()), res);

  assert.equal(res.statusCode, 404);
});

test("planting record cannot be paired with a different location", async () => {
  prisma.plantingRecord.findUnique = async () => ({
    id: "planting-1",
    locationId: "different-location",
  });
  prisma.plantingLocation.findUnique = async () => ({ id: "location-1" });
  const res = response();

  await createGrowthUpdate(request(validInput()), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, "INVALID_GROWTH_UPDATE");
  assert.match(res.body.error.message, /must match/i);
});

test("planting record without a location cannot be paired with an unrelated location", async () => {
  prisma.plantingRecord.findUnique = async () => ({
    id: "planting-1",
    locationId: null,
  });
  const res = response();

  await createGrowthUpdate(request(validInput()), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error.message, /must match/i);
});

test("read-only report viewer cannot submit a growth update", async () => {
  const res = response();

  await createGrowthUpdate(request(validInput(), "REPORT_VIEWER"), res);

  assert.equal(res.statusCode, 403);
});

test("growth submission route requires the existing bearer authentication", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const address = server.address();
    const result = await fetch(
      `http://127.0.0.1:${address.port}/api/growth-updates`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validInput()),
      }
    );
    assert.equal(result.status, 401);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("public lists return only approved public updates with safe selected fields", async () => {
  let query;
  prisma.growthUpdate.findMany = async (args) => {
    query = args;
    return [{ id: "growth-1", status: "APPROVED", isPublic: true }];
  };
  const res = response();

  await listPublicByPlantingRecord(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(query.where.status, "APPROVED");
  assert.equal(query.where.isPublic, true);
  assert.equal(query.where.AND.length, 3);
  assert.equal(
    query.where.AND[0].OR[1].plantingRecord.is.verifiedById.not,
    null
  );
  assert.equal(
    query.where.AND[1].OR[1].location.is.isPublic,
    true
  );
  assert.equal(query.where.AND[2].OR[0].plantingRecordId.not, null);
  assert.equal(query.where.AND[2].OR[1].locationId.not, null);
  assert.equal(query.select.submittedById, undefined);
  assert.equal(query.select.reviewedById, undefined);
  assert.equal(query.select.rejectionReason, undefined);
  assert.equal(query.select.latitude, undefined);
  assert.equal(query.select.longitude, undefined);
});

test("private growth update detail returns 404 when it is not public", async () => {
  prisma.growthUpdate.findFirst = async (args) => {
    assert.equal(args.where.status, "APPROVED");
    assert.equal(args.where.isPublic, true);
    return null;
  };
  const res = response();

  await getPublicGrowthUpdate(request(), res);

  assert.equal(res.statusCode, 404);
});

test("data-entry users cannot read another user's pending update detail", async () => {
  prisma.growthUpdate.findUnique = async () => ({
    id: "growth-1",
    submittedById: "different-user",
    status: "PENDING",
  });
  const res = response();

  await getGrowthUpdate(request({}, "DATA_ENTRY_OFFICER"), res);

  assert.equal(res.statusCode, 403);
});

test("authorized review approves as public and writes an audit event", async () => {
  let updateData;
  let auditData;
  prisma.$transaction = async (callback) =>
    callback({
      growthUpdate: {
        async updateMany({ where, data }) {
          assert.equal(where.status, "PENDING");
          updateData = data;
          return { count: 1 };
        },
        async findUnique() {
          return { id: "growth-1", ...updateData };
        },
      },
      auditLog: {
        async create({ data }) {
          auditData = data;
        },
      },
    });
  const res = response();

  await approveGrowthUpdate(
    request({ isPublic: true, reviewNotes: "Suitable for public display." }, "REVIEWER"),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(updateData.status, "APPROVED");
  assert.equal(updateData.reviewedById, "user-1");
  assert.equal(updateData.isPublic, true);
  assert.equal(auditData.action, "GROWTH_UPDATE_APPROVED");
});

test("rejection requires a reason and conflicting transitions return 409", async () => {
  const noReason = response();
  await rejectGrowthUpdate(request({}, "ADMIN"), noReason);
  assert.equal(noReason.statusCode, 400);

  prisma.$transaction = async (callback) =>
    callback({
      growthUpdate: {
        async updateMany() {
          return { count: 0 };
        },
        async findUnique() {
          return { id: "growth-1", status: "APPROVED" };
        },
      },
      auditLog: {
        async create() {
          assert.fail("No audit entry for a failed transition.");
        },
      },
    });
  const conflict = response();
  await approveGrowthUpdate(request({}, "ADMIN"), conflict);
  assert.equal(conflict.statusCode, 409);
});
