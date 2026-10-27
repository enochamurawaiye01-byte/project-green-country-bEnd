const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../src/app");
const { prisma } = require("../src/config/database");

const originalPlantingAggregate = prisma.plantingRecord.aggregate;
const originalTargetAggregate = prisma.target.aggregate;

async function requestPublicStats() {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const address = server.address();
    return await fetch(`http://127.0.0.1:${address.port}/api/reports/public-stats`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test.afterEach(() => {
  prisma.plantingRecord.aggregate = originalPlantingAggregate;
  prisma.target.aggregate = originalTargetAggregate;
});

test("public statistics route responds without authentication with aggregates only", async () => {
  prisma.plantingRecord.aggregate = async () => ({
    _sum: { quantity: null },
    _count: { _all: 0 },
  });
  prisma.target.aggregate = async () => ({
    _sum: { targetQuantity: null },
    _count: { _all: 0 },
  });

  const response = await requestPublicStats();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.cumulative.verifiedApprovedTrees, 0);
  assert.equal(body.data.projectPeriod.treesRemaining, 5_000_000);
  assert.equal(JSON.stringify(body).includes("email"), false);
  assert.equal(JSON.stringify(body).includes("evidenceNotes"), false);
});

test("public statistics route reports missing schema instead of fake zero totals", async () => {
  prisma.plantingRecord.aggregate = async () => {
    throw Object.assign(new Error("missing column"), { code: "P2022" });
  };
  prisma.target.aggregate = async () => ({
    _sum: { targetQuantity: null },
    _count: { _all: 0 },
  });

  const response = await requestPublicStats();
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.error.code, "STATISTICS_SCHEMA_UNAVAILABLE");
});
