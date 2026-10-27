
const { prisma } = require("../config/database");

const REVIEW_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "PROGRAMME_MANAGER",
  "REVIEWER",
];
const TEST_DATA_ROLES = ["SUPER_ADMIN", "ADMIN"];
const SUBMISSION_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "PROGRAMME_MANAGER",
  "REVIEWER",
  "DATA_ENTRY_OFFICER",
];
const COMMERCE_LINK_ROLES = ["SUPER_ADMIN", "ADMIN", "PROGRAMME_MANAGER"];
const PLANTING_FIELDS = [
  "id", "referenceCode", "title", "description", "quantity", "plantingDate",
  "latitude", "longitude", "siteName", "locationNotes", "photoUrls",
  "evidenceNotes", "speciesId", "locationId", "eventId", "submittedById",
  "reviewedById", "reviewedAt", "reviewNotes", "rejectionReason",
  "verifiedById", "verifiedAt", "verificationNotes", "isTestData", "status",
  "createdAt", "updatedAt",
];
const SPECIES_FIELDS = [
  "id", "name", "scientificName", "description", "imageUrl", "isNative",
  "isActive", "createdById", "createdAt", "updatedAt",
];
const LOCATION_FIELDS = [
  "id", "name", "slug", "description", "address", "community",
  "localGovernment", "state", "country", "latitude", "longitude", "imageUrl",
  "isPublic", "createdById", "createdAt", "updatedAt",
];

function plantingSelect(extra = {}) {
  return {
    ...Object.fromEntries(PLANTING_FIELDS.map((field) => [field, true])),
    ...(process.env.COMMERCE_SCHEMA_ENABLED === "true"
      ? { treeOrderId: true, treeDonationId: true }
      : {}),
    ...extra,
  };
}

class CommerceLinkError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommerceLinkError";
  }
}

async function validateCommerceLink(tx, data) {
  if (!data.treeOrderId && !data.treeDonationId) return;
  if (data.treeOrderId && data.treeDonationId) {
    throw new CommerceLinkError("A planting record cannot be linked to both an order and a donation.");
  }
  if (!data.speciesId) {
    throw new CommerceLinkError("A species is required to link a planting record to a commerce checkout.");
  }

  if (data.treeOrderId) {
    // Touching the checkout row serializes quantity checks for concurrent batches.
    const locked = await tx.treeOrder.updateMany({
      where: {
        id: data.treeOrderId,
        status: { in: ["PAID", "PROCESSING"] },
        paymentStatus: "SUCCESSFUL",
        locationReviewStatus: "APPROVED",
      },
      data: { updatedAt: new Date() },
    });
    if (!locked.count) {
      throw new CommerceLinkError("Only paid orders with an approved requested location can be fulfilled.");
    }
    const order = await tx.treeOrder.findUnique({
      where: { id: data.treeOrderId },
      include: { items: { select: { speciesId: true, quantity: true } } },
    });
    const item = order.items.find(({ speciesId }) => speciesId === data.speciesId);
    if (!item) throw new CommerceLinkError("The planting species is not part of this order.");

    const linkedRecords = await tx.plantingRecord.findMany({
      where: { treeOrderId: order.id, isTestData: false, status: { not: "REJECTED" } },
      select: { speciesId: true, quantity: true },
    });
    const requestedQuantity = order.items
      .filter(({ speciesId }) => speciesId === data.speciesId)
      .reduce((sum, orderItem) => sum + orderItem.quantity, 0);
    const alreadyLinked = linkedRecords
      .filter(({ speciesId }) => speciesId === data.speciesId)
      .reduce((sum, record) => sum + record.quantity, 0);
    if (alreadyLinked + data.quantity > requestedQuantity) {
      throw new CommerceLinkError("The planting quantity exceeds the remaining quantity on this order.");
    }
    return;
  }

  const locked = await tx.treeDonation.updateMany({
    where: { id: data.treeDonationId, paymentStatus: "SUCCESSFUL" },
    data: { updatedAt: new Date() },
  });
  if (!locked.count) {
    throw new CommerceLinkError("Only a successfully paid donation can be fulfilled.");
  }
  const donation = await tx.treeDonation.findUnique({
    where: { id: data.treeDonationId },
    select: { id: true, speciesId: true, quantity: true },
  });
  if (!donation || donation.speciesId !== data.speciesId) {
    throw new CommerceLinkError("The planting species does not match this donation.");
  }
  const linkedRecords = await tx.plantingRecord.findMany({
    where: { treeDonationId: donation.id, isTestData: false, status: { not: "REJECTED" } },
    select: { quantity: true },
  });
  const alreadyLinked = linkedRecords.reduce((sum, record) => sum + record.quantity, 0);
  if (alreadyLinked + data.quantity > donation.quantity) {
    throw new CommerceLinkError("The planting quantity exceeds the remaining quantity on this donation.");
  }
}

