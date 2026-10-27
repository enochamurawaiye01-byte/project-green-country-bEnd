const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../src/config/database");
const storageService = require("../src/services/evidence-storage.service");
const { uploadEvidence, getEvidence } = require("../src/controllers/media.controller");

const originalTransaction = prisma.$transaction;
const originalFindUnique = prisma.mediaAsset.findUnique;
const originalStorage = storageService.getPrivateEvidenceStorage;

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test.afterEach(() => {
  prisma.$transaction = originalTransaction;
  prisma.mediaAsset.findUnique = originalFindUnique;
  storageService.getPrivateEvidenceStorage = originalStorage;
});

test("evidence upload verifies the file signature and always writes to private storage", async () => {
  let uploadedPath;
  let assetData;
  let audit;
  storageService.getPrivateEvidenceStorage = async () => ({
    bucketName: "private-evidence",
    storage: {
      async upload(path, _buffer, options) {
        uploadedPath = path;
        assert.equal(options.contentType, "image/png");
        assert.equal(options.upsert, false);
        return { error: null };
      },
      async remove() {
        return { error: null };
      },
    },
  });
  prisma.$transaction = async (callback) => callback({
    mediaAsset: {
      async create({ data }) {
        assetData = data;
        return { id: "asset-1", ...data, sizeBytes: BigInt(data.sizeBytes) };
      },
    },
    auditLog: {
      async create({ data }) {
        audit = data;
      },
    },
  });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const res = response();

  await uploadEvidence({
    user: { id: "uploader-1" },
    file: { buffer: png, size: png.length, mimetype: "image/png", originalname: "..\\private.png" },
    body: { altText: "Planting evidence" },
  }, res);

  assert.equal(res.statusCode, 201);
  assert.match(uploadedPath, /^uploader-1\/[a-f0-9-]+\.png$/i);
  assert.equal(assetData.isPublic, false);
  assert.equal(assetData.fileUrl.startsWith("supabase://private-evidence/"), true);
  assert.equal(assetData.storagePath, uploadedPath);
  assert.equal(assetData.altText, "Planting evidence");
  assert.equal(audit.action, "EVIDENCE_UPLOADED");
});

test("spoofed file types and unexpected metadata are rejected before storage writes", async () => {
  let storageCalls = 0;
  storageService.getPrivateEvidenceStorage = async () => {
    storageCalls += 1;
    throw new Error("Storage should not be requested for invalid input.");
  };
  const spoofed = response();
  await uploadEvidence({
    user: { id: "uploader-1" },
    file: { buffer: Buffer.from("<svg/>"), size: 6, mimetype: "image/svg+xml", originalname: "image.svg" },
    body: {},
  }, spoofed);
  assert.equal(spoofed.statusCode, 400);

  const unexpected = response();
  await uploadEvidence({
    user: { id: "uploader-1" },
    file: {
      buffer: Buffer.from([0xff, 0xd8, 0xff]),
      size: 3,
      mimetype: "image/jpeg",
      originalname: "image.jpg",
    },
    body: { isPublic: true },
  }, unexpected);
  assert.equal(unexpected.statusCode, 400);
  assert.equal(storageCalls, 0);
});

test("private evidence retrieval hides other users' files and returns a short-lived URL to its owner", async () => {
  let signedPath;
  prisma.mediaAsset.findUnique = async () => ({
    id: "asset-1",
    name: "evidence.png",
    storagePath: "uploader-1/object.png",
    mimeType: "image/png",
    mediaType: "PHOTO",
    sizeBytes: 100n,
    altText: null,
    caption: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    uploadedById: "uploader-1",
    isPublic: false,
  });
  storageService.getPrivateEvidenceStorage = async () => ({
    storage: {
      async createSignedUrl(path, expiresIn) {
        signedPath = path;
        assert.equal(expiresIn, 300);
        return { data: { signedUrl: "https://storage.example/signed" }, error: null };
      },
    },
  });
  const denied = response();
  await getEvidence({ params: { id: "asset-1" }, user: { id: "other-user", role: "DATA_ENTRY_OFFICER" } }, denied);
  assert.equal(denied.statusCode, 404);
  assert.equal(signedPath, undefined);

  const allowed = response();
  await getEvidence({ params: { id: "asset-1" }, user: { id: "uploader-1", role: "DATA_ENTRY_OFFICER" } }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(signedPath, "uploader-1/object.png");
  assert.equal(allowed.body.signedUrl, "https://storage.example/signed");
  assert.equal(allowed.body.asset.sizeBytes, 100);
});
