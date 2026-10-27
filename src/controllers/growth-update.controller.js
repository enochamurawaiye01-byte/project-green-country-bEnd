const { prisma } = require("../config/database");

const SUBMISSION_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "PROGRAMME_MANAGER",
  "REVIEWER",
  "DATA_ENTRY_OFFICER",
];
const REVIEW_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "PROGRAMME_MANAGER",
  "REVIEWER",
];
const READ_ROLES = [...REVIEW_ROLES, "DATA_ENTRY_OFFICER", "REPORT_VIEWER"];
const VIEW_ALL_ROLES = [...REVIEW_ROLES, "REPORT_VIEWER"];
const GROWTH_STAGES = [
  "NEWLY_PLANTED",
  "SEEDLING_ESTABLISHMENT",
  "EARLY_GROWTH",
  "ESTABLISHED_GROWTH",
  "MATURE",
];
const GROWTH_CONDITIONS = [
  "HEALTHY",
  "FAIR",
  "POOR",
  "PEST_AFFECTED",
  "DISEASE_AFFECTED",
  "DEAD",
];

function sendError(res, status, message, code) {
  return res.status(status).json({
    success: false,
    error: { code, message },
  });
}

function parseObservationDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(
      value
    );
  if (!match) return null;
  const [, year, month, day] = match;
  const calendarDate = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day))
  );
  if (
    calendarDate.getUTCFullYear() !== Number(year) ||
    calendarDate.getUTCMonth() + 1 !== Number(month) ||
    calendarDate.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseFiniteNumber(value) {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim())
  ) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validateGrowthInput(body) {
  const plantingRecordId =
    typeof body.plantingRecordId === "string" && body.plantingRecordId.trim()
      ? body.plantingRecordId.trim()
      : null;
  const locationId =
    typeof body.locationId === "string" && body.locationId.trim()
      ? body.locationId.trim()
      : null;
  if (!plantingRecordId && !locationId) {
    return { error: "Provide a plantingRecordId or locationId." };
  }

  const observationDate = parseObservationDate(body.observationDate);
  if (!observationDate) {
    return { error: "A valid observationDate is required." };
  }
  if (observationDate.getTime() > Date.now()) {
    return { error: "observationDate cannot be in the future." };
  }

  if (!GROWTH_STAGES.includes(body.growthStage)) {
    return {
      error: `growthStage must be one of: ${GROWTH_STAGES.join(", ")}.`,
    };
  }
  if (!GROWTH_CONDITIONS.includes(body.condition)) {
    return {
      error: `condition must be one of: ${GROWTH_CONDITIONS.join(", ")}.`,
    };
  }

  const { treesInspected, treesSurviving, treesDead } = body;
  if (
    !Number.isInteger(treesInspected) ||
    treesInspected < 0 ||
    treesInspected > 2147483647
  ) {
    return { error: "treesInspected must be a non-negative whole number." };
  }
  const hasSurviving = treesSurviving !== undefined && treesSurviving !== null;
  const hasDead = treesDead !== undefined && treesDead !== null;
  if (hasSurviving !== hasDead) {
    return {
      error: "Provide both treesSurviving and treesDead, or neither.",
    };
  }
  if (
    hasSurviving &&
    (!Number.isInteger(treesSurviving) ||
      treesSurviving < 0 ||
      !Number.isInteger(treesDead) ||
      treesDead < 0 ||
      treesSurviving > 2147483647 ||
      treesDead > 2147483647 ||
      treesSurviving + treesDead > treesInspected)
  ) {
    return {
      error:
        "Surviving and dead counts must be non-negative whole numbers whose sum does not exceed treesInspected.",
    };
  }

  let averageHeightCm = null;
  if (body.averageHeightCm !== undefined && body.averageHeightCm !== null) {
    averageHeightCm = parseFiniteNumber(body.averageHeightCm);
    if (averageHeightCm === null || averageHeightCm < 0 || averageHeightCm > 100000) {
      return {
        error: "averageHeightCm must be between 0 and 100000 centimetres.",
      };
    }
  }

  const hasLatitude =
    body.latitude !== undefined && body.latitude !== null && body.latitude !== "";
  const hasLongitude =
    body.longitude !== undefined &&
    body.longitude !== null &&
    body.longitude !== "";
  if (hasLatitude !== hasLongitude) {
    return { error: "Provide both latitude and longitude." };
  }

  let latitude = null;
  let longitude = null;
  if (hasLatitude) {
    latitude = parseFiniteNumber(body.latitude);
    longitude = parseFiniteNumber(body.longitude);
    if (
      latitude === null ||
      longitude === null ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return { error: "Invalid GPS coordinates." };
    }
  }

  const photoUrls = body.photoUrls === undefined ? [] : body.photoUrls;
  if (
    !Array.isArray(photoUrls) ||
    photoUrls.length > 20 ||
    !photoUrls.every((value) => {
      if (typeof value !== "string" || value.length > 2048) return false;
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    })
  ) {
    return {
      error:
        "photoUrls must contain at most 20 valid HTTP or HTTPS URLs.",
    };
  }

  const notes = body.notes === undefined || body.notes === null ? null : body.notes;
  if (notes !== null && (typeof notes !== "string" || notes.length > 5000)) {
    return { error: "notes must be a string of at most 5000 characters." };
  }

  return {
    data: {
      plantingRecordId,
      locationId,
      observationDate,
      growthStage: body.growthStage,
      condition: body.condition,
      treesInspected,
      treesSurviving: hasSurviving ? treesSurviving : null,
      treesDead: hasDead ? treesDead : null,
      averageHeightCm,
      notes: notes?.trim() || null,
      photoUrls,
      latitude,
      longitude,
    },
  };
}

