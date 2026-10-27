const { prisma } = require("../config/database");

const MANAGER_ROLES = ["SUPER_ADMIN", "ADMIN"];
const PUBLIC_SPECIES_SELECT = {
  id: true,
  name: true,
  scientificName: true,
  description: true,
  imageUrl: true,
  priceKobo: true,
};
const ADMIN_SPECIES_SELECT = {
  ...PUBLIC_SPECIES_SELECT,
  isActive: true,
  isPublished: true,
  createdAt: true,
  updatedAt: true,
};
const STRING_LIMITS = {
  name: 160,
  scientificName: 200,
  description: 5000,
  imageUrl: 2048,
};

function sendError(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

function isManager(req, res) {
  if (MANAGER_ROLES.includes(req.user?.role)) return true;
  sendError(res, 403, "FORBIDDEN", "You are not authorized to manage the tree catalogue.");
  return false;
}

function parsePage(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

function validateSpecies(body, { partial = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "A JSON object is required." };
  }
  const allowed = new Set([
    ...Object.keys(STRING_LIMITS),
    "priceKobo",
    "isActive",
  ]);
  if (Object.keys(body).some((field) => !allowed.has(field))) {
    return { error: "The request contains unsupported fields." };
  }

  const data = {};
  for (const [field, maxLength] of Object.entries(STRING_LIMITS)) {
    if (body[field] === undefined) {
      if (!partial && field === "name") return { error: "name is required." };
      continue;
    }
    const value = body[field];
    if (value === null && field !== "name" && field !== "imageUrl") {
      data[field] = null;
      continue;
    }
    if (typeof value !== "string" || value.length > maxLength) {
      return { error: `${field} must be a string of at most ${maxLength} characters.` };
    }
    const normalized = value.trim();
    if (field === "name" && !normalized) return { error: "name is required." };
    if (field === "imageUrl" && normalized) {
      try {
        const url = new URL(normalized);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid URL scheme.");
      } catch {
        return { error: "imageUrl must be a valid HTTP or HTTPS URL." };
      }
    }
    data[field] = normalized || (field === "name" ? "" : null);
  }

  if (body.priceKobo !== undefined) {
    if (!Number.isSafeInteger(body.priceKobo) || body.priceKobo < 0 || body.priceKobo > 2147483647) {
      return { error: "priceKobo must be a non-negative integer amount in kobo." };
    }
    data.priceKobo = body.priceKobo;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") return { error: "isActive must be a boolean." };
    data.isActive = body.isActive;
  }
  if (!partial && data.priceKobo === undefined) {
    return { error: "priceKobo is required." };
  }
  return { data };
}

function schemaUnavailable(error) {
  return error.code === "P2021" || error.code === "P2022";
}

async function listPublicSpecies(req, res) {
  const page = parsePage(req.query.page, 1, 100000);
  const limit = parsePage(req.query.limit, 20, 100);
  if (page === null || limit === null) {
    return sendError(res, 400, "INVALID_PAGINATION", "page and limit must be positive integers; limit cannot exceed 100.");
  }
  try {
    const where = {
      isActive: true,
      isPublished: true,
      priceKobo: { gt: 0 },
      ...(typeof req.query.search === "string" && req.query.search.trim()
        ? { name: { contains: req.query.search.trim(), mode: "insensitive" } }
        : {}),
    };
    const [species, total] = await prisma.$transaction([
      prisma.treeSpecies.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (page - 1) * limit,
        take: limit,
        select: PUBLIC_SPECIES_SELECT,
      }),
      prisma.treeSpecies.count({ where }),
    ]);
    return res.json({
      success: true,
      page,
      limit,
      total,
      count: species.length,
      trees: species,
    });
  } catch (error) {
    console.error("List public tree catalogue failed:", { code: error.code || "UNKNOWN" });
    if (schemaUnavailable(error)) {
      return sendError(res, 503, "CATALOGUE_SCHEMA_UNAVAILABLE", "The tree catalogue is unavailable until the approved database schema is applied.");
    }
    return sendError(res, 500, "CATALOGUE_LIST_FAILED", "Unable to retrieve the tree catalogue.");
  }
}

async function listAdminSpecies(req, res) {
  if (!isManager(req, res)) return;
  try {
    const species = await prisma.treeSpecies.findMany({
      orderBy: { name: "asc" },
      select: ADMIN_SPECIES_SELECT,
    });
    return res.json({ success: true, count: species.length, trees: species });
  } catch (error) {
    console.error("List admin tree catalogue failed:", { code: error.code || "UNKNOWN" });
    if (schemaUnavailable(error)) {
      return sendError(res, 503, "CATALOGUE_SCHEMA_UNAVAILABLE", "The tree catalogue is unavailable until the approved database schema is applied.");
    }
    return sendError(res, 500, "CATALOGUE_LIST_FAILED", "Unable to retrieve the tree catalogue.");
  }
}