async function syncCommercePlantingProgress(tx, planting) {
  if (planting.treeOrderId) {
    const order = await tx.treeOrder.findUnique({
      where: { id: planting.treeOrderId },
      include: {
        items: { select: { speciesId: true, quantity: true } },
        plantingRecords: {
          where: { isTestData: false },
          select: { speciesId: true, quantity: true, status: true, verifiedAt: true, verifiedById: true },
        },
      },
    });
    if (!order) return;
    const hasRejected = order.plantingRecords.some(({ status }) => status === "REJECTED");
    const activeRecords = order.plantingRecords.filter(({ status }) => status !== "REJECTED");
    const expectedBySpecies = new Map();
    for (const item of order.items) {
      expectedBySpecies.set(
        item.speciesId,
        (expectedBySpecies.get(item.speciesId) || 0) + item.quantity
      );
    }
    const linkedBySpecies = new Map();
    for (const record of activeRecords) {
      linkedBySpecies.set(
        record.speciesId,
        [...(linkedBySpecies.get(record.speciesId) || []), record]
      );
    }
    const complete = expectedBySpecies.size > 0 &&
      linkedBySpecies.size === expectedBySpecies.size &&
      [...expectedBySpecies].every(([speciesId, expectedQuantity]) => {
      const speciesRecords = linkedBySpecies.get(speciesId) || [];
      const quantity = speciesRecords.reduce((sum, record) => sum + record.quantity, 0);
      return quantity === expectedQuantity && speciesRecords.every(
        (record) => record.status === "APPROVED" && record.verifiedAt && record.verifiedById
      );
    });
    await tx.treeOrder.update({
      where: { id: order.id },
      data: complete
        ? {
            status: "COMPLETED",
            fulfilmentStatus: "PLANTED",
            plantingVerificationStatus: "VERIFIED",
          }
        : {
            status: "PROCESSING",
            fulfilmentStatus: "VERIFICATION_PENDING",
            plantingVerificationStatus: hasRejected ? "REJECTED" : "PENDING",
          },
    });
  } else if (planting.treeDonationId) {
    const donation = await tx.treeDonation.findUnique({
      where: { id: planting.treeDonationId },
      include: {
        plantingRecords: {
          where: { isTestData: false },
          select: { speciesId: true, quantity: true, status: true, verifiedAt: true, verifiedById: true },
        },
      },
    });
    if (!donation) return;
    const hasRejected = donation.plantingRecords.some(({ status }) => status === "REJECTED");
    const activeRecords = donation.plantingRecords.filter(({ status }) => status !== "REJECTED");
    const quantity = activeRecords.reduce((sum, record) => sum + record.quantity, 0);
    const complete = quantity === donation.quantity &&
      activeRecords.every(
        (record) =>
          record.speciesId === donation.speciesId &&
          record.status === "APPROVED" &&
          record.verifiedAt &&
          record.verifiedById
      );
    await tx.treeDonation.update({
      where: { id: donation.id },
      data: {
        plantingVerificationStatus: complete
          ? "VERIFIED"
          : hasRejected
            ? "REJECTED"
            : quantity
              ? "PENDING"
              : "NOT_STARTED",
      },
    });
  }
}

function canReview(req, res) {
  if (!REVIEW_ROLES.includes(req.user?.role)) {
    res.status(403).json({
      success: false,
      message: "You are not authorized to review planting records.",
    });
    return false;
  }

  return true;
}

