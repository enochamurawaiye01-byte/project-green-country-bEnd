const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { parseCorsOrigins } = require("./config/runtime-config");
const authRoutes = require("./routes/auth.routes");
const plantingRoutes = require("./routes/planting.routes");
const locationRoutes = require("./routes/location.routes");
const targetRoutes = require("./routes/target.routes");
const reportRoutes = require("./routes/report.routes");
const growthUpdateRoutes = require("./routes/growth-update.routes");
const notificationRoutes = require("./routes/notification.routes");
const treeCatalogueRoutes = require("./routes/tree-catalogue.routes");
const commerceRoutes = require("./routes/commerce.routes");
const mediaRoutes = require("./routes/media.routes");

const app = express();
const defaultDevelopmentOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];
const configuredOrigins = process.env.CORS_ORIGINS
  ? parseCorsOrigins(process.env.CORS_ORIGINS)
  : process.env.NODE_ENV === "production"
    ? []
    : defaultDevelopmentOrigins;
const allowedOrigins = new Set(
  configuredOrigins
);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(null, false);
  },
}));
app.use(express.json({
  limit: "100kb",
  verify(req, _res, buffer) {
    req.rawBody = Buffer.from(buffer);
  },
}));

app.get("/health", (_req, res) => {
  return res.status(200).json({ success: true, status: "ok" });
});

app.use("/api/auth", authRoutes);
app.use("/api/plantings", plantingRoutes);
app.use("/api/locations", locationRoutes);
app.use("/api/targets", targetRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/growth-updates", growthUpdateRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/trees", treeCatalogueRoutes);
app.use("/api", commerceRoutes);
app.use("/api/media", mediaRoutes);

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      error: { code: "REQUEST_TOO_LARGE", message: "Request body exceeds the 100 KB limit." },
    });
  }
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_JSON", message: "Request body must contain valid JSON." },
    });
  }
  return next(error);
});

module.exports = app;