function canSubmit(req, res) {
  if (!SUBMISSION_ROLES.includes(req.user?.role)) {
    sendError(res, 403, "You are not authorized to submit growth updates.", "FORBIDDEN");
    return false;
  }
  return true;
}

function canReview(req, res) {
  if (!REVIEW_ROLES.includes(req.user?.role)) {
    sendError(res, 403, "You are not authorized to review growth updates.", "FORBIDDEN");
    return false;
  }
  return true;
}

async function validateReferences(data) {
  if (data.plantingRecordId) {
    const record = await prisma.plantingRecord.findUnique({
      where: { id: data.plantingRecordId },
      select: { id: true, locationId: true },
    });
    if (!record) {
      return { status: 404, message: "Planting record not found." };
    }
    if (data.locationId && data.locationId !== record.locationId) {
      return {
        status: 400,
        message: "The location must match the planting record's location.",
      };
    }
  }

  if (data.locationId) {
    const location = await prisma.plantingLocation.findUnique({
      where: { id: data.locationId },
      select: { id: true },
    });
    if (!location) {
      return { status: 404, message: "Planting location not found." };
    }
  }

  return null;
}

function privateAccessAllowed(req, update) {
  return (
    VIEW_ALL_ROLES.includes(req.user?.role) ||
    update.submittedById === req.user?.id
  );
}

