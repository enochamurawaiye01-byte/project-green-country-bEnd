const { prisma } = require("../config/database");

const MANAGE_ROLES = ["SUPER_ADMIN", "ADMIN", "PROGRAMME_MANAGER"];
const READ_ROLES = [...MANAGE_ROLES, "REVIEWER", "REPORT_VIEWER"];
const TARGET_PERIODS = ["WEEKLY", "MONTHLY", "YEARLY", "PROGRAMME"];
const TARGET_STATUSES = ["ACTIVE", "COMPLETED", "CANCELLED"];
const TARGET_SELECT = {
  id: true,
  name: true,
  description: true,
  period: true,
  targetQuantity: true,
  startDate: true,
  endDate: true,
  status: true,
  locationId: true,
  speciesId: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  location: { select: { id: true, name: true, slug: true } },
  species: { select: { id: true, name: true, scientificName: true } },
};

function sendError(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

function parseDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    calendarDate.getUTCFullYear() !== Number(year) ||
    calendarDate.getUTCMonth() + 1 !== Number(month) ||
    calendarDate.getUTCDate() !== Number(day)
  ) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validateTargetInput(body, { partial = false } = {}) {
  const data = {};
  const fields = ["name", "description", "period", "targetQuantity", "startDate", "endDate", "locationId", "speciesId"];
  for (const field of fields) {
    if (body[field] === undefined) {
      if (partial) continue;
      if (field === "description" || field === "locationId" || field === "speciesId") {
        data[field] = null;
        continue;
      }
      return { error: `${field} is required.` };
    }
    if (field === "name") {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 160) {
        return { error: "name must be a non-empty string of at most 160 characters." };
      }
      data.name = body.name.trim();
    } else if (field === "description") {
      if (body.description !== null && (typeof body.description !== "string" || body.description.length > 5000)) {
        return { error: "description must be a string of at most 5000 characters." };
      }
      data.description = typeof body.description === "string" ? body.description.trim() || null : null;
    } else if (field === "period") {
      if (!TARGET_PERIODS.includes(body.period)) {
        return { error: `period must be one of: ${TARGET_PERIODS.join(", ")}.` };
      }
      data.period = body.period;
    } else if (field === "targetQuantity") {
      if (!Number.isInteger(body.targetQuantity) || body.targetQuantity <= 0 || body.targetQuantity > 2147483647) {
        return { error: "targetQuantity must be a positive whole number within the supported range." };
      }
      data.targetQuantity = body.targetQuantity;
    } else if (field === "startDate" || field === "endDate") {
      const value = parseDate(body[field]);
      if (!value) return { error: `${field} must be a valid ISO date.` };
      data[field] = value;
    } else if (field === "locationId" || field === "speciesId") {
      if (body[field] !== null && (typeof body[field] !== "string" || !body[field].trim())) {
        return { error: `${field} must be a non-empty string or null.` };
      }
      data[field] = typeof body[field] === "string" ? body[field].trim() : null;
    }
  }

  if (body.status !== undefined) {
    if (!partial || !TARGET_STATUSES.includes(body.status)) {
      return { error: `status may be updated to one of: ${TARGET_STATUSES.join(", ")}.` };
    }
    data.status = body.status;
  } else if (!partial) {
    data.status = "ACTIVE";
  }

  if (data.startDate && data.endDate && data.endDate < data.startDate) {
    return { error: "endDate must be on or after startDate." };
  }
  return { data };
}

function canRead(req, res) {
  if (READ_ROLES.includes(req.user?.role)) return true;
  sendError(res, 403, "FORBIDDEN", "You are not authorized to view targets.");
  return false;
}

function canManage(req, res) {
  if (MANAGE_ROLES.includes(req.user?.role)) return true;
  sendError(res, 403, "FORBIDDEN", "You are not authorized to manage targets.");
  return false;
}

