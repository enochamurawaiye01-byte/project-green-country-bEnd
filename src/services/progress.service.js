const { prisma } = require("../config/database");

const TIME_ZONE = "Africa/Lagos";
const OVERALL_TARGET = 5_000_000;
const PROJECT_START = { year: 2027, month: 1, day: 1 };
const PROJECT_END_EXCLUSIVE = { year: 2033, month: 1, day: 1 };
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function lagosParts(date) {
  const parts = formatter.formatToParts(date);
  return Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)])
  );
}

function lagosDateToUtc(year, month, day) {
  const nominalUtc = Date.UTC(year, month - 1, day);
  const localParts = lagosParts(new Date(nominalUtc));
  const representedAsUtc = Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day,
    localParts.hour,
    localParts.minute,
    localParts.second
  );
  const offset = representedAsUtc - nominalUtc;
  return new Date(nominalUtc - offset);
}

function dateLabel(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getReportingPeriods(now) {
  const { year, month, day } = lagosParts(now);
  const localToday = new Date(Date.UTC(year, month - 1, day));
  const weekday = localToday.getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const weekStartDate = new Date(localToday);
  weekStartDate.setUTCDate(weekStartDate.getUTCDate() - daysSinceMonday);
  const weekEndDate = new Date(weekStartDate);
  weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6);

  const makePeriod = (start, endExclusive, endInclusive) => ({
    start,
    endExclusive,
    startDate: dateLabel(start.year, start.month, start.day),
    endDate: dateLabel(endInclusive.year, endInclusive.month, endInclusive.day),
    startAt: lagosDateToUtc(start.year, start.month, start.day),
    endBefore: lagosDateToUtc(
      endExclusive.year,
      endExclusive.month,
      endExclusive.day
    ),
  });

  const monthEndDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const yearEnd = { year: year + 1, month: 1, day: 1 };

  return {
    week: makePeriod(
      {
        year: weekStartDate.getUTCFullYear(),
        month: weekStartDate.getUTCMonth() + 1,
        day: weekStartDate.getUTCDate(),
      },
      {
        year: weekEndDate.getUTCFullYear(),
        month: weekEndDate.getUTCMonth() + 1,
        day: weekEndDate.getUTCDate() + 1,
      },
      {
        year: weekEndDate.getUTCFullYear(),
        month: weekEndDate.getUTCMonth() + 1,
        day: weekEndDate.getUTCDate(),
      }
    ),
    month: makePeriod(
      { year, month, day: 1 },
      month === 12
        ? { year: year + 1, month: 1, day: 1 }
        : { year, month: month + 1, day: 1 },
      { year, month, day: monthEndDay }
    ),
    year: makePeriod(
      { year, month: 1, day: 1 },
      yearEnd,
      { year, month: 12, day: 31 }
    ),
  };
}

function eligibleRecordWhere(now, period) {
  return {
    status: "APPROVED",
    isTestData: false,
    verifiedAt: { not: null },
    verifiedById: { not: null },
    plantingDate: {
      lte: now,
      ...(period
        ? { gte: period.startAt, lt: period.endBefore }
        : {}),
    },
  };
}

async function aggregatePlantings(db, where) {
  const result = await db.plantingRecord.aggregate({
    where,
    _sum: { quantity: true },
    _count: { _all: true },
  });

  return {
    trees: result._sum.quantity || 0,
    records: result._count._all || 0,
  };
}

async function aggregateTarget(db, period, range) {
  const result = await db.target.aggregate({
    where: {
      period,
      status: "ACTIVE",
      startDate: { lte: range.endBefore },
      endDate: { gte: range.startAt },
    },
    _sum: { targetQuantity: true },
    _count: { _all: true },
  });

  return result._count._all
    ? result._sum.targetQuantity
    : null;
}

function percentage(actual, target) {
  if (target === null || target <= 0) return null;
  return Number(((actual / target) * 100).toFixed(2));
}

function serializePeriod(period, totals, targetTrees) {
  return {
    startDate: period.startDate,
    endDate: period.endDate,
    trees: totals.trees,
    records: totals.records,
    targetTrees,
    targetConfigured: targetTrees !== null,
    percentageCompleted: percentage(totals.trees, targetTrees),
  };
}

async function getPublicStats({ db = prisma, now = new Date() } = {}) {
  const periods = getReportingPeriods(now);
  const projectStartAt = lagosDateToUtc(
    PROJECT_START.year,
    PROJECT_START.month,
    PROJECT_START.day
  );
  const projectEndBefore = lagosDateToUtc(
    PROJECT_END_EXCLUSIVE.year,
    PROJECT_END_EXCLUSIVE.month,
    PROJECT_END_EXCLUSIVE.day
  );

  const [
    cumulative,
    projectPeriod,
    weeklyTotals,
    monthlyTotals,
    yearlyTotals,
    weeklyTarget,
    monthlyTarget,
    yearlyTarget,
  ] = await Promise.all([
    aggregatePlantings(db, eligibleRecordWhere(now)),
    aggregatePlantings(db, {
      ...eligibleRecordWhere(now),
      plantingDate: {
        gte: projectStartAt,
        lt: projectEndBefore,
        lte: now,
      },
    }),
    aggregatePlantings(db, eligibleRecordWhere(now, periods.week)),
    aggregatePlantings(db, eligibleRecordWhere(now, periods.month)),
    aggregatePlantings(db, eligibleRecordWhere(now, periods.year)),
    aggregateTarget(db, "WEEKLY", periods.week),
    aggregateTarget(db, "MONTHLY", periods.month),
    aggregateTarget(db, "YEARLY", periods.year),
  ]);

  return {
    success: true,
    data: {
      timezone: TIME_ZONE,
      calculatedAt: now.toISOString(),
      currentPeriod: {
        week: { startDate: periods.week.startDate, endDate: periods.week.endDate },
        month: { startDate: periods.month.startDate, endDate: periods.month.endDate },
        year: { startDate: periods.year.startDate, endDate: periods.year.endDate },
      },
      verificationRule:
        "Public totals include only approved records explicitly verified by an authorized reviewer and not marked as test data. Periods use planting date.",
      overallTargetTrees: OVERALL_TARGET,
      targetPeriod: {
        startDate: dateLabel(PROJECT_START.year, PROJECT_START.month, PROJECT_START.day),
        endDate: "2032-12-31",
      },
      cumulative: {
        verifiedApprovedTrees: cumulative.trees,
        verifiedApprovedRecords: cumulative.records,
      },
      projectPeriod: {
        verifiedApprovedTrees: projectPeriod.trees,
        verifiedApprovedRecords: projectPeriod.records,
        treesRemaining: Math.max(0, OVERALL_TARGET - projectPeriod.trees),
        percentageCompleted: percentage(projectPeriod.trees, OVERALL_TARGET),
      },
      periods: {
        weekly: serializePeriod(periods.week, weeklyTotals, weeklyTarget),
        monthly: serializePeriod(periods.month, monthlyTotals, monthlyTarget),
        yearly: serializePeriod(periods.year, yearlyTotals, yearlyTarget),
      },
      targetConfiguration: {
        weekly: weeklyTarget === null ? "NOT_CONFIGURED" : "CONFIGURED",
        monthly: monthlyTarget === null ? "NOT_CONFIGURED" : "CONFIGURED",
        yearly: yearlyTarget === null ? "NOT_CONFIGURED" : "CONFIGURED",
      },
    },
  };
}

module.exports = {
  getPublicStats,
  getReportingPeriods,
  lagosDateToUtc,
};
