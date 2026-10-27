
const express = require("express");
const {
  getAll,
  getManageableLocations,
  getPublicLocation,
  createLocation,
  updateLocation,
} = require("../controllers/location.controller");
const { requireAuth } = require("../middleware/auth.middleware");

const router = express.Router();

router.get("/manage", requireAuth, getManageableLocations);
router.get("/", getAll);
router.post("/", requireAuth, createLocation);
router.get("/:id", getPublicLocation);
router.patch("/:id", requireAuth, updateLocation);

module.exports = router;
