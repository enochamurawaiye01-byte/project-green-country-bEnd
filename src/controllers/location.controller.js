const { prisma } = require("../config/database");

const LOCATION_ROLES = ["SUPER_ADMIN", "ADMIN", "PROGRAMME_MANAGER"];
const LOCATION_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  address: true,
  community: true,
  localGovernment: true,
  state: true,
  country: true,
  latitude: true,
  longitude: true,
  imageUrl: true,
  isPublic: true,
  createdAt: true,
  updatedAt: true,
};
const STRING_LIMITS = {
  name: 160,
  description: 5000,
  address: 500,
  community: 160,
  localGovernment: 160,
  state: 160,
  country: 160,
  imageUrl: 2048,
};
const LOCATION_FIELDS = Object.keys(STRING_LIMITS);

function sendError(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

function validateLocationInput(body, { partial = false } = {}) {
  const data = {};
  for (const field of LOCATION_FIELDS) {
    const value = body[field];
    if (value === undefined) {
      if (field === "name" && !partial) return { error: "name is required." };
      continue;
    }
    if (value === null && field !== "name" && field !== "imageUrl") {
      data[field] = null;
      continue;
    }
    if (typeof value !== "string" || value.length > STRING_LIMITS[field]) {
      return { error: `${field} must be a string of at most ${STRING_LIMITS[field]} characters.` };
    }
    const normalized = value.trim();
    if (field === "name" && !normalized) {
      return { error: "name is required." };
    }
    if (field === "imageUrl" && normalized) {
      try {
        const url = new URL(normalized);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid protocol");
      } catch {
        return { error: "imageUrl must be a valid HTTP or HTTPS URL." };
      }
    }
    data[field] = normalized || (field === "name" ? "" : null);
  }

  if (!partial || body.slug !== undefined) {
    if (typeof body.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug)) {
      return { error: "slug must contain lowercase letters, numbers, and single hyphens only." };
    }
    data.slug = body.slug;
  }

  if (!partial || body.isPublic !== undefined) {
    if (body.isPublic !== undefined && typeof body.isPublic !== "boolean") {
      return { error: "isPublic must be a boolean." };
    }
    data.isPublic = body.isPublic === undefined ? true : body.isPublic;
  }

  const latitudeSupplied = body.latitude !== undefined;
  const longitudeSupplied = body.longitude !== undefined;
  if (partial && !latitudeSupplied && !longitudeSupplied) {
    return { data };
  }
  const latitude = body.latitude;
  const longitude = body.longitude;
  if (
    latitudeSupplied !== longitudeSupplied ||
    (!partial && (latitude === null || longitude === null))
  ) {
    return { error: "Provide both latitude and longitude, or neither." };
  }
  if (latitudeSupplied || longitudeSupplied) {
    if (latitude === null && longitude === null && partial) {
      data.latitude = null;
      data.longitude = null;
    } else {
      const lat = typeof latitude === "string" && latitude.trim() ? Number(latitude) : latitude;
      const lng = typeof longitude === "string" && longitude.trim() ? Number(longitude) : longitude;
      if (
        typeof lat !== "number" || !Number.isFinite(lat) ||
        typeof lng !== "number" || !Number.isFinite(lng) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180
      ) {
        return { error: "Invalid GPS coordinates." };
      }
      data.latitude = lat;
      data.longitude = lng;
    }
  } else {
    data.latitude = null;
    data.longitude = null;
  }

  return { data };
}

function canManage(req, res) {
  if (LOCATION_ROLES.includes(req.user?.role)) return true;
  sendError(res, 403, "FORBIDDEN", "You are not authorized to manage planting locations.");
  return false;
}

async function getAll(req, res) {
  try {
    const locations = await prisma.plantingLocation.findMany({
      where: { isPublic: true },
      orderBy: { name: "asc" },
      select: LOCATION_SELECT,
    });
    return res.json({ success: true, count: locations.length, locations });
  } catch (error) {
    console.error("List public locations failed:", { code: error.code || "UNKNOWN" });
    return sendError(res, 500, "LOCATION_LIST_FAILED", "Unable to retrieve planting locations.");
  }
}