async function createSpecies(req, res) {
  if (!isManager(req, res)) return;
  const parsed = validateSpecies(req.body);
  if (parsed.error) return sendError(res, 400, "INVALID_TREE", parsed.error);
  try {
    const tree = await prisma.$transaction(async (tx) => {
      const created = await tx.treeSpecies.create({
        data: {
          ...parsed.data,
          isPublished: false,
          createdById: req.user.id,
        },
        select: ADMIN_SPECIES_SELECT,
      });
      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: "TREE_SPECIES_CREATED",
          entityType: "TreeSpecies",
          entityId: created.id,
          description: "Tree species added to the catalogue.",
          metadata: { isPublished: created.isPublished, priceKobo: created.priceKobo },
        },
      });
      return created;
    });
    return res.status(201).json({ success: true, tree });
  } catch (error) {
    console.error("Create tree species failed:", { code: error.code || "UNKNOWN" });
    if (error.code === "P2002") return sendError(res, 409, "TREE_NAME_EXISTS", "A tree with this name already exists.");
    if (error.code === "P2003") return sendError(res, 404, "CREATOR_NOT_FOUND", "The creating account was not found.");
    if (schemaUnavailable(error)) return sendError(res, 503, "CATALOGUE_SCHEMA_UNAVAILABLE", "The approved catalogue schema has not been applied.");
    return sendError(res, 500, "TREE_CREATE_FAILED", "Unable to create the tree type.");
  }
}

async function updateSpecies(req, res) {
  if (!isManager(req, res)) return;
  const parsed = validateSpecies(req.body, { partial: true });
  if (parsed.error) return sendError(res, 400, "INVALID_TREE", parsed.error);
  if (!Object.keys(parsed.data).length) return sendError(res, 400, "EMPTY_UPDATE", "Provide at least one tree field to update.");
  try {
    const tree = await prisma.$transaction(async (tx) => {
      const updated = await tx.treeSpecies.update({
        where: { id: req.params.id },
        data: parsed.data,
        select: ADMIN_SPECIES_SELECT,
      });
      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: "TREE_SPECIES_UPDATED",
          entityType: "TreeSpecies",
          entityId: updated.id,
          description: "Tree catalogue entry updated.",
          metadata: { fields: Object.keys(parsed.data) },
        },
      });
      return updated;
    });
    return res.json({ success: true, tree });
  } catch (error) {
    console.error("Update tree species failed:", { code: error.code || "UNKNOWN" });
    if (error.code === "P2025") return sendError(res, 404, "TREE_NOT_FOUND", "Tree type not found.");
    if (error.code === "P2002") return sendError(res, 409, "TREE_NAME_EXISTS", "A tree with this name already exists.");
    if (schemaUnavailable(error)) return sendError(res, 503, "CATALOGUE_SCHEMA_UNAVAILABLE", "The approved catalogue schema has not been applied.");
    return sendError(res, 500, "TREE_UPDATE_FAILED", "Unable to update the tree type.");
  }
}

async function setPublication(req, res) {
  if (!isManager(req, res)) return;
  if (typeof req.body?.isPublished !== "boolean" ||
      Object.keys(req.body || {}).some((key) => key !== "isPublished")) {
    return sendError(res, 400, "INVALID_PUBLICATION_STATUS", "Provide only a boolean isPublished value.");
  }
  try {
    const tree = await prisma.$transaction(async (tx) => {
      const existing = await tx.treeSpecies.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true, priceKobo: true, isActive: true },
      });
      if (!existing) return null;
      if (req.body.isPublished && (!existing.isActive || !Number.isInteger(existing.priceKobo) || existing.priceKobo <= 0)) {
        return { invalid: true };
      }
      const updated = await tx.treeSpecies.update({
        where: { id: req.params.id },
        data: { isPublished: req.body.isPublished },
        select: ADMIN_SPECIES_SELECT,
      });
      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: req.body.isPublished ? "TREE_SPECIES_PUBLISHED" : "TREE_SPECIES_UNPUBLISHED",
          entityType: "TreeSpecies",
          entityId: updated.id,
          description: req.body.isPublished ? "Tree type published." : "Tree type unpublished.",
          metadata: { isPublished: updated.isPublished },
        },
      });
      return updated;
    });
    if (!tree) return sendError(res, 404, "TREE_NOT_FOUND", "Tree type not found.");
    if (tree.invalid) return sendError(res, 400, "TREE_NOT_SELLABLE", "Only active tree types with a positive price can be published.");
    return res.json({ success: true, tree });
  } catch (error) {
    console.error("Change tree publication failed:", { code: error.code || "UNKNOWN" });
    if (error.code === "P2025") return sendError(res, 404, "TREE_NOT_FOUND", "Tree type not found.");
    if (schemaUnavailable(error)) return sendError(res, 503, "CATALOGUE_SCHEMA_UNAVAILABLE", "The approved catalogue schema has not been applied.");
    return sendError(res, 500, "TREE_PUBLICATION_FAILED", "Unable to update tree publication.");
  }
}

module.exports = {
  listPublicSpecies,
  listAdminSpecies,
  createSpecies,
  updateSpecies,
  setPublication,
};
