const crypto = require("node:crypto");

const DEFAULT_PAYSTACK_API = "https://api.paystack.co";

class PaystackError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = "PaystackError";
    this.code = code;
    this.status = status;
  }
}

function getPaystackConfig() {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    throw new PaystackError(
      "PAYMENT_PROVIDER_NOT_CONFIGURED",
      "Online payments are not configured."
    );
  }
  const mode = process.env.PAYSTACK_MODE || "test";
  if (!["test", "live"].includes(mode)) {
    throw new PaystackError("PAYMENT_PROVIDER_INVALID_CONFIGURATION", "PAYSTACK_MODE must be test or live.", 500);
  }
  const requiredPrefix = mode === "test" ? "sk_test_" : "sk_live_";
  if (!secretKey.startsWith(requiredPrefix) || !/^sk_(?:test|live)_[A-Za-z0-9]+$/.test(secretKey)) {
    throw new PaystackError(
      "PAYMENT_PROVIDER_INVALID_CONFIGURATION",
      `The configured Paystack key does not match ${mode} mode.`,
      500
    );
  }
  let baseUrl;
  try {
    baseUrl = new URL(process.env.PAYSTACK_BASE_URL || DEFAULT_PAYSTACK_API);
  } catch {
    throw new PaystackError("PAYMENT_PROVIDER_INVALID_CONFIGURATION", "PAYSTACK_BASE_URL is invalid.", 500);
  }
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.hostname !== "api.paystack.co" ||
    baseUrl.pathname !== "/" ||
    baseUrl.search ||
    baseUrl.hash ||
    baseUrl.username ||
    baseUrl.password
  ) {
    throw new PaystackError(
      "PAYMENT_PROVIDER_INVALID_CONFIGURATION",
      "PAYSTACK_BASE_URL must be the official HTTPS Paystack API origin.",
      500
    );
  }
  return { secretKey, mode, baseUrl: baseUrl.origin };
}

function assertConfigured() {
  return { mode: getPaystackConfig().mode };
}

async function requestPaystack(path, options = {}) {
  const { secretKey, baseUrl } = getPaystackConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.status !== true) {
      throw new PaystackError(
        "PAYMENT_PROVIDER_REQUEST_FAILED",
        "The payment provider could not complete the request."
      );
    }
    return result.data;
  } catch (error) {
    if (error instanceof PaystackError) throw error;
    throw new PaystackError(
      "PAYMENT_PROVIDER_UNAVAILABLE",
      "The payment provider is temporarily unavailable."
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function initializePayment({ email, amountKobo, reference, metadata }) {
  const data = await requestPaystack("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email,
      amount: amountKobo,
      currency: "NGN",
      reference,
      metadata,
    }),
  });
  let authorizationUrl;
  try {
    authorizationUrl = new URL(data?.authorization_url);
  } catch {
    throw new PaystackError(
      "PAYMENT_PROVIDER_INVALID_RESPONSE",
      "The payment provider returned an invalid checkout response."
    );
  }
  if (
    authorizationUrl.protocol !== "https:" ||
    authorizationUrl.hostname !== "checkout.paystack.com" ||
    data?.reference !== reference ||
    typeof data?.access_code !== "string" ||
    !data.access_code
  ) {
    throw new PaystackError(
      "PAYMENT_PROVIDER_INVALID_RESPONSE",
      "The payment provider returned an invalid checkout response."
    );
  }
  return data;
}

async function verifyPayment(reference) {
  return requestPaystack(
    `/transaction/verify/${encodeURIComponent(reference)}`,
    { method: "GET" }
  );
}

async function verifyCredentials() {
  const { mode } = getPaystackConfig();
  await requestPaystack("/bank?currency=NGN", { method: "GET" });
  return { configured: true, mode };
}

function verifyWebhookSignature(rawBody, signature, secretKey = process.env.PAYSTACK_SECRET_KEY) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== "string" || !secretKey) {
    return false;
  }
  if (!/^[a-f\d]{128}$/i.test(signature)) return false;
  const expected = crypto.createHmac("sha512", secretKey).update(rawBody).digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length &&
    crypto.timingSafeEqual(received, expected);
}

module.exports = {
  PaystackError,
  assertConfigured,
  verifyCredentials,
  initializePayment,
  verifyPayment,
  verifyWebhookSignature,
};