async function getAll(req, res) {
  if (!canRead(req, res)) return;
  try {
    const targets = await prisma.target.findMany({
      orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
      select: TARGET_SELECT,
    });
    const now = new Date();
    const targetsWithProgress = await Promise.all(targets.map(async (target) => {
      const endBefore = new Date(target.endDate);
      endBefore.setUTCDate(endBefore.getUTCDate() + 1);
      const aggregate = await prisma.plantingRecord.aggregate({
        where: {
          status: "APPROVED",
          isTestData: false,
          verifiedAt: { not: null },
          verifiedById: { not: null },
          plantingDate: {
            gte: target.startDate,
            lt: endBefore,
            lte: now,
          },
          ...(target.locationId ? { locationId: target.locationId } : {}),
          ...(target.speciesId ? { speciesId: target.speciesId } : {}),
        },
        _sum: { quantity: true },
        _count: { _all: true },
      });
      const plantedQuantity = aggregate._sum.quantity || 0;
      return {
        ...target,
        progress: {
          plantedQuantity,
          verifiedRecords: aggregate._count._all || 0,
          remainingQuantity: Math.max(0, target.targetQuantity - plantedQuantity),
          percentageCompleted: Number(
            ((plantedQuantity / target.targetQuantity) * 100).toFixed(2)
          ),
        },
      };
    }));
    return res.json({ success: true, count: targetsWithProgress.length, targets: targetsWithProgress });
  } catch (error) {
    console.error("List targets failed:", { code: error.code || "UNKNOWN" });
    return sendError(res, 500, "TARGET_LIST_FAILED", "Unable to retrieve targets.");
  }
}

async function createTarget(req, res) {
  if (!canManage(req, res)) return;
  const parsed = validateTargetInput(req.body || {});
  if (parsed.error) return sendError(res, 400, "INVALID_TARGET", parsed.error);
  try {
    const target = await prisma.$transaction(async (tx) => {
      const created = await tx.target.create({
        data: { ...parsed.data, createdById: req.user.id },
        select: TARGET_SELECT,
      });
      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: "TARGET_CREATED",
          entityType: "Target",
          entityId: created.id,
          description: "Planting target created.",
          metadata: { period: created.period, targetQuantity: created.targetQuantity },
        },
      });
      return created;
    });
    return res.status(201).json({ success: true, target });
  } catch (error) {
    console.error("Create target failed:", { code: error.code || "UNKNOWN" });
    if (error.code === "P2003") {
      return sendError(res, 404, "REFERENCE_NOT_FOUND", "The selected location or species was not found.");
    }
    return sendError(res, 500, "TARGET_CREATE_FAILED", "Unable to create target.");
  }
}

async function updateTarget(req, res) {
  if (!canManage(req, res)) return;
  const parsed = validateTargetInput(req.body || {}, { partial: true });
  if (parsed.error) return sendError(res, 400, "INVALID_TARGET", parsed.error);
  if (!Object.keys(parsed.data).length) {
    return sendError(res, 400, "EMPTY_UPDATE", "Provide at least one target field to update.");
  }
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const existing = await tx.target.findUnique({
        where: { id: req.params.id },
        select: { startDate: true, endDate: true, status: true },
      });
      if (!existing) return { notFound: true };
      if (
        parsed.data.status &&
        existing.status !== "ACTIVE" &&
        parsed.data.status !== existing.status
      ) {
        return { invalidStatusTransition: true };
      }
      const startDate = parsed.data.startDate || existing.startDate;
      const endDate = parsed.data.endDate || existing.endDate;
      if (endDate < startDate) return { invalidDateRange: true };
      const updated = await tx.target.update({
        where: { id: req.params.id },
        data: parsed.data,
        select: TARGET_SELECT,
      });
      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: "TARGET_UPDATED",
          entityType: "Target",
          entityId: updated.id,
          description: "Planting target updated.",
          metadata: { fields: Object.keys(parsed.data) },
        },
      });
      return { target: updated };
    });
    if (outcome.notFound) return sendError(res, 404, "NOT_FOUND", "Target not found.");
    if (outcome.invalidDateRange) {
      return sendError(res, 400, "INVALID_TARGET", "endDate must be on or after startDate.");
    }
    if (outcome.invalidStatusTransition) {
      return sendError(res, 409, "INVALID_STATUS_TRANSITION", "Completed and cancelled targets cannot be reopened or changed.");
    }
    return res.json({ success: true, target: outcome.target });
  } catch (error) {
    console.error("Update target failed:", { code: error.code || "UNKNOWN" });
    if (error.code === "P2025") return sendError(res, 404, "NOT_FOUND", "Target not found.");
    if (error.code === "P2003") {
      return sendError(res, 404, "REFERENCE_NOT_FOUND", "The selected location or species was not found.");
    }
    return sendError(res, 500, "TARGET_UPDATE_FAILED", "Unable to update target.");
  }
}

module.exports = { getAll, createTarget, updateTarget };