async function createGrowthUpdate(req, res) {
  if (!canSubmit(req, res)) return;

  const parsed = validateGrowthInput(req.body || {});
  if (parsed.error) {
    return sendError(res, 400, parsed.error, "INVALID_GROWTH_UPDATE");
  }

  try {
    const referenceError = await validateReferences(parsed.data);
    if (referenceError) {
      return sendError(
        res,
        referenceError.status,
        referenceError.message,
        referenceError.status === 404
          ? "REFERENCE_NOT_FOUND"
          : "INVALID_GROWTH_UPDATE"
      );
    }

    const growthUpdate = await prisma.growthUpdate.create({
      data: {
        ...parsed.data,
        submittedById: req.user.id,
        status: "PENDING",
        isPublic: false,
      },
      select: {
        id: true,
        plantingRecordId: true,
        locationId: true,
        observationDate: true,
        growthStage: true,
        condition: true,
        treesInspected: true,
        treesSurviving: true,
        treesDead: true,
        averageHeightCm: true,
        notes: true,
        photoUrls: true,
        latitude: true,
        longitude: true,
        submittedById: true,
        status: true,
        isPublic: true,
        createdAt: true,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Growth update submitted for review.",
      growthUpdate,
    });
  } catch (error) {
    console.error("Create growth update failed:", {
      code: error.code || "UNKNOWN",
    });
    if (error.code === "P2003" || error.code === "P2025") {
      return sendError(res, 404, "A referenced planting record or location was not found.", "REFERENCE_NOT_FOUND");
    }
    return sendError(res, 500, "Unable to submit growth update.", "GROWTH_UPDATE_CREATE_FAILED");
  }
}

async function listPrivateUpdates(req, res, filter) {
  if (!READ_ROLES.includes(req.user?.role)) {
    return sendError(res, 403, "You are not authorized to view growth updates.", "FORBIDDEN");
  }

  try {
    const scopedFilter = VIEW_ALL_ROLES.includes(req.user.role)
      ? filter
      : { ...filter, submittedById: req.user.id };
    const updates = await prisma.growthUpdate.findMany({
      where: scopedFilter,
      orderBy: [{ observationDate: "desc" }, { createdAt: "desc" }],
      take: 100,
    });
    return res.json({ success: true, count: updates.length, growthUpdates: updates });
  } catch (error) {
    console.error("List growth updates failed:", {
      code: error.code || "UNKNOWN",
    });
    return sendError(res, 500, "Unable to retrieve growth updates.", "GROWTH_UPDATE_LIST_FAILED");
  }
}

async function listByPlantingRecord(req, res) {
  return listPrivateUpdates(req, res, {
    plantingRecordId: req.params.plantingRecordId,
  });
}

async function listByLocation(req, res) {
  return listPrivateUpdates(req, res, { locationId: req.params.locationId });
}

function publicWhere(filter) {
  return {
    ...filter,
    status: "APPROVED",
    isPublic: true,
    AND: [
      {
        OR: [
          { plantingRecordId: null },
          {
            plantingRecord: {
              is: {
                status: "APPROVED",
                isTestData: false,
                verifiedAt: { not: null },
                verifiedById: { not: null },
                OR: [
                  { locationId: null },
                  { location: { is: { isPublic: true } } },
                ],
              },
            },
          },
        ],
      },
      {
        OR: [
          { locationId: null },
          { location: { is: { isPublic: true } } },
        ],
      },
      {
        OR: [
          { plantingRecordId: { not: null } },
          { locationId: { not: null } },
        ],
      },
    ],
  };
}

const PUBLIC_UPDATE_SELECT = {
  id: true,
  plantingRecordId: true,
  locationId: true,
  observationDate: true,
  growthStage: true,
  condition: true,
  treesInspected: true,
  treesSurviving: true,
  treesDead: true,
  averageHeightCm: true,
  notes: true,
  photoUrls: true,
  createdAt: true,
};

async function listPublicUpdates(req, res, filter) {
  try {
    const growthUpdates = await prisma.growthUpdate.findMany({
      where: publicWhere(filter),
      orderBy: [{ observationDate: "desc" }, { createdAt: "desc" }],
      take: 100,
      select: PUBLIC_UPDATE_SELECT,
    });
    return res.json({
      success: true,
      count: growthUpdates.length,
      growthUpdates,
    });
  } catch (error) {
    console.error("List public growth updates failed:", {
      code: error.code || "UNKNOWN",
    });
    return sendError(res, 500, "Unable to retrieve public growth updates.", "PUBLIC_GROWTH_UPDATE_LIST_FAILED");
  }
}

async function listPublicByPlantingRecord(req, res) {
  return listPublicUpdates(req, res, {
    plantingRecordId: req.params.plantingRecordId,
  });
}

async function listPublicByLocation(req, res) {
  return listPublicUpdates(req, res, { locationId: req.params.locationId });
}

async function getGrowthUpdate(req, res) {
  try {
    const update = await prisma.growthUpdate.findUnique({
      where: { id: req.params.id },
    });
    if (!update) {
      return sendError(res, 404, "Growth update not found.", "NOT_FOUND");
    }
    if (!privateAccessAllowed(req, update)) {
      return sendError(res, 403, "You are not authorized to view this growth update.", "FORBIDDEN");
    }
    return res.json({ success: true, growthUpdate: update });
  } catch (error) {
    console.error("Get growth update failed:", {
      code: error.code || "UNKNOWN",
    });
    return sendError(res, 500, "Unable to retrieve growth update.", "GROWTH_UPDATE_READ_FAILED");
  }
}

async function getPublicGrowthUpdate(req, res) {
  try {
    const growthUpdate = await prisma.growthUpdate.findFirst({
      where: publicWhere({ id: req.params.id }),
      select: PUBLIC_UPDATE_SELECT,
    });
    if (!growthUpdate) {
      return sendError(res, 404, "Public growth update not found.", "NOT_FOUND");
    }
    return res.json({ success: true, growthUpdate });
  } catch (error) {
    console.error("Get public growth update failed:", {
      code: error.code || "UNKNOWN",
    });
    return sendError(res, 500, "Unable to retrieve public growth update.", "PUBLIC_GROWTH_UPDATE_READ_FAILED");
  }
}

async function reviewGrowthUpdate(req, res, status) {
  if (!canReview(req, res)) return;

  const reason =
    typeof req.body?.rejectionReason === "string"
      ? req.body.rejectionReason.trim()
      : "";
  const reviewNotes =
    typeof req.body?.reviewNotes === "string"
      ? req.body.reviewNotes.trim()
      : "";
  const isPublic = req.body?.isPublic === true;

  if (
    status === "REJECTED" &&
    (!reason || reason.length > 2000)
  ) {
    return sendError(res, 400, "A rejection reason between 1 and 2000 characters is required.", "INVALID_REJECTION_REASON");
  }
  if (reviewNotes.length > 2000) {
    return sendError(res, 400, "reviewNotes must not exceed 2000 characters.", "INVALID_REVIEW_NOTES");
  }
  if (req.body?.isPublic !== undefined && typeof req.body.isPublic !== "boolean") {
    return sendError(res, 400, "isPublic must be a boolean.", "INVALID_PUBLIC_FLAG");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.growthUpdate.updateMany({
        where: { id: req.params.id, status: "PENDING" },
        data: {
          status,
          isPublic: status === "APPROVED" && isPublic,
          reviewedById: req.user.id,
          reviewedAt: new Date(),
          reviewNotes: reviewNotes || null,
          rejectionReason: status === "REJECTED" ? reason : null,
        },
      });
      if (updated.count === 0) {
        const existing = await tx.growthUpdate.findUnique({
          where: { id: req.params.id },
          select: { id: true, status: true },
        });
        return existing ? { conflict: true } : { missing: true };
      }

      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: status === "APPROVED" ? "GROWTH_UPDATE_APPROVED" : "GROWTH_UPDATE_REJECTED",
          entityType: "GrowthUpdate",
          entityId: req.params.id,
          description:
            status === "APPROVED"
              ? "Growth update approved."
              : "Growth update rejected.",
          metadata: { status, isPublic: status === "APPROVED" && isPublic },
        },
      });

      const growthUpdate = await tx.growthUpdate.findUnique({
        where: { id: req.params.id },
      });
      return { growthUpdate };
    });

    if (result.missing) {
      return sendError(res, 404, "Growth update not found.", "NOT_FOUND");
    }
    if (result.conflict) {
      return sendError(res, 409, "Growth update has already been reviewed.", "REVIEW_CONFLICT");
    }
    return res.json({
      success: true,
      message:
        status === "APPROVED"
          ? "Growth update approved."
          : "Growth update rejected.",
      growthUpdate: result.growthUpdate,
    });
  } catch (error) {
    console.error("Review growth update failed:", {
      code: error.code || "UNKNOWN",
    });
    return sendError(res, 500, "Unable to review growth update.", "GROWTH_UPDATE_REVIEW_FAILED");
  }
}

async function approveGrowthUpdate(req, res) {
  return reviewGrowthUpdate(req, res, "APPROVED");
}

async function rejectGrowthUpdate(req, res) {
  return reviewGrowthUpdate(req, res, "REJECTED");
}

module.exports = {
  createGrowthUpdate,
  listByPlantingRecord,
  listByLocation,
  listPublicByPlantingRecord,
  listPublicByLocation,
  getGrowthUpdate,
  getPublicGrowthUpdate,
  approveGrowthUpdate,
  rejectGrowthUpdate,
  validateGrowthInput,
};
