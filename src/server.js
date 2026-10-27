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
    console.error("Backend startup failed:", { code: error.code || "CONFIG_OR_DATABASE_ERROR" });
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
