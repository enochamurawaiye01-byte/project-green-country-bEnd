const crypto = require("node:crypto");
const { prisma } = require("../config/database");
const storageService = require("../services/evidence-storage.service");

const PRIVATE_MEDIA_ROLES = ["SUPER_ADMIN", "ADMIN", "PROGRAMME_MANAGER", "REVIEWER"];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILE_TYPES = {
  "image/jpeg": { extension: "jpg", mediaType: "PHOTO" },
  "image/png": { extension: "png", mediaType: "PHOTO" },
  "image/webp": { extension: "webp", mediaType: "PHOTO" },
  "application/pdf": { extension: "pdf", mediaType: "DOCUMENT" },
};

function sendError(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

function detectedFileType(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || !FILE_TYPES[file.mimetype]) return null;
  const bytes = file.buffer;
  const matches = {
    "image/jpeg": bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    "image/png": bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/webp": bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP",
    "application/pdf": bytes.length >= 5 && bytes.toString("ascii", 0, 5) === "%PDF-",
  };
  return matches[file.mimetype] ? FILE_TYPES[file.mimetype] : null;
}

function validateMetadata(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (Object.keys(body).some((key) => !["altText", "caption"].includes(key))) return null;
  const metadata = {};
  for (const field of ["altText", "caption"]) {
    const value = body[field];
    if (value === undefined || value === "") {
      metadata[field] = null;
      continue;
    }
    if (typeof value !== "string" || value.trim().length > 500) return null;
    metadata[field] = value.trim() || null;
  }
  return metadata;
}

function publicMediaFields(asset) {
  return {
    id: asset.id,
    name: asset.name,
    mimeType: asset.mimeType,
    mediaType: asset.mediaType,
    sizeBytes: Number(asset.sizeBytes),
    altText: asset.altText,
    caption: asset.caption,
    createdAt: asset.createdAt,
  };
}

async function uploadEvidence(req, res) {
  const file = req.file;
  const metadata = validateMetadata(req.body);
  if (!file) return sendError(res, 400, "FILE_REQUIRED", "Provide one evidence file.");
  if (file.size > MAX_FILE_BYTES || file.buffer.length > MAX_FILE_BYTES) {
    return sendError(res, 413, "FILE_TOO_LARGE", "Evidence files must be 5 MB or smaller.");
  }
  const fileType = detectedFileType(file);
  if (!fileType) {
    return sendError(res, 400, "UNSUPPORTED_FILE_TYPE", "Upload a valid JPEG, PNG, WebP, or PDF file.");
  }
  if (!metadata) {
    return sendError(res, 400, "INVALID_FILE_METADATA", "Only altText and caption fields of at most 500 characters are allowed.");
  }
  const safeName = file.originalname
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  const fileName = safeName || `evidence.${fileType.extension}`;

  let storage;
  let storagePath;
  try {
    storage = await storageService.getPrivateEvidenceStorage();
    storagePath = `${req.user.id}/${crypto.randomUUID()}.${fileType.extension}`;
    const uploaded = await storage.storage.upload(storagePath, file.buffer, {
      contentType: file.mimetype,
      cacheControl: "3600",
      upsert: false,
    });
    if (uploaded.error) {
      return sendError(res, 503, "EVIDENCE_UPLOAD_FAILED", "Evidence could not be stored.");
    }

    const asset = await prisma.$transaction(async (tx) => {
      const created = await tx.mediaAsset.create({
        data: {
          name: fileName,
          fileUrl: `supabase://${storage.bucketName}/${storagePath}`,
          storagePath,
          mimeType: file.mimetype,
          sizeBytes: BigInt(file.buffer.length),
          mediaType: fileType.mediaType,
          altText: metadata.altText,
          caption: metadata.caption,
          isPublic: false,
          uploadedById: req.user.id,
        },
        select: {
          id: true,
          name: true,
          mimeType: true,
          mediaType: true,
          sizeBytes: true,
          altText: true,
          caption: true,
          createdAt: true,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: "EVIDENCE_UPLOADED",
          entityType: "MediaAsset",
          entityId: created.id,
          description: "Private evidence uploaded.",
          metadata: { mediaType: created.mediaType, sizeBytes: file.buffer.length },
        },
      });
      return created;
    });
    return res.status(201).json({ success: true, asset: publicMediaFields(asset) });
  } catch (error) {
    if (storage && storagePath) {
      const cleanup = await storage.storage.remove([storagePath]);
      if (cleanup.error) {
        console.error("Evidence storage cleanup failed:", { code: cleanup.error.code || "UNKNOWN" });
      }
    }
    if (error instanceof storageService.EvidenceStorageError) {
      return sendError(res, 503, error.code, error.message);
    }
    console.error("Evidence upload failed:", { code: error.code || "UNKNOWN" });
    return sendError(res, 500, "EVIDENCE_UPLOAD_FAILED", "Evidence could not be stored.");
  }
}

async function getEvidence(req, res) {
  try {
    const asset = await prisma.mediaAsset.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        name: true,
        storagePath: true,
        mimeType: true,
        mediaType: true,
        sizeBytes: true,
        altText: true,
        caption: true,
        createdAt: true,
        uploadedById: true,
        isPublic: true,
      },
    });
    if (
      !asset ||
      !asset.storagePath ||
      (!PRIVATE_MEDIA_ROLES.includes(req.user.role) && asset.uploadedById !== req.user.id)
    ) {
      return sendError(res, 404, "NOT_FOUND", "Evidence file not found.");
    }
    const { storage } = await storageService.getPrivateEvidenceStorage();
    const { data, error } = await storage.createSignedUrl(asset.storagePath, 300);
    if (error || !data?.signedUrl) {
      return sendError(res, 503, "EVIDENCE_READ_FAILED", "Evidence is temporarily unavailable.");
    }
    return res.json({
      success: true,
      asset: publicMediaFields(asset),
      signedUrl: data.signedUrl,
      expiresInSeconds: 300,
    });
  } catch (error) {
    if (error instanceof storageService.EvidenceStorageError) {
      return sendError(res, 503, error.code, error.message);
    }
    console.error("Evidence retrieval failed:", { code: error.code || "UNKNOWN" });
    return sendError(res, 500, "EVIDENCE_READ_FAILED", "Evidence could not be retrieved.");
  }
}

module.exports = {
  MAX_FILE_BYTES,
  detectedFileType,
  validateMetadata,
  uploadEvidence,
  getEvidence,
};
