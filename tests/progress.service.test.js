const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getPublicStats,
  getReportingPeriods,
  lagosDateToUtc,
} = require("../src/services/progress.service");

const now = new Date("2028-01-03T12:00:00.000Z");

function createDatabase(records, targets = []) {
  return {
    plantingRecord: {
      async aggregate({ where }) {
        const matches = records.filter((record) => {
          if (record.status !== where.status) return false;
          if (record.isTestData !== where.isTestData) return false;
          if (!record.verifiedAt || !record.verifiedById) return false;
          const date = record.plantingDate.getTime();
          if (date > where.plantingDate.lte.getTime()) return false;
          if (
            where.plantingDate.gte &&
            date < where.plantingDate.gte.getTime()
          ) {
            return false;
          }
          if (
            where.plantingDate.lt &&
            date >= where.plantingDate.lt.getTime()
          ) {
            return false;
          }
          return true;
        });

        return {
          _sum: {
            quantity: matches.length
              ? matches.reduce((sum, record) => sum + record.quantity, 0)
              : null,
          },
          _count: { _all: matches.length },
        };
      },
    },
    target: {
      async aggregate({ where }) {
        const matches = targets.filter(
          (target) =>
            target.period === where.period &&
            target.status === where.status &&
            target.startDate <= where.startDate.lte &&
            target.endDate >= where.endDate.gte
        );
        return {
          _sum: {
            targetQuantity: matches.length
              ? matches.reduce((sum, target) => sum + target.targetQuantity, 0)
              : null,
          },
          _count: { _all: matches.length },
        };
      },
    },
  };
}

function verifiedRecord(id, quantity, plantingDate, overrides = {}) {
  return {
    id,
    quantity,
    plantingDate: new Date(plantingDate),
    status: "APPROVED",
    isTestData: false,
    verifiedAt: new Date("2028-01-02T00:00:00.000Z"),
    verifiedById: "reviewer-1",
    ...overrides,
  };
}

test("public totals sum only approved, verified, non-test quantities", async () => {
  const records = [
    verifiedRecord("approved-one", 100, "2028-01-02T23:00:00.000Z"),
    verifiedRecord("approved-two", 50, "2028-01-03T10:00:00.000Z"),
    verifiedRecord("pending", 500, "2028-01-03T10:00:00.000Z", {
      status: "PENDING",
    }),
    verifiedRecord("rejected", 600, "2028-01-03T10:00:00.000Z", {
      status: "REJECTED",
    }),
    verifiedRecord("unverified", 700, "2028-01-03T10:00:00.000Z", {
      verifiedAt: null,
      verifiedById: null,
    }),
    verifiedRecord("test-data", 800, "2028-01-03T10:00:00.000Z", {
      isTestData: true,
    }),
    verifiedRecord("future", 900, "2028-01-03T13:00:00.000Z"),
  ];
  const stats = await getPublicStats({ db: createDatabase(records), now });

  assert.equal(stats.data.cumulative.verifiedApprovedTrees, 150);
  assert.equal(stats.data.cumulative.verifiedApprovedRecords, 2);
  assert.equal(stats.data.projectPeriod.verifiedApprovedTrees, 150);
  assert.equal(stats.data.projectPeriod.verifiedApprovedRecords, 2);
  assert.equal(stats.data.periods.weekly.trees, 150);
  assert.equal(stats.data.periods.weekly.records, 2);
  assert.equal(stats.data.periods.monthly.trees, 150);
  assert.equal(stats.data.periods.monthly.records, 2);
  assert.equal(stats.data.periods.yearly.trees, 150);
  assert.equal(stats.data.periods.yearly.records, 2);
});

test("empty data returns zero totals and does not invent period targets", async () => {
  const stats = await getPublicStats({ db: createDatabase([]), now });

  assert.equal(stats.success, true);
  assert.equal(stats.data.cumulative.verifiedApprovedTrees, 0);
  assert.equal(stats.data.cumulative.verifiedApprovedRecords, 0);
  assert.equal(stats.data.projectPeriod.treesRemaining, 5_000_000);
  assert.equal(stats.data.periods.weekly.trees, 0);
  assert.equal(stats.data.periods.weekly.records, 0);
  assert.equal(stats.data.periods.weekly.targetTrees, null);
  assert.equal(stats.data.periods.weekly.percentageCompleted, null);
  assert.equal(stats.data.targetConfiguration.weekly, "NOT_CONFIGURED");
});

test("target progress uses configured target quantities without inventing goals", async () => {
  const targets = [
    {
      period: "WEEKLY",
      status: "ACTIVE",
      startDate: new Date("2028-01-01T00:00:00.000Z"),
      endDate: new Date("2028-01-10T00:00:00.000Z"),
      targetQuantity: 200,
    },
  ];
  const stats = await getPublicStats({
    db: createDatabase(
      [verifiedRecord("approved", 100, "2028-01-03T10:00:00.000Z")],
      targets
    ),
    now,
  });

  assert.equal(stats.data.periods.weekly.targetTrees, 200);
  assert.equal(stats.data.periods.weekly.targetConfigured, true);
  assert.equal(stats.data.periods.weekly.percentageCompleted, 50);
  assert.equal(stats.data.periods.monthly.targetTrees, null);
});

test("zero configured target has a safe null completion percentage", async () => {
  const targets = [
    {
      period: "WEEKLY",
      status: "ACTIVE",
      startDate: new Date("2028-01-01T00:00:00.000Z"),
      endDate: new Date("2028-01-10T00:00:00.000Z"),
      targetQuantity: 0,
    },
  ];
  const stats = await getPublicStats({
    db: createDatabase([], targets),
    now,
  });

  assert.equal(stats.data.periods.weekly.targetTrees, 0);
  assert.equal(stats.data.periods.weekly.targetConfigured, true);
  assert.equal(stats.data.periods.weekly.percentageCompleted, null);
});

test("Lagos reporting periods are Monday-Sunday and use local calendar boundaries", () => {
  const periods = getReportingPeriods(new Date("2028-01-03T12:00:00.000Z"));

  assert.equal(periods.week.startDate, "2028-01-03");
  assert.equal(periods.week.endDate, "2028-01-09");
  assert.equal(periods.month.startDate, "2028-01-01");
  assert.equal(periods.month.endDate, "2028-01-31");
  assert.equal(periods.year.startDate, "2028-01-01");
  assert.equal(periods.year.endDate, "2028-12-31");
  assert.equal(
    lagosDateToUtc(2028, 1, 1).toISOString(),
    "2027-12-31T23:00:00.000Z"
  );
});

test("reporting periods handle month and year transitions", () => {
  const periods = getReportingPeriods(new Date("2028-01-01T00:15:00.000Z"));

  assert.equal(periods.month.startDate, "2028-01-01");
  assert.equal(periods.month.endDate, "2028-01-31");
  assert.equal(periods.year.startDate, "2028-01-01");
  assert.equal(periods.year.endDate, "2028-12-31");
});

test("public response contains only aggregated data", async () => {
  const stats = await getPublicStats({
    db: createDatabase([
      verifiedRecord("private-row", 12, "2028-01-03T10:00:00.000Z"),
    ]),
    now,
  });
  const serialized = JSON.stringify(stats);

  assert.doesNotMatch(serialized, /private-row|reviewer-1|email|evidence|reviewedBy/i);
  assert.equal(stats.data.timezone, "Africa/Lagos");
  assert.equal(stats.data.overallTargetTrees, 5_000_000);
  assert.equal(stats.data.projectPeriod.treesRemaining, 4_999_988);
});
