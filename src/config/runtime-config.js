function parseCorsOrigins(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(",").map((entry) => {
    const origin = entry.trim();
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("CORS_ORIGINS must contain comma-separated HTTP(S) origins.");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("CORS_ORIGINS must contain comma-separated HTTP(S) origins without paths or credentials.");
    }
    return parsed.origin;
  });
}

function validateRuntimeConfig(env = process.env) {
  const missing = ["DATABASE_URL", "JWT_SECRET"].filter(
    (name) => typeof env[name] !== "string" || !env[name].trim()
  );
  if (missing.length) {
    throw new Error(`Missing required backend configuration: ${missing.join(", ")}.`);
  }
  if (env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters.");
  }
  if (env.NODE_ENV === "production") {
    const origins = parseCorsOrigins(env.CORS_ORIGINS);
    if (!origins.length) {
      throw new Error("CORS_ORIGINS must contain the deployed frontend origin in production.");
    }
    if (origins.some((origin) => !origin.startsWith("https://"))) {
      throw new Error("Production CORS_ORIGINS entries must use HTTPS.");
    }
  } else if (env.CORS_ORIGINS) {
    parseCorsOrigins(env.CORS_ORIGINS);
  }

  const port = env.PORT === undefined || env.PORT === ""
    ? 5000
    : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer from 0 to 65535.");
  }
  return { port };
}

module.exports = { parseCorsOrigins, validateRuntimeConfig };
