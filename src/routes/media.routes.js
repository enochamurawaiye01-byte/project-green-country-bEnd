const express = require("express");
const multer = require("multer");
const { rateLimit } = require("express-rate-limit");
const { requireAuth } = require("../middleware/auth.middleware");
const { uploadEvidence, getEvidence, MAX_FILE_BYTES } = require("../controllers/media.controller");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 1024 },
});
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

function receiveEvidence(req, res, next) {
  upload.single("file")(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        success: false,
        error: {
          code: tooLarge ? "FILE_TOO_LARGE" : "INVALID_UPLOAD",
          message: tooLarge
            ? "Evidence files must be 5 MB or smaller."
            : "Provide one file and at most two metadata fields.",
        },
      });
    }
    if (error) return next(error);
    return next();
  });
}

router.post("/", requireAuth, uploadLimiter, receiveEvidence, uploadEvidence);
router.get("/:id", requireAuth, getEvidence);

module.exports = router;
