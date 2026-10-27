const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../src/config/database");
const paystack = require("../src/services/paystack.service");
const {
  createOrder,
  createDonation,
  verifyAndApplyPayment,
  handlePaystackWebhook,
  reviewOrderLocation,
} = require("../src/controllers/commerce.controller");
const crypto = require("node:crypto");

const originalTransaction = prisma.$transaction;
const originalSpeciesFindFirst = prisma.treeSpecies.findFirst;
const originalOrderFindUnique = prisma.treeOrder.findUnique;
const originalPaymentFindUnique = prisma.paymentTransaction.findUnique;
const originalPaymentCreate = prisma.paymentTransaction.create;
const originalPaymentUpdateMany = prisma.paymentTransaction.updateMany;
const originalInitialize = paystack.initializePayment;
const originalVerify = paystack.verifyPayment;
const originalAssertConfigured = paystack.assertConfigured;
const originalPaystackSecret = process.env.PAYSTACK_SECRET_KEY;

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function orderRequest(body) {
  return {
    body,
    user: null,
  };
}

const validOrder = {
  speciesId: "tree-1",
  quantity: 3,
  customerName: "Ada Tree",
  customerEmail: "ada@example.org",
  customerPhone: "+2348012345678",
  requestedLocation: "Farm community",
  locationDirections: "Near the primary school",
};

