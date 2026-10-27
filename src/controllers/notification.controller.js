const { prisma } = require("../config/database");

const CREATE_ROLES = ["SUPER_ADMIN", "ADMIN"];
const NOTIFICATION_TYPES = ["INFO", "SUCCESS", "WARNING", "ERROR", "APPROVAL", "SYSTEM"];

function sendError(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

function parsePage(value) {
  if (value === undefined) return 1;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 ? page : null;
}

function parseLimit(value) {
  if (value === undefined) return 50;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
}

async function listNotifications(req, res) {
  const page = parsePage(req.query.page);
  const take = parseLimit(req.query.limit);
  if (page === null || take === null || (page - 1) * take > Number.MAX_SAFE_INTEGER) {
    return sendError(res, 400, "INVALID_PAGINATION", "page must be a positive whole number and limit must be from 1 to 100.");
  }
  try {
    const userWhere = { userId: req.user.id };
    const unreadWhere = { ...userWhere, isRead: false };
    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: userWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * take,
        take,
        select: {
          id: true,
          title: true,
          message: true,
          type: true,
          link: true,
          isRead: true,
          readAt: true,
          createdAt: true,
        },
      }),
      prisma.notification.count({ where: userWhere }),
      prisma.notification.count({ where: unreadWhere }),
    ]);
    return res.json({
      success: true,
      count: notifications.length,
      page,
      limit: take,
      total,
      unreadCount,
      notifications,
    });
  } catch (error) {
    console.error("List notifications failed:", { code: error.code || "UNKNOWN" });
    return sendError(res, 500, "NOTIFICATION_LIST_FAILED", "Unable to retrieve notifications.");
  }
}

async function markNotificationRead(req, res) {
  try {
    const result = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user.id },
      data: { isRead: true, readAt: new Date() },
    });
    if (!result.count) return sendError(res, 404, "NOT_FOUND", "Notification not found.");
    return res.json({ success: true, message: "Notification marked as read." });
  } catch (error) {
    console.error("Mark notification read failed:", { code: error.code || "UNKNOWN" });
    return sendError(res, 500, "NOTIFICATION_UPDATE_FAILED", "Unable to update notification.");
  }
}

async function markAllNotificationsRead(req, res) {
  try {
    const result = await prisma.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return res.json({
      success: true,
      updatedCount: result.count,
      message: "Unread notifications marked as read.",
    });
  } catch (error) {
    console.error("Mark all notifications read failed:", { code: error.code || "UNKNOWN" });
    return sendError(res, 500, "NOTIFICATION_UPDATE_FAILED", "Unable to update notifications.");
  }
}

async function createNotification(req, res) {
  if (!CREATE_ROLES.includes(req.user?.role)) {
    return sendError(res, 403, "FORBIDDEN", "You are not authorized to create notifications.");
  }
  const { userId, title, message, type = "INFO", link = null } = req.body || {};
  if (
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body) ||
    Object.keys(req.body).some((key) => !["userId", "title", "message", "type", "link"].includes(key))
  ) {
    return sendError(res, 400, "INVALID_NOTIFICATION", "The notification request contains unsupported fields.");
  }
  if (
    typeof userId !== "string" || !userId.trim() ||
    typeof title !== "string" || !title.trim() || title.trim().length > 200 ||
    typeof message !== "string" || !message.trim() || message.trim().length > 5000 ||
    !NOTIFICATION_TYPES.includes(type)
  ) {
    return sendError(res, 400, "INVALID_NOTIFICATION", "Provide a userId, title, message, and valid notification type.");
  }
  if (
    link !== null &&
    (typeof link !== "string" || link.length > 2048 || !link.startsWith("/") || link.startsWith("//"))
  ) {
    return sendError(res, 400, "INVALID_NOTIFICATION", "link must be a same-site path beginning with a single slash.");
  }
  try {
    const notification = await prisma.notification.create({
      data: {
        userId: userId.trim(),
        title: title.trim(),
        message: message.trim(),
        type,
        link,
      },
      select: {
        id: true,
        userId: true,
        title: true,
        message: true,
        type: true,
        link: true,
        isRead: true,
        createdAt: true,
      },
    });
    return res.status(201).json({ success: true, notification });
  } catch (error) {
    console.error("Create notification failed:", { code: error.code || "UNKNOWN" });
    if (error.code === "P2003") {
      return sendError(res, 404, "USER_NOT_FOUND", "Notification recipient was not found.");
    }
    return sendError(res, 500, "NOTIFICATION_CREATE_FAILED", "Unable to create notification.");
  }
}

module.exports = {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  createNotification,
};
