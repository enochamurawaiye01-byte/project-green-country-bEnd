const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../src/config/database");
const {
  getAll: listLocations,
  createLocation,
} = require("../src/controllers/location.controller");
const {
  getAll: listTargets,
  createTarget,
  updateTarget,
} = require("../src/controllers/target.controller");

const originalLocationFindMany = prisma.plantingLocation.findMany;
const originalLocationCreate = prisma.plantingLocation.create;
const originalLocationFindFirst = prisma.plantingLocation.findFirst;
const originalTargetFindMany = prisma.target.findMany;
const originalTargetCreate = prisma.target.create;
const originalTargetFindUnique = prisma.target.findUnique;
const originalTargetUpdate = prisma.target.update;
const originalPlantingAggregate = prisma.plantingRecord.aggregate;
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

function request(body = {}, role = "ADMIN") {
  return {
    params: { id: "target-1" },
    body,
    user: { id: "user-1", role },
  };
}

test.afterEach(() => {
  prisma.plantingLocation.findMany = originalLocationFindMany;
  prisma.plantingLocation.create = originalLocationCreate;
  prisma.plantingLocation.findFirst = originalLocationFindFirst;
  prisma.target.findMany = originalTargetFindMany;
  prisma.target.create = originalTargetCreate;
  prisma.target.findUnique = originalTargetFindUnique;
  prisma.target.update = originalTargetUpdate;
  prisma.plantingRecord.aggregate = originalPlantingAggregate;
  prisma.$transaction = originalTransaction;
});

test("public location listing filters out private locations", async () => {
  let query;
  prisma.plantingLocation.findMany = async (args) => {
    query = args;
    return [{ id: "location-1", isPublic: true }];
  };
  const res = response();

  await listLocations(request(), res);

  assert.deepEqual(query.where, { isPublic: true });
  assert.equal(res.statusCode, 200);
});

test("location creation validates coordinates and audits authorized creation", async () => {
  const badCoordinates = response();
  await createLocation(
    request({ name: "Farm", slug: "farm", latitude: 8.2 }),
    badCoordinates
  );
  assert.equal(badCoordinates.statusCode, 400);

  let audit;
  let selectedFields;
  prisma.$transaction = async (callback) =>
    callback({
      plantingLocation: {
        async create({ data, select }) {
          selectedFields = select;
          return { id: "location-1", ...data };
        },
      },
      auditLog: {
        async create({ data }) {
          audit = data;
        },
      },
    });
  const res = response();
  await createLocation(request({ name: "Farm", slug: "farm" }), res);

  assert.equal(res.statusCode, 201);
  assert.equal(selectedFields.createdById, undefined);
  assert.equal(res.body.location.isPublic, true);
  assert.equal(audit.action, "PLANTING_LOCATION_CREATED");
});

test("location management rejects non-manager roles", async () => {
  const res = response();
  await createLocation(request({ name: "Farm", slug: "farm" }, "REVIEWER"), res);
  assert.equal(res.statusCode, 403);
});

test("target listing permits report viewers but remains authenticated", async () => {
  let count = 0;
  prisma.target.findMany = async () => {
    count += 1;
    return [];
  };
  const res = response();

  await listTargets(request({}, "REPORT_VIEWER"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(count, 1);
});

test("target progress counts only eligible verified planting records", async () => {
  prisma.target.findMany = async () => [{
    id: "target-1",
    startDate: new Date("2026-10-01T00:00:00Z"),
    endDate: new Date("2026-10-31T00:00:00Z"),
    targetQuantity: 100,
    locationId: "location-1",
    speciesId: "species-1",
  }];
  let where;
  prisma.plantingRecord.aggregate = async (args) => {
    where = args.where;
    return { _sum: { quantity: 25 }, _count: { _all: 4 } };
  };
  const res = response();
  await listTargets(request({}, "REPORT_VIEWER"), res);

  assert.equal(where.status, "APPROVED");
  assert.equal(where.isTestData, false);
  assert.deepEqual(where.verifiedAt, { not: null });
  assert.equal(where.locationId, "location-1");
  assert.equal(where.speciesId, "species-1");
  assert.equal(res.body.targets[0].progress.plantedQuantity, 25);
  assert.equal(res.body.targets[0].progress.remainingQuantity, 75);
  assert.equal(res.body.targets[0].progress.percentageCompleted, 25);
});

test("target creation requires a valid positive quantity and records an audit event", async () => {
  const invalid = response();
  await createTarget(
    request({
      name: "Weekly target",
      period: "WEEKLY",
      targetQuantity: -1,
      startDate: "2026-10-19",
      endDate: "2026-10-25",
    }),
    invalid
  );
  assert.equal(invalid.statusCode, 400);

  let audit;
  prisma.$transaction = async (callback) =>
    callback({
      target: {
        async create({ data }) {
          return { id: "target-1", ...data };
        },
      },
      auditLog: {
        async create({ data }) {
          audit = data;
        },
      },
    });
  const res = response();
  await createTarget(
    request({
      name: "Weekly target",
      period: "WEEKLY",
      targetQuantity: 150,
      startDate: "2026-10-19",
      endDate: "2026-10-25",
    }),
    res
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.target.status, "ACTIVE");
  assert.equal(res.body.target.createdById, "user-1");
  assert.equal(audit.action, "TARGET_CREATED");
});

test("target updates cannot make the date range invalid", async () => {
  prisma.$transaction = async (callback) =>
    callback({
      target: {
        async findUnique() {
          return {
            startDate: new Date("2026-10-19T00:00:00.000Z"),
            endDate: new Date("2026-10-25T00:00:00.000Z"),
          };
        },
      },
    });
  const res = response();

  await updateTarget(request({ startDate: "2026-10-26" }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, "INVALID_TARGET");
});