async function getManageableLocations(req, res) {
  if (!canManage(req, res)) return;
  try {
    const locations = await prisma.plantingLocation.findMany({
      orderBy: { name: "asc" },
      select: LOCATION_SELECT,
    });
    return res.json({ success: true, count: locations.length, locations });
  } catch (error) {
    console.error("List manageable locations failed:", { code: error.code || "UNKNOWN" });
    return sendError(res, 500, "LOCATION_LIST_FAILED", "Unable to retrieve planting locations.");
  }
}

async function getPublicLocation(req, res) {
  try {
    const location = await prisma.plantingLocation.findFirst({
      where: { id: req.params.id, isPublic: true },
      select: LOCATION_SELECT,
    });
    if (!location) return sendError(res, 404, "NOT_FOUND", "Planting location not found.");
    return res.json({ success: true, location });
  } catch (error) {
    console.error("Get public location failed:", { code: error.code || "UNKNOWN" });
    return sendError(res, 500, "LOCATION_READ_FAILED", "Unable to retrieve planting location.");
  }
}

async function createLocation(req, res) {
  if (!canManage(req, res)) return;
  const parsed = validateLocationInput(req.body || {});
  if (parsed.error) return sendError(res, 400, "INVALID_LOCATION", parsed.error);
  try {
    const location = await prisma.$transaction(async (tx) => {
      const created = await tx.plantingLocation.create({
        data: { ...parsed.data, createdById: req.user.id },
        select: LOCATION_SELECT,
      });
      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: "PLANTING_LOCATION_CREATED",
          entityType: "PlantingLocation",
          entityId: created.id,
          description: "Planting location created.",
          metadata: { slug: created.slug, isPublic: created.isPublic },
        },
      });
      return created;
    });
    return res.status(201).json({ success: true, location });
  } catch (error) {
    console.error("Create planting location failed:", { code: error.code || "UNKNOWN" });
    if (error.code === "P2002") {
      return sendError(res, 409, "LOCATION_SLUG_EXISTS", "A location with this slug already exists.");
    }
    return sendError(res, 500, "LOCATION_CREATE_FAILED", "Unable to create planting location.");
  }
}

async function updateLocation(req, res) {
  if (!canManage(req, res)) return;
  const parsed = validateLocationInput(req.body || {}, { partial: true });
  if (parsed.error) return sendError(res, 400, "INVALID_LOCATION", parsed.error);
  if (!Object.keys(parsed.data).length) {
    return sendError(res, 400, "EMPTY_UPDATE", "Provide at least one location field to update.");
  }
  try {
    const location = await prisma.$transaction(async (tx) => {
      const updated = await tx.plantingLocation.update({
        where: { id: req.params.id },
        data: parsed.data,
        select: LOCATION_SELECT,
      });
      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: "PLANTING_LOCATION_UPDATED",
          entityType: "PlantingLocation",
          entityId: updated.id,
          description: "Planting location updated.",
          metadata: { fields: Object.keys(parsed.data) },
        },
      });
      return updated;
    });
    return res.json({ success: true, location });
  } catch (error) {
    console.error("Update planting location failed:", { code: error.code || "UNKNOWN" });
    if (error.code === "P2025") {
      return sendError(res, 404, "NOT_FOUND", "Planting location not found.");
    }
    if (error.code === "P2002") {
      return sendError(res, 409, "LOCATION_SLUG_EXISTS", "A location with this slug already exists.");
    }
    return sendError(res, 500, "LOCATION_UPDATE_FAILED", "Unable to update planting location.");
  }
}

module.exports = {
  getAll,
  getManageableLocations,
  getPublicLocation,
  createLocation,
  updateLocation,
};
