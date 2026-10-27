const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const paystack = require("../src/services/paystack.service");

const originalFetch = global.fetch;
const originalSecret = process.env.PAYSTACK_SECRET_KEY;
const originalMode = process.env.PAYSTACK_MODE;
const originalBaseUrl = process.env.PAYSTACK_BASE_URL;

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = originalSecret;
  if (originalMode === undefined) delete process.env.PAYSTACK_MODE;
  else process.env.PAYSTACK_MODE = originalMode;
  if (originalBaseUrl === undefined) delete process.env.PAYSTACK_BASE_URL;
  else process.env.PAYSTACK_BASE_URL = originalBaseUrl;
});

test("payment initialization sends server-calculated NGN amount and validates checkout response", async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_localMock123";
  process.env.PAYSTACK_MODE = "test";
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return {
          status: true,
          data: {
            authorization_url: "https://checkout.paystack.com/session",
            access_code: "test-access",
            reference: "payment-123",
          },
        };
      },
    };
  };

  await paystack.initializePayment({
    email: "donor@example.org",
    amountKobo: 25000,
    reference: "payment-123",
    metadata: { kind: "TREE_ORDER" },
  });

  assert.equal(request.url, "https://api.paystack.co/transaction/initialize");
  assert.equal(request.options.headers.Authorization, "Bearer sk_test_localMock123");
  assert.deepEqual(JSON.parse(request.options.body), {
    email: "donor@example.org",
    amount: 25000,
    currency: "NGN",
    reference: "payment-123",
    metadata: { kind: "TREE_ORDER" },
  });
});

test("missing and mode-mismatched Paystack keys fail explicitly", () => {
  delete process.env.PAYSTACK_SECRET_KEY;
  assert.throws(
    () => paystack.assertConfigured(),
    { code: "PAYMENT_PROVIDER_NOT_CONFIGURED" }
  );
  process.env.PAYSTACK_SECRET_KEY = "sk_live_localMock123";
  process.env.PAYSTACK_MODE = "test";
  assert.throws(
    () => paystack.assertConfigured(),
    { code: "PAYMENT_PROVIDER_INVALID_CONFIGURATION" }
  );
});

test("malformed or unexpected checkout URLs are rejected", async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_localMock123";
  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        status: true,
        data: {
          authorization_url: "https://attacker.invalid/checkout",
          access_code: "test-access",
          reference: "payment-123",
        },
      };
    },
  });
  await assert.rejects(
    paystack.initializePayment({
      email: "donor@example.org",
      amountKobo: 25000,
      reference: "payment-123",
      metadata: {},
    }),
    { code: "PAYMENT_PROVIDER_INVALID_RESPONSE" }
  );
});

test("provider failures and timeouts are surfaced with redacted errors", async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_localMock123";
  global.fetch = async () => ({
    ok: false,
    async json() {
      return { status: false, message: "provider error detail" };
    },
  });
  await assert.rejects(
    paystack.verifyCredentials(),
    (error) => error.code === "PAYMENT_PROVIDER_REQUEST_FAILED" &&
      !error.message.includes("provider error detail") &&
      !error.message.includes("sk_test")
  );

  global.fetch = async () => {
    const error = new Error("request aborted");
    error.name = "AbortError";
    throw error;
  };
  await assert.rejects(
    paystack.verifyPayment("payment-123"),
    (error) => error.code === "PAYMENT_PROVIDER_UNAVAILABLE" &&
      !error.message.includes("sk_test")
  );
});

test("read-only credential check confirms configured mode without exposing provider data", async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_localMock123";
  let url;
  global.fetch = async (target) => {
    url = target;
    return {
      ok: true,
      async json() {
        return { status: true, data: [{ name: "Bank" }] };
      },
    };
  };
  assert.deepEqual(await paystack.verifyCredentials(), { configured: true, mode: "test" });
  assert.equal(url, "https://api.paystack.co/bank?currency=NGN");
});

test("Paystack webhook signature is checked against the exact raw body", () => {
  const secret = "local-test-key";
  const body = Buffer.from('{"event":"charge.success"}');
  const signature = crypto.createHmac("sha512", secret).update(body).digest("hex");

  assert.equal(paystack.verifyWebhookSignature(body, signature, secret), true);
  assert.equal(paystack.verifyWebhookSignature(Buffer.from("{}"), signature, secret), false);
  assert.equal(paystack.verifyWebhookSignature(body, "invalid", secret), false);
});