async function createPlanting(req, res) {
  if (!SUBMISSION_ROLES.includes(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: "You are not authorized to submit planting records.",
    });
  }

  try {
    const {
      title, description, quantity, plantingDate,
      latitude, longitude, siteName, locationNotes,
      photoUrls, evidenceNotes, speciesId, locationId, eventId,
      treeOrderId, treeDonationId,
    } = req.body || {};
    const hasCommerceLink = Boolean(treeOrderId || treeDonationId);
    if (hasCommerceLink && process.env.COMMERCE_SCHEMA_ENABLED !== "true") {
      return res.status(503).json({
        success: false,
        message: "Commerce planting links are unavailable until the approved database schema is applied and enabled.",
      });
    }
    if (hasCommerceLink && !COMMERCE_LINK_ROLES.includes(req.user?.role)) {
      return res.status(403).json({
        success: false,
        message: "Only authorized programme administrators can link planting to a commerce checkout.",
      });
    }
    if (
      (treeOrderId !== undefined && treeOrderId !== null && typeof treeOrderId !== "string") ||
      (treeDonationId !== undefined && treeDonationId !== null && typeof treeDonationId !== "string") ||
      (treeOrderId && treeDonationId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Provide at most one valid commerce checkout link.",
      });
    }

    if (
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      quantity > 2147483647
    ) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be a positive whole number.",
      });
    }

    const validPlantingDate =
      typeof plantingDate === "string" &&
      /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(plantingDate) &&
      !Number.isNaN(Date.parse(plantingDate)) &&
      (() => {
        const [year, month, day] = plantingDate.slice(0, 10).split("-").map(Number);
        const date = new Date(Date.UTC(year, month - 1, day));
        return date.getUTCFullYear() === year &&
          date.getUTCMonth() + 1 === month &&
          date.getUTCDate() === day;
      })();

    if (!validPlantingDate) {
      return res.status(400).json({
        success: false,
        message: "A valid planting date is required.",
      });
    }

    const hasLatitude =
      latitude !== undefined && latitude !== null && latitude !== "";
    const hasLongitude =
      longitude !== undefined && longitude !== null && longitude !== "";

    if (hasLatitude !== hasLongitude) {
      return res.status(400).json({
        success: false,
        message: "Provide both latitude and longitude.",
      });
    }

    const data = {
      title: title || null,
      description: description || null,
      quantity,
      plantingDate: new Date(plantingDate),
      siteName: siteName || null,
      locationNotes: locationNotes || null,
      photoUrls: photoUrls === undefined ? [] : photoUrls,
      evidenceNotes: evidenceNotes || null,
      speciesId: speciesId || null,
      locationId: locationId || null,
      eventId: eventId || null,
      submittedById: req.user.id,
      status: "PENDING",
    };
    if (treeOrderId) data.treeOrderId = treeOrderId;
    if (treeDonationId) data.treeDonationId = treeDonationId;

    if (hasLatitude && hasLongitude) {
      const lat =
        typeof latitude === "string" && latitude.trim()
          ? Number(latitude)
          : latitude;
      const lng =
        typeof longitude === "string" && longitude.trim()
          ? Number(longitude)
          : longitude;

      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat < -90 || lat > 90 ||
        lng < -180 || lng > 180
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid GPS coordinates.",
        });
      }

      data.latitude = lat;
      data.longitude = lng;
    }

    if (
      !Array.isArray(data.photoUrls) ||
      data.photoUrls.length > 20 ||
      !data.photoUrls.every((value) => {
        if (typeof value !== "string" || value.length > 2048) return false;
        try {
          const url = new URL(value);
          return url.protocol === "https:" || url.protocol === "http:";
        } catch {
          return false;
        }
      })
    ) {
      return res.status(400).json({
        success: false,
        message: "photoUrls must be an array of non-empty strings.",
      });
    }

    const planting = await prisma.$transaction(async (tx) => {
      await validateCommerceLink(tx, data);
      const created = await tx.plantingRecord.create({
        data,
        select: plantingSelect({
          species: { select: Object.fromEntries(SPECIES_FIELDS.map((field) => [field, true])) },
          location: { select: Object.fromEntries(LOCATION_FIELDS.map((field) => [field, true])) },
        }),
      });
      if (created.treeOrderId) {
        await tx.treeOrder.updateMany({
          where: { id: created.treeOrderId, status: "PAID" },
          data: { status: "PROCESSING" },
        });
        await tx.treeOrder.update({
          where: { id: created.treeOrderId },
          data: {
            fulfilmentStatus: "VERIFICATION_PENDING",
            plantingVerificationStatus: "PENDING",
          },
        });
      } else if (created.treeDonationId) {
        await tx.treeDonation.update({
          where: { id: created.treeDonationId },
          data: { plantingVerificationStatus: "PENDING" },
        });
      }
      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: "PLANTING_SUBMITTED",
          entityType: "PlantingRecord",
          entityId: created.id,
          description: "Planting record submitted for review.",
          metadata: {
            quantity: created.quantity,
            plantingDate: created.plantingDate.toISOString(),
            status: created.status,
            treeOrderId: created.treeOrderId || null,
            treeDonationId: created.treeDonationId || null,
          },
        },
      });
      return created;
    });

    return res.status(201).json({
      success: true,
      message: "Planting record submitted for review.",
      planting,
    });
  } catch (error) {
    console.error("Create planting error:", error.message);

    if (error instanceof CommerceLinkError) {
      return res.status(400).json({ success: false, message: error.message });
    }
    if (error.code === "P2021" || error.code === "P2022") {
      return res.status(503).json({
        success: false,
        message: "Commerce planting links are unavailable until the approved database schema is applied.",
      });
    }
    if (error.code === "P2003" || error.code === "P2025") {
      return res.status(400).json({
        success: false,
        message: "A referenced species, location, or event was not found.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Unable to create planting record.",
    });
  }
}

