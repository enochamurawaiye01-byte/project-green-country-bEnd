require("dotenv").config();
const app = require("./app");
const { prisma, pool } = require("./config/database");
const { validateRuntimeConfig } = require("./config/runtime-config");

async function startServer() {
  const { port } = validateRuntimeConfig();
  await prisma.$connect();
  const server = app.listen(port, "0.0.0.0");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  console.log("Backend server listening.");

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);
    server.close(async (error) => {
      if (error) {
        console.error("HTTP server shutdown failed:", { code: error.code || "UNKNOWN" });
        process.exitCode = 1;
      }
      try {
        await prisma.$disconnect();
        await pool.end();
      } catch (shutdownError) {
        console.error("Database shutdown failed:", { code: shutdownError.code || "UNKNOWN" });
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  return server;
}

if (require.main === module) {
  startServer().catch(async (error) => {
   console.error("Backend startup failed:", {
  name: error.name || "UnknownError",
  code: error.code || "NO_ERROR_CODE",
  message: String(error.message || "No error message")
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[DATABASE_URL_REDACTED]")
    .replace(/(password|secret|token|service_role_key)\s*[:=]\s*[^,\s]+/gi, "$1=[REDACTED]"),
});
    try {
      await prisma.$disconnect();
      await pool.end();
    } catch (shutdownError) {
      console.error("Database cleanup after startup failure failed:", {
        code: shutdownError.code || "UNKNOWN",
      });
    }
    process.exitCode = 1;
  });
}

module.exports = { startServer };
