const express = require("express");
const {
  createGrowthUpdate,
  listByPlantingRecord,
  listByLocation,
  listPublicByPlantingRecord,
  listPublicByLocation,
  getGrowthUpdate,
  getPublicGrowthUpdate,
  approveGrowthUpdate,
  rejectGrowthUpdate,
} = require("../controllers/growth-update.controller");
const { requireAuth } = require("../middleware/auth.middleware");

const router = express.Router();

router.get("/public/plantings/:plantingRecordId", listPublicByPlantingRecord);
router.get("/public/locations/:locationId", listPublicByLocation);
router.get("/public/:id", getPublicGrowthUpdate);

router.post("/", requireAuth, createGrowthUpdate);
router.get("/plantings/:plantingRecordId", requireAuth, listByPlantingRecord);
router.get("/locations/:locationId", requireAuth, listByLocation);
router.patch("/:id/approve", requireAuth, approveGrowthUpdate);
router.patch("/:id/reject", requireAuth, rejectGrowthUpdate);
router.get("/:id", requireAuth, getGrowthUpdate);

module.exports = router;
