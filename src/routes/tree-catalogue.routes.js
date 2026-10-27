const express = require("express");
const {
  listPublicSpecies,
  listAdminSpecies,
  createSpecies,
  updateSpecies,
  setPublication,
} = require("../controllers/tree-catalogue.controller");
const { requireAuth } = require("../middleware/auth.middleware");
const { requireCommerceSchema } = require("../middleware/commerce-schema.middleware");

const router = express.Router();

router.get("/", requireCommerceSchema, listPublicSpecies);
router.get("/admin", requireAuth, requireCommerceSchema, listAdminSpecies);
router.post("/", requireAuth, requireCommerceSchema, createSpecies);
router.patch("/:id/publication", requireAuth, requireCommerceSchema, setPublication);
router.patch("/:id", requireAuth, requireCommerceSchema, updateSpecies);

module.exports = router;