async function getPlantings(req, res) {
  try {
    const plantings = await prisma.plantingRecord.findMany({
      orderBy: { createdAt: "desc" },
      select: plantingSelect({
        species: { select: Object.fromEntries(SPECIES_FIELDS.map((field) => [field, true])) },
        location: { select: Object.fromEntries(LOCATION_FIELDS.map((field) => [field, true])) },
        submittedBy: {
          select: { id: true, fullName: true, email: true },
        },
        reviewedBy: {
          select: { id: true, fullName: true },
        },
      }),
    });

    return res.json({
      success: true,
      count: plantings.length,
      plantings,
    });
  } catch (error) {
    console.error("Get plantings error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to retrieve planting records.",
    });
  }
}

async function reviewPlanting(req, res, status) {
  if (!canReview(req, res)) return;

  const { id } = req.params;
  const rejectionReason =
    typeof req.body?.rejectionReason === "string"
      ? req.body.rejectionReason.trim()
      : "";

  if (
    status === "REJECTED" &&
    (!rejectionReason || rejectionReason.length > 2000)
  ) {
    return res.status(400).json({
      success: false,
      message:
        "A rejection reason between 1 and 2000 characters is required.",
    });
  }

  try {
    const data = {
      status,
      reviewedById: req.user.id,
      reviewedAt: new Date(),
    };

    if (status === "REJECTED") {
      data.rejectionReason = rejectionReason;
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const result = await tx.plantingRecord.updateMany({
        where: { id, status: "PENDING" },
        data,
      });

      if (result.count === 0) {
        const existing = await tx.plantingRecord.findUnique({
          where: { id },
          select: { id: true, status: true },
        });

        return existing
          ? { conflictStatus: existing.status }
          : { notFound: true };
      }

      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: status === "APPROVED" ? "PLANTING_APPROVED" : "PLANTING_REJECTED",
          entityType: "PlantingRecord",
          entityId: id,
          description:
            status === "APPROVED"
              ? "Planting record approved."
              : "Planting record rejected.",
          metadata: { status },
        },
      });

      const planting = await tx.plantingRecord.findUnique({
        where: { id },
        select: plantingSelect({
          reviewedBy: { select: { id: true, fullName: true } },
        }),
      });
      await syncCommercePlantingProgress(tx, planting);

      return { planting };
    });

    if (outcome.notFound) {
      return res.status(404).json({
        success: false,
        message: "Planting record not found.",
      });
    }

    if (outcome.conflictStatus) {
      return res.status(409).json({
        success: false,
        message: `This planting record has already been reviewed (status: ${outcome.conflictStatus}).`,
      });
    }

    return res.json({
      success: true,
      message:
        status === "APPROVED"
          ? "Planting record approved successfully."
          : "Planting record rejected successfully.",
      planting: outcome.planting,
    });
  } catch (error) {
    console.error("Review planting error:", {
      code: error.code || "UNKNOWN",
    });
    return res.status(500).json({
      success: false,
      message: "Unable to review planting record.",
    });
  }
}

