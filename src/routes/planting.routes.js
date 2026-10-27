
const express = require("express");

const {
  createPlanting,
  getPlantings,
  approvePlanting,
  rejectPlanting,
  verifyPlanting,
  markPlantingAsTestData,
} = require("../controllers/planting.controller");

const { requireAuth } = require("../middleware/auth.middleware");

const router = express.Router();

router.get("/", requireAuth, getPlantings);
router.post("/", requireAuth, createPlanting);

router.patch("/:id/approve", requireAuth, approvePlanting);
router.patch("/:id/reject", requireAuth, rejectPlanting);
router.patch("/:id/verify", requireAuth, verifyPlanting);
router.patch("/:id/mark-test-data", requireAuth, markPlantingAsTestData);

module.exports = router;
