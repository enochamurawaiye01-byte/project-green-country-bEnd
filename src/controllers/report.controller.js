const { getPublicStats } = require("../services/progress.service");
const { prisma } = require("../config/database");

const REPORT_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "PROGRAMME_MANAGER",
  "REVIEWER",
  "REPORT_VIEWER",
];
const MAX_REPORT_RECORDS = 10000;

const getAll = async (req, res) => {
  res.json({ message: "report controller" });
};

async function getPublicStatsRoute(req, res) {
  try {
    return res.json(await getPublicStats());
  } catch (error) {
    console.error("Public statistics calculation failed:", {
      code: error.code || "UNKNOWN",
    });

    if (error.code === "P2021" || error.code === "P2022") {
      return res.status(503).json({
        success: false,
        error: {
          code: "STATISTICS_SCHEMA_UNAVAILABLE",
          message:
            "Public statistics are unavailable until the required database schema is applied.",
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: {
        code: "STATISTICS_CALCULATION_FAILED",
        message: "Unable to calculate public statistics.",
      },
    });
  }
}

function parseReportDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.toISOString().slice(0, 10) === value ? date : null;
}

function reportQuery(req) {
  const query = req.query || {};
  if (
    Object.keys(query).some((key) => !["from", "to", "groupBy"].includes(key)) ||
    (query.groupBy !== undefined && !["day", "month", "species", "location"].includes(query.groupBy))
  ) {
    return { error: "Use valid from, to, and groupBy query parameters." };
  }
  const from = query.from === undefined ? undefined : parseReportDate(query.from);
  const to = query.to === undefined ? undefined : parseReportDate(query.to);
  if ((query.from !== undefined && !from) || (query.to !== undefined && !to)) {
    return { error: "from and to must be valid YYYY-MM-DD dates." };
  }
  if (from && to && from > to) return { error: "from must be on or before to." };
  const now = new Date();
  const endBefore = to ? new Date(to.getTime() + 86400000) : undefined;
  return {
    groupBy: query.groupBy || "month",
    where: {
      status: "APPROVED",
      isTestData: false,
      verifiedAt: { not: null },
      verifiedById: { not: null },
      plantingDate: {
        ...(from ? { gte: from } : {}),
        ...(endBefore ? { lt: endBefore } : {}),
        lte: now,
      },
    },
  };
}

function reportRoleAllowed(req, res) {
  if (REPORT_ROLES.includes(req.user?.role)) return true;
  res.status(403).json({
    success: false,
    error: { code: "FORBIDDEN", message: "You are not authorized to view planting reports." },
  });
  return false;
}

async function loadReportRecords(where) {
  return prisma.plantingRecord.findMany({
    where,
    orderBy: [{ plantingDate: "asc" }, { id: "asc" }],
    take: MAX_REPORT_RECORDS + 1,
    select: {
      quantity: true,
      plantingDate: true,
      species: { select: { name: true } },
      location: { select: { name: true } },
    },
  });
}

function groupRecord(record, groupBy) {
  if (groupBy === "species") return record.species?.name || "Unspecified";
  if (groupBy === "location") return record.location?.name || "Unspecified";
  const date = record.plantingDate.toISOString().slice(0, 10);
  return groupBy === "day" ? date : date.slice(0, 7);
}

async function getPlantingReport(req, res) {
  if (!reportRoleAllowed(req, res)) return;
  const parsed = reportQuery(req);
  if (parsed.error) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_REPORT_FILTER", message: parsed.error },
    });
  }
  try {
    const records = await loadReportRecords(parsed.where);
    if (records.length > MAX_REPORT_RECORDS) {
      return res.status(413).json({
        success: false,
        error: {
          code: "REPORT_TOO_LARGE",
          message: "Narrow the date range to report on at most 10,000 verified planting records.",
        },
      });
    }
    const groups = new Map();
    for (const record of records) {
      const key = groupRecord(record, parsed.groupBy);
      const current = groups.get(key) || { group: key, trees: 0, records: 0 };
      current.trees += record.quantity;
      current.records += 1;
      groups.set(key, current);
    }
    const totals = records.reduce((sum, record) => sum + record.quantity, 0);
    return res.json({
      success: true,
      groupBy: parsed.groupBy,
      totalTrees: totals,
      totalRecords: records.length,
      groups: [...groups.values()],
    });
  } catch (error) {
    console.error("Planting report failed:", { code: error.code || "UNKNOWN" });
    if (error.code === "P2021" || error.code === "P2022") {
      return res.status(503).json({
        success: false,
        error: { code: "REPORT_SCHEMA_UNAVAILABLE", message: "Planting reports are temporarily unavailable." },
      });
    }
    return res.status(500).json({
      success: false,
      error: { code: "REPORT_FAILED", message: "Unable to generate planting report." },
    });
  }
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function exportPlantingCsv(req, res) {
  if (!reportRoleAllowed(req, res)) return;
  const parsed = reportQuery({ ...req, query: { ...(req.query || {}), groupBy: undefined } });
  if (parsed.error) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_REPORT_FILTER", message: parsed.error },
    });
  }
  try {
    const records = await loadReportRecords(parsed.where);
    if (records.length > MAX_REPORT_RECORDS) {
      return res.status(413).json({
        success: false,
        error: { code: "REPORT_TOO_LARGE", message: "Narrow the date range to export at most 10,000 records." },
      });
    }
    const rows = [
      ["plantingDate", "quantity", "species", "location"],
      ...records.map((record) => [
        record.plantingDate.toISOString().slice(0, 10),
        record.quantity,
        record.species?.name || "",
        record.location?.name || "",
      ]),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="verified-planting-report.csv"');
    return res.status(200).send(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"));
  } catch (error) {
    console.error("Planting CSV export failed:", { code: error.code || "UNKNOWN" });
    return res.status(500).json({
      success: false,
      error: { code: "REPORT_EXPORT_FAILED", message: "Unable to export planting report." },
    });
  }
}

module.exports = {
  getAll,
  getPublicStatsRoute,
  getPlantingReport,
  exportPlantingCsv,
  parseReportDate,
};
