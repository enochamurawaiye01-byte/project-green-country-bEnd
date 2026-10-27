const express = require("express");
const {
  getAll,
  getPublicStatsRoute,
  getPlantingReport,
  exportPlantingCsv,
} = require("../controllers/report.controller");
const { requireAuth } = require("../middleware/auth.middleware");

const router = express.Router();
router.get("/", getAll);
router.get("/public-stats", getPublicStatsRoute);
router.get("/plantings", requireAuth, getPlantingReport);
router.get("/plantings.csv", requireAuth, exportPlantingCsv);

module.exports = router;
