const express = require("express");
const { rateLimit } = require("express-rate-limit");
const {
  login,
  getAll,
  getProfile,
  createAccount,
  registrationDisabled,
} = require("../controllers/auth.controller");
const { requireAuth } = require("../middleware/auth.middleware");

const router = express.Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler(req, res) {
    return res.status(429).json({
      success: false,
      message: "Too many login attempts. Please try again later.",
    });
  },
});

router.get("/", getAll);
router.post("/login", loginLimiter, login);
router.get("/profile", requireAuth, getProfile);
router.post("/register", registrationDisabled);
router.post("/accounts", requireAuth, createAccount);

module.exports = router;