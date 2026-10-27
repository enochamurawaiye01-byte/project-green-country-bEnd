const express = require("express");
const { rateLimit } = require("express-rate-limit");
const {
  createOrder,
  createDonation,
  listAdminOrders,
  reviewOrderLocation,
  listAdminDonations,
  initializeExistingPayment,
  verifyPayment,
  handlePaystackWebhook,
} = require("../controllers/commerce.controller");
const { requireAuth } = require("../middleware/auth.middleware");
const { requireCommerceSchema } = require("../middleware/commerce-schema.middleware");

const router = express.Router();
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler(_req, res) {
    return res.status(429).json({
      success: false,
      error: { code: "RATE_LIMITED", message: "Too many checkout requests. Please try again later." },
    });
  },
});
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler(_req, res) {
    return res.status(429).json({
      success: false,
      error: { code: "RATE_LIMITED", message: "Too many payment requests. Please try again later." },
    });
  },
});

router.post("/orders", checkoutLimiter, requireCommerceSchema, createOrder);
router.post("/donations", checkoutLimiter, requireCommerceSchema, createDonation);
router.get("/orders/admin", requireAuth, requireCommerceSchema, listAdminOrders);
router.patch("/orders/:reference/location-review", requireAuth, requireCommerceSchema, reviewOrderLocation);
router.get("/donations/admin", requireAuth, requireCommerceSchema, listAdminDonations);
router.post("/payments/initialize", paymentLimiter, requireCommerceSchema, initializeExistingPayment);
router.post("/payments/verify", paymentLimiter, requireCommerceSchema, verifyPayment);
router.post("/payments/webhook", requireCommerceSchema, handlePaystackWebhook);

module.exports = router;