async function verifyPlanting(req, res) {
  if (!canReview(req, res)) return;

  const { id } = req.params;
  const verificationNotes =
    typeof req.body?.verificationNotes === "string"
      ? req.body.verificationNotes.trim()
      : "";

  if (!verificationNotes || verificationNotes.length > 2000) {
    return res.status(400).json({
      success: false,
      message:
        "Verification notes between 1 and 2000 characters are required.",
    });
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const result = await tx.plantingRecord.updateMany({
        where: {
          id,
          status: "APPROVED",
          isTestData: false,
          verifiedAt: null,
          verifiedById: null,
          submittedById: { not: req.user.id },
          reviewedById: { not: req.user.id },
        },
        data: {
          verifiedById: req.user.id,
          verifiedAt: new Date(),
          verificationNotes,
        },
      });

      if (result.count === 0) {
        const existing = await tx.plantingRecord.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            isTestData: true,
            verifiedAt: true,
            submittedById: true,
            reviewedById: true,
          },
        });

        return existing ? { conflict: true } : { notFound: true };
      }

      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: "PLANTING_VERIFIED",
          entityType: "PlantingRecord",
          entityId: id,
          description: "Planting evidence verified.",
          metadata: { status: "APPROVED" },
        },
      });

      const planting = await tx.plantingRecord.findUnique({
          where: { id },
          select: plantingSelect({
            verifiedBy: { select: { id: true, fullName: true } },
          }),
        });
      await syncCommercePlantingProgress(tx, planting);
      return { planting };
    });

    if (outcome.notFound) {
      return res.status(404).json({
        success: false,
        message: "Planting record not found.",
      });
    }

    if (outcome.conflict) {
      return res.status(409).json({
        success: false,
        message:
          "Only an approved, unverified, non-test record can be verified by someone other than its submitter and approver.",
      });
    }

    return res.json({
      success: true,
      message: "Planting evidence verified successfully.",
      planting: outcome.planting,
    });
  } catch (error) {
    console.error("Verify planting error:", {
      code: error.code || "UNKNOWN",
    });
    return res.status(500).json({
      success: false,
      message: "Unable to verify planting evidence.",
    });
  }
}

async function markPlantingAsTestData(req, res) {
  if (!TEST_DATA_ROLES.includes(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: "Only administrators can mark records as test data.",
    });
  }

  const reason =
    typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason || reason.length > 2000) {
    return res.status(400).json({
      success: false,
      message: "A reason between 1 and 2000 characters is required.",
    });
  }

  const { id } = req.params;

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const result = await tx.plantingRecord.updateMany({
        where: { id, isTestData: false },
        data: {
          isTestData: true,
          verifiedAt: null,
          verifiedById: null,
        },
      });

      if (result.count === 0) {
        const existing = await tx.plantingRecord.findUnique({
          where: { id },
          select: { id: true, isTestData: true },
        });

        return existing ? { conflict: true } : { notFound: true };
      }

      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: "PLANTING_MARKED_TEST_DATA",
          entityType: "PlantingRecord",
          entityId: id,
          description: "Planting record marked as test data.",
          metadata: { reason },
        },
      });

      const planting = await tx.plantingRecord.findUnique({
          where: { id },
        select: {
            id: true,
            status: true,
            isTestData: true,
          ...(process.env.COMMERCE_SCHEMA_ENABLED === "true"
            ? { treeOrderId: true, treeDonationId: true }
            : {}),
        },
      });
      await syncCommercePlantingProgress(tx, planting);
      return { planting };
    });

    if (outcome.notFound) {
      return res.status(404).json({
        success: false,
        message: "Planting record not found.",
      });
    }

    if (outcome.conflict) {
      return res.status(409).json({
        success: false,
        message: "This record is already marked as test data.",
      });
    }

    return res.json({
      success: true,
      message: "Planting record excluded from public statistics.",
      planting: outcome.planting,
    });
  } catch (error) {
    console.error("Mark planting as test data error:", {
      code: error.code || "UNKNOWN",
    });
    return res.status(500).json({
      success: false,
      message: "Unable to mark planting record as test data.",
    });
  }
}

async function approvePlanting(req, res) {
  return reviewPlanting(req, res, "APPROVED");
}

async function rejectPlanting(req, res) {
  return reviewPlanting(req, res, "REJECTED");
}

module.exports = {
  createPlanting,
  getPlantings,
  approvePlanting,
  rejectPlanting,
  verifyPlanting,
  markPlantingAsTestData,
};
