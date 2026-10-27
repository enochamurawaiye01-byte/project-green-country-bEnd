const express = require("express");
const {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  createNotification,
} = require("../controllers/notification.controller");
const { requireAuth } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(requireAuth);
router.get("/", listNotifications);
router.patch("/read-all", markAllNotificationsRead);
router.post("/", createNotification);
router.patch("/:id/read", markNotificationRead);

module.exports = router;