test.afterEach(() => {
  prisma.$transaction = originalTransaction;
  prisma.treeSpecies.findFirst = originalSpeciesFindFirst;
  prisma.treeOrder.findUnique = originalOrderFindUnique;
  prisma.paymentTransaction.findUnique = originalPaymentFindUnique;
  prisma.paymentTransaction.create = originalPaymentCreate;
  prisma.paymentTransaction.updateMany = originalPaymentUpdateMany;
  paystack.initializePayment = originalInitialize;
  paystack.verifyPayment = originalVerify;
  paystack.assertConfigured = originalAssertConfigured;
  if (originalPaystackSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = originalPaystackSecret;
});

test("order total and immutable item snapshot are calculated from current server price atomically", async () => {
  let speciesQuery;
  let orderData;
  let paymentData;
  let transactionCount = 0;
  prisma.$transaction = async (callback) => callback({
    treeSpecies: {
      async findFirst(args) {
        speciesQuery = args;
        return { id: "tree-1", name: "Oak", priceKobo: 25000 };
      },
    },
    treeOrder: {
      async create({ data }) {
        orderData = data;
        return { id: "order-id", totalAmountKobo: data.totalAmountKobo, currency: data.currency };
      },
    },
    paymentTransaction: {
      async create({ data }) {
        paymentData = data;
        return { reference: data.reference, amountKobo: data.amountKobo, currency: data.currency };
      },
    },
  });
  paystack.assertConfigured = () => {};
  paystack.initializePayment = async (args) => {
    transactionCount += 1;
    assert.equal(args.amountKobo, 75000);
    return { authorization_url: "https://paystack.example/checkout", access_code: "access-code" };
  };
  const res = response();

  await createOrder(orderRequest(validOrder), res);

  assert.equal(res.statusCode, 201);
  assert.equal(speciesQuery.where.isPublished, true);
  assert.equal(speciesQuery.where.isActive, true);
  assert.equal(orderData.totalAmountKobo, 75000);
  assert.equal(orderData.items.create[0].unitPriceKobo, 25000);
  assert.equal(orderData.items.create[0].lineTotalKobo, 75000);
  assert.equal(paymentData.amountKobo, 75000);
  assert.equal(transactionCount, 1);
});

test("browser-supplied prices and totals are rejected rather than trusted", async () => {
  const res = response();
  await createOrder(orderRequest({ ...validOrder, totalAmountKobo: 1, priceKobo: 1 }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, "INVALID_CHECKOUT");
});

test("invalid order quantity is rejected without creating a checkout", async () => {
  let writes = 0;
  prisma.$transaction = async () => {
    writes += 1;
  };
  const res = response();

  await createOrder(orderRequest({ ...validOrder, quantity: -2 }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(writes, 0);
});

test("donation stores a server-priced snapshot and does not request a planting location", async () => {
  let donationData;
  prisma.$transaction = async (callback) => callback({
    treeSpecies: {
      async findFirst() {
        return { id: "tree-1", name: "Oak", priceKobo: 50000 };
      },
    },
    treeDonation: {
      async create({ data }) {
        donationData = data;
        return { id: "donation-id" };
      },
    },
    paymentTransaction: {
      async create({ data }) {
        return { reference: data.reference, amountKobo: data.amountKobo, currency: data.currency };
      },
    },
  });
  paystack.assertConfigured = () => {};
  paystack.initializePayment = async () => ({
    authorization_url: "https://paystack.example/checkout",
    access_code: "access-code",
  });
  const res = response();

  await createDonation(orderRequest({
    speciesId: "tree-1",
    quantity: 2,
    donorName: "Ada Tree",
    donorEmail: "ada@example.org",
    donorPhone: "+2348012345678",
  }), res);

  assert.equal(res.statusCode, 201);
  assert.equal(donationData.totalAmountKobo, 100000);
  assert.equal(donationData.unitPriceKobo, 50000);
  assert.equal(Object.hasOwn(donationData, "requestedLocation"), false);
});

test("successful Paystack charge must match reference, amount, and currency before application", async () => {
  prisma.paymentTransaction.findUnique = async () => ({
    id: "payment-id",
    orderId: "order-id",
    donationId: null,
    amountKobo: 75000,
    currency: "NGN",
    status: "PENDING",
    appliedAt: null,
    order: { id: "order-id", totalAmountKobo: 75000, currency: "NGN", customerEmail: "ada@example.org" },
    donation: null,
  });
  paystack.verifyPayment = async (reference) => ({
    status: "success",
    reference,
    amount: 75000,
    currency: "NGN",
    customer: { email: "ada@example.org" },
    id: 12345,
  });
  const writes = [];
  prisma.$transaction = async (callback) => callback({
    paymentTransaction: {
      async findUnique() {
        return { status: "PENDING", verifiedAt: null, appliedAt: null };
      },
      async updateMany(args) {
        writes.push(args);
        return { count: 1 };
      },
    },
    treeOrder: {
      async updateMany(args) {
        writes.push(args);
        return { count: 1 };
      },
    },
    auditLog: {
      async create() {},
    },
  });

  const result = await verifyAndApplyPayment("payment-00000000-0000-4000-8000-000000000001");

  assert.equal(result.applied, true);
  assert.equal(writes.length, 3);
  assert.equal(writes[1].where.paymentStatus, "PENDING");
  assert.equal(writes[1].data.status, "PAID");
  assert.ok(writes[2].data.appliedAt instanceof Date);
});

test("mismatched verified amount is never applied", async () => {
  prisma.paymentTransaction.findUnique = async () => ({
    id: "payment-id",
    orderId: "order-id",
    donationId: null,
    amountKobo: 75000,
    currency: "NGN",
    status: "PENDING",
    appliedAt: null,
    order: { id: "order-id", totalAmountKobo: 75000, currency: "NGN", customerEmail: "ada@example.org" },
    donation: null,
  });
  paystack.verifyPayment = async (reference) => ({
    status: "success",
    reference,
    amount: 74000,
    currency: "NGN",
    id: 12345,
  });

  await assert.rejects(
    verifyAndApplyPayment("payment-00000000-0000-4000-8000-000000000001"),
    { code: "PAYMENT_VERIFICATION_FAILED" }
  );
});

test("an already-paid owner leaves an extra verified charge unapplied for reconciliation", async () => {
  prisma.paymentTransaction.findUnique = async () => ({
    id: "payment-id",
    orderId: "order-id",
    donationId: null,
    amountKobo: 75000,
    currency: "NGN",
    status: "PENDING",
    appliedAt: null,
    order: { id: "order-id", totalAmountKobo: 75000, currency: "NGN", customerEmail: "ada@example.org" },
    donation: null,
  });
  paystack.verifyPayment = async (reference) => ({
    status: "success",
    reference,
    amount: 75000,
    currency: "NGN",
    customer: { email: "ada@example.org" },
    id: 12345,
  });
  let paymentRecorded = false;
  prisma.$transaction = async (callback) => callback({
    paymentTransaction: {
      async findUnique() {
        return { status: "PENDING", verifiedAt: null, appliedAt: null };
      },
      async updateMany() {
        paymentRecorded = true;
        return { count: 1 };
      },
    },
    treeOrder: {
      async updateMany() {
        return { count: 0 };
      },
    },
    auditLog: {
      async create() {},
    },
  });

  const result = await verifyAndApplyPayment("payment-00000000-0000-4000-8000-000000000001");

  assert.equal(paymentRecorded, true);
  assert.equal(result.applied, false);
  assert.equal(result.requiresReconciliation, true);
});

test("repeated webhook for an applied payment is acknowledged without a second provider call", async () => {
  let marker;
  prisma.paymentTransaction.findUnique = async () => ({
    id: "payment-id",
    orderId: "order-id",
    donationId: null,
    amountKobo: 75000,
    currency: "NGN",
    status: "SUCCESSFUL",
    appliedAt: new Date(),
    order: { id: "order-id", totalAmountKobo: 75000, currency: "NGN", customerEmail: "ada@example.org" },
    donation: null,
  });
  prisma.paymentTransaction.updateMany = async ({ data }) => {
    marker = data.webhookProcessedAt;
    return { count: 1 };
  };
  paystack.verifyPayment = async () => {
    throw new Error("An applied payment should not require another gateway call.");
  };

  const result = await verifyAndApplyPayment(
    "payment-00000000-0000-4000-8000-000000000001",
    { webhook: true }
  );

  assert.equal(result.applied, true);
  assert.ok(marker instanceof Date);
});

test("location review is audited and cannot reject an already-paid order", async () => {
  let audit;
  prisma.$transaction = async (callback) => callback({
    treeOrder: {
      async updateMany({ where, data }) {
        assert.equal(where.locationReviewStatus, "PENDING");
        assert.equal(data.locationReviewStatus, "APPROVED");
        return { count: 1 };
      },
      async findUnique() {
        return { id: "order-id", reference: "order-ref", locationReviewStatus: "APPROVED" };
      },
    },
    auditLog: {
      async create({ data }) {
        audit = data;
      },
    },
  });
  const approved = response();
  await reviewOrderLocation({
    user: { id: "admin-1", role: "ADMIN" },
    params: { reference: "order-ref" },
    body: { status: "APPROVED" },
  }, approved);
  assert.equal(approved.statusCode, 200);
  assert.equal(audit.action, "TREE_ORDER_LOCATION_APPROVED");

  prisma.$transaction = async (callback) => callback({
    treeOrder: {
      async updateMany() {
        return { count: 0 };
      },
      async findUnique() {
        return { id: "order-id", paymentStatus: "SUCCESSFUL", locationReviewStatus: "PENDING" };
      },
    },
  });
  const rejected = response();
  await reviewOrderLocation({
    user: { id: "admin-1", role: "ADMIN" },
    params: { reference: "order-ref" },
    body: { status: "REJECTED" },
  }, rejected);
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.body.error.code, "PAID_ORDER_REQUIRES_REFUND_WORKFLOW");
});

test("webhook rejects invalid signatures and verifies the event against Paystack", async () => {
  process.env.PAYSTACK_SECRET_KEY = "local-webhook-test-key";
  const body = { event: "charge.success", data: { reference: "payment-00000000-0000-4000-8000-000000000001" } };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
  let verificationCalls = 0;
  const originalFindUnique = prisma.paymentTransaction.findUnique;
  prisma.paymentTransaction.findUnique = async () => {
    verificationCalls += 1;
    return null;
  };
  const req = {
    body,
    rawBody,
    get(name) {
      return name.toLowerCase() === "x-paystack-signature" ? signature : undefined;
    },
  };
  const invalid = response();
  await handlePaystackWebhook({ ...req, rawBody: Buffer.from("{}"), get: () => signature }, invalid);
  assert.equal(invalid.statusCode, 401);
  assert.equal(verificationCalls, 0);

  const valid = response();
  await handlePaystackWebhook(req, valid);
  assert.equal(verificationCalls, 1);
  assert.equal(valid.statusCode, 404);
  prisma.paymentTransaction.findUnique = originalFindUnique;
});
