const express = require("express");
const {
  getAll,
  createTarget,
  updateTarget,
} = require("../controllers/target.controller");
const { requireAuth } = require("../middleware/auth.middleware");

const router = express.Router();
router.get("/", requireAuth, getAll);
router.post("/", requireAuth, createTarget);
router.patch("/:id", requireAuth, updateTarget);

module.exports = router;
