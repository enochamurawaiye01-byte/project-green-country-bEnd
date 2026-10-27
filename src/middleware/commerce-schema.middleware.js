const { checkCommerceSchemaCompatibility } = require("../services/commerce-schema.service");

async function requireCommerceSchema(_req, res, next) {
  if (process.env.COMMERCE_SCHEMA_ENABLED !== "true") {
    return res.status(503).json({
      success: false,
      error: {
        code: "COMMERCE_SCHEMA_UNAVAILABLE",
        message: "Commerce endpoints are disabled until the approved database schema is applied and verified.",
      },
    });
  }
  try {
    const result = await checkCommerceSchemaCompatibility();
    if (result.compatible) return next();
    console.error("Commerce schema compatibility check failed:", {
      missingColumns: result.missing.columns.length,
      missingEnums: result.missing.enums.length,
      missingConstraints: result.missing.constraints.length,
      missingIndexes: result.missing.indexes.length,
    });
  } catch (error) {
    console.error("Commerce schema compatibility check failed:", {
      code: error.code || "UNKNOWN",
    });
  }
  return res.status(503).json({
    success: false,
    error: {
      code: "COMMERCE_SCHEMA_UNAVAILABLE",
      message: "Commerce endpoints are disabled until the live database is confirmed compatible.",
    },
  });
}

module.exports = { requireCommerceSchema };
