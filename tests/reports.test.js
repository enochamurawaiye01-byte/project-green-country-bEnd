const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../src/config/database");
const {
  getPlantingReport,
  exportPlantingCsv,
} = require("../src/controllers/report.controller");

const originalFindMany = prisma.plantingRecord.findMany;

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

test.afterEach(() => {
  prisma.plantingRecord.findMany = originalFindMany;
});

test("planting report filters to approved, verified, non-test, non-future records and groups by month", async () => {
  let query;
  prisma.plantingRecord.findMany = async (args) => {
    query = args;
    return [
      { quantity: 3, plantingDate: new Date("2026-10-10T00:00:00Z"), species: { name: "Oak" }, location: { name: "Farm" } },
      { quantity: 2, plantingDate: new Date("2026-10-20T00:00:00Z"), species: { name: "Oak" }, location: { name: "Farm" } },
    ];
  };
  const res = response();
  await getPlantingReport({
    user: { role: "REPORT_VIEWER" },
    query: { from: "2026-10-01", to: "2026-10-31", groupBy: "month" },
  }, res);

  assert.equal(query.where.status, "APPROVED");
  assert.equal(query.where.isTestData, false);
  assert.deepEqual(query.where.verifiedAt, { not: null });
  assert.deepEqual(query.where.verifiedById, { not: null });
  assert.ok(query.where.plantingDate.lte instanceof Date);
  assert.ok(query.where.plantingDate.lt instanceof Date);
  assert.equal(query.take, 10001);
  assert.equal(res.body.totalTrees, 5);
  assert.deepEqual(res.body.groups, [{ group: "2026-10", trees: 5, records: 2 }]);
});

test("invalid filters and unauthorized report access are rejected", async () => {
  let calls = 0;
  prisma.plantingRecord.findMany = async () => {
    calls += 1;
    return [];
  };
  const invalid = response();
  await getPlantingReport({
    user: { role: "DATA_ENTRY_OFFICER" },
    query: { from: "2026-02-30" },
  }, invalid);
  assert.equal(invalid.statusCode, 403);
  assert.equal(calls, 0);

  const badDate = response();
  await getPlantingReport({
    user: { role: "REPORT_VIEWER" },
    query: { from: "2026-02-30" },
  }, badDate);
  assert.equal(badDate.statusCode, 400);
  assert.equal(badDate.body.error.code, "INVALID_REPORT_FILTER");
});

test("CSV export neutralizes formula cells and sets attachment headers", async () => {
  prisma.plantingRecord.findMany = async () => [
    {
      quantity: 3,
      plantingDate: new Date("2026-10-10T00:00:00Z"),
      species: { name: "=HYPERLINK(\"bad\")" },
      location: { name: "Farm, Site" },
    },
  ];
  const res = response();
  await exportPlantingCsv({
    user: { role: "ADMIN" },
    query: { from: "2026-10-01", to: "2026-10-31" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["Content-Type"], /^text\/csv/);
  assert.match(res.body, /'=\s*HYPERLINK/);
  assert.match(res.body, /"Farm, Site"/);
});
