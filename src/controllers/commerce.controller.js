const crypto = require("node:crypto");
const { prisma } = require("../config/database");
const paystack = require("../services/paystack.service");

const NGN = "NGN";
const MAX_QUANTITY = 10000;
const MAX_INT = 2147483647;
const COMMERCE_ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN", "PROGRAMME_MANAGER"];

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendError(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

function requireCommerceAdmin(req, res) {
  if (COMMERCE_ADMIN_ROLES.includes(req.user?.role)) return true;
  sendError(res, 403, "FORBIDDEN", "You are not authorized to manage commerce records.");
  return false;
}

function requireObject(body) {
  return body && typeof body === "object" && !Array.isArray(body);
}

function requiredText(value, field, max, min = 1) {
  if (typeof value !== "string") {
    throw new RequestError(400, "INVALID_CHECKOUT", `${field} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new RequestError(400, "INVALID_CHECKOUT", `${field} must be ${min} to ${max} characters.`);
  }
  return normalized;
}

function validateContact(body, isDonation) {
  if (!requireObject(body)) {
    throw new RequestError(400, "INVALID_CHECKOUT", "A JSON object is required.");
  }
  const allowed = new Set([
    "speciesId",
    "quantity",
    isDonation ? "donorName" : "customerName",
    isDonation ? "donorEmail" : "customerEmail",
    isDonation ? "donorPhone" : "customerPhone",
    ...(isDonation ? [] : ["requestedLocation", "locationDirections"]),
  ]);
  if (Object.keys(body).some((field) => !allowed.has(field))) {
    throw new RequestError(400, "INVALID_CHECKOUT", "The request contains unsupported fields.");
  }
  const prefix = isDonation ? "donor" : "customer";
  const name = requiredText(body[`${prefix}Name`], `${prefix}Name`, 120);
  const email = requiredText(body[`${prefix}Email`], `${prefix}Email`, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new RequestError(400, "INVALID_CHECKOUT", `${prefix}Email must be a valid email address.`);
  }
  const phone = requiredText(body[`${prefix}Phone`], `${prefix}Phone`, 32);
  if (!/^[+()\d.\-\s]+$/.test(phone) || !/\d/.test(phone)) {
    throw new RequestError(400, "INVALID_CHECKOUT", `${prefix}Phone must be a valid phone number.`);
  }
  const speciesId = requiredText(body.speciesId, "speciesId", 128);
  const quantity = body.quantity;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw new RequestError(400, "INVALID_CHECKOUT", `quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
  }
  const data = { name, email, phone, speciesId, quantity };
  if (!isDonation) {
    data.requestedLocation = requiredText(body.requestedLocation, "requestedLocation", 500, 3);
    if (body.locationDirections !== undefined && body.locationDirections !== null) {
      if (typeof body.locationDirections !== "string" || body.locationDirections.length > 2000) {
        throw new RequestError(400, "INVALID_CHECKOUT", "locationDirections must be at most 2000 characters.");
      }
      data.locationDirections = body.locationDirections.trim() || null;
    } else {
      data.locationDirections = null;
    }
  }
  return data;
}

function makeReference(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function totalFor(quantity, priceKobo) {
  const total = quantity * priceKobo;
  if (!Number.isSafeInteger(total) || total < 1 || total > MAX_INT) {
    throw new RequestError(400, "ORDER_TOTAL_OUT_OF_RANGE", "The checkout total is outside the supported range.");
  }
  return total;
}

function schemaError(res, error) {
  if (error.code === "P2021" || error.code === "P2022") {
    return sendError(res, 503, "COMMERCE_SCHEMA_UNAVAILABLE", "Commerce is unavailable until the approved database schema is applied.");
  }
  if (error.code === "P2002") {
    return sendError(res, 409, "PAYMENT_ALREADY_RECORDED", "This payment transaction is already associated with another record.");
  }
  if (error.code === "P2003" || error.code === "P2025") {
    return sendError(res, 404, "COMMERCE_RECORD_NOT_FOUND", "A referenced commerce record was not found.");
  }
  console.error("Commerce operation failed:", { code: error.code || "UNKNOWN" });
  return sendError(res, 500, "COMMERCE_OPERATION_FAILED", "Unable to complete the commerce request.");
}

function paystackError(res, error, references = {}) {
  console.error("Paystack request failed:", { code: error.code || "UNKNOWN" });
  return res.status(error.status || 503).json({
    success: false,
    error: {
      code: error.code || "PAYMENT_PROVIDER_UNAVAILABLE",
      message: error.message || "The payment provider is temporarily unavailable.",
    },
    ...references,
  });
}

async function initializeExternalPayment({ payment, email, metadata }) {
  return paystack.initializePayment({
    email,
    amountKobo: payment.amountKobo,
    reference: payment.reference,
    metadata,
  });
}

async function createOrder(req, res) {
  let input;
  try {
    input = validateContact(req.body, false);
  } catch (error) {
    if (error instanceof RequestError) return sendError(res, error.status, error.code, error.message);
    throw error;
  }
  try {
    paystack.assertConfigured();
  } catch (error) {
    return paystackError(res, error);
  }

  const orderReference = makeReference("order");
  const paymentReference = makeReference("payment");
  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const species = await tx.treeSpecies.findFirst({
        where: {
          id: input.speciesId,
          isActive: true,
          isPublished: true,
          priceKobo: { gt: 0 },
        },
        select: { id: true, name: true, priceKobo: true },
      });
      if (!species) throw new RequestError(404, "TREE_NOT_AVAILABLE", "The selected tree type is not available.");
      const totalAmountKobo = totalFor(input.quantity, species.priceKobo);
      const order = await tx.treeOrder.create({
        data: {
          reference: orderReference,
          customerName: input.name,
          customerEmail: input.email,
          customerPhone: input.phone,
          requestedLocation: input.requestedLocation,
          locationDirections: input.locationDirections,
          totalAmountKobo,
          currency: NGN,
          items: {
            create: [{
              speciesId: species.id,
              speciesName: species.name,
              quantity: input.quantity,
              unitPriceKobo: species.priceKobo,
              lineTotalKobo: totalAmountKobo,
            }],
          },
        },
        select: { id: true, totalAmountKobo: true, currency: true },
      });
      const payment = await tx.paymentTransaction.create({
        data: {
          orderId: order.id,
          reference: paymentReference,
          amountKobo: totalAmountKobo,
          currency: NGN,
        },
        select: { reference: true, amountKobo: true, currency: true },
      });
      return { order, payment };
    });
  } catch (error) {
    if (error instanceof RequestError) return sendError(res, error.status, error.code, error.message);
    return schemaError(res, error);
  }

  try {
    const initialized = await initializeExternalPayment({
      payment: created.payment,
      email: input.email,
      metadata: { kind: "TREE_ORDER", orderReference },
    });
    return res.status(201).json({
      success: true,
      orderReference,
      paymentReference,
      amountKobo: created.payment.amountKobo,
      currency: NGN,
      authorizationUrl: initialized.authorization_url,
      accessCode: initialized.access_code,
    });
  } catch (error) {
    return paystackError(res, error, { orderReference, paymentReference });
  }
}

async function createDonation(req, res) {
  let input;
  try {
    input = validateContact(req.body, true);
  } catch (error) {
    if (error instanceof RequestError) return sendError(res, error.status, error.code, error.message);
    throw error;
  }
  try {
    paystack.assertConfigured();
  } catch (error) {
    return paystackError(res, error);
  }

  const donationReference = makeReference("donation");
  const paymentReference = makeReference("payment");
  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const species = await tx.treeSpecies.findFirst({
        where: {
          id: input.speciesId,
          isActive: true,
          isPublished: true,
          priceKobo: { gt: 0 },
        },
        select: { id: true, name: true, priceKobo: true },
      });
      if (!species) throw new RequestError(404, "TREE_NOT_AVAILABLE", "The selected tree type is not available.");
      const totalAmountKobo = totalFor(input.quantity, species.priceKobo);
      const donation = await tx.treeDonation.create({
        data: {
          reference: donationReference,
          donorName: input.name,
          donorEmail: input.email,
          donorPhone: input.phone,
          speciesId: species.id,
          speciesName: species.name,
          quantity: input.quantity,
          unitPriceKobo: species.priceKobo,
          totalAmountKobo,
          currency: NGN,
        },
        select: { id: true },
      });
      const payment = await tx.paymentTransaction.create({
        data: {
          donationId: donation.id,
          reference: paymentReference,
          amountKobo: totalAmountKobo,
          currency: NGN,
        },
        select: { reference: true, amountKobo: true, currency: true },
      });
      return { donation, payment };
    });
  } catch (error) {
    if (error instanceof RequestError) return sendError(res, error.status, error.code, error.message);
    return schemaError(res, error);
  }

  try {
    const initialized = await initializeExternalPayment({
      payment: created.payment,
      email: input.email,
      metadata: { kind: "TREE_DONATION", donationReference },
    });
    return res.status(201).json({
      success: true,
      donationReference,
      paymentReference,
      amountKobo: created.payment.amountKobo,
      currency: NGN,
      authorizationUrl: initialized.authorization_url,
      accessCode: initialized.access_code,
    });
  } catch (error) {
    return paystackError(res, error, { donationReference, paymentReference });
  }
}

async function listAdminOrders(req, res) {
  if (!requireCommerceAdmin(req, res)) return;
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  if (!Number.isSafeInteger(page) || page < 1 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return sendError(res, 400, "INVALID_PAGINATION", "page must be positive and limit must be from 1 to 100.");
  }
  try {
    const [orders, total] = await prisma.$transaction([
      prisma.treeOrder.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          reference: true,
          customerName: true,
          customerEmail: true,
          customerPhone: true,
          requestedLocation: true,
          locationDirections: true,
          status: true,
          paymentStatus: true,
          locationReviewStatus: true,
          fulfilmentStatus: true,
          plantingVerificationStatus: true,
          totalAmountKobo: true,
          currency: true,
          createdAt: true,
          items: {
            select: {
              speciesName: true,
              quantity: true,
              unitPriceKobo: true,
              lineTotalKobo: true,
            },
          },
          paymentTransactions: {
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              reference: true,
              amountKobo: true,
              currency: true,
              status: true,
              verifiedAt: true,
              webhookProcessedAt: true,
              appliedAt: true,
              createdAt: true,
            },
          },
        },
      }),
      prisma.treeOrder.count(),
    ]);
    return res.json({ success: true, page, limit, total, orders });
  } catch (error) {
    return schemaError(res, error);
  }
}

async function reviewOrderLocation(req, res) {
  if (!requireCommerceAdmin(req, res)) return;
  const body = req.body;
  if (!requireObject(body) ||
      Object.keys(body).some((key) => key !== "status") ||
      !["APPROVED", "REJECTED"].includes(body.status)) {
    return sendError(res, 400, "INVALID_LOCATION_REVIEW", "status must be APPROVED or REJECTED.");
  }
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const updated = await tx.treeOrder.updateMany({
        where: {
          reference: req.params.reference,
          locationReviewStatus: "PENDING",
          ...(body.status === "REJECTED" ? { paymentStatus: "PENDING" } : {}),
        },
        data: { locationReviewStatus: body.status },
      });
      if (!updated.count) {
        return {
          notUpdated: true,
          order: await tx.treeOrder.findUnique({
            where: { reference: req.params.reference },
            select: { id: true, paymentStatus: true, locationReviewStatus: true },
          }),
        };
      }
      const reviewed = await tx.treeOrder.findUnique({
        where: { reference: req.params.reference },
        select: {
          id: true,
          reference: true,
          locationReviewStatus: true,
          paymentStatus: true,
          fulfilmentStatus: true,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.user.id,
          action: body.status === "APPROVED" ? "TREE_ORDER_LOCATION_APPROVED" : "TREE_ORDER_LOCATION_REJECTED",
          entityType: "TreeOrder",
          entityId: reviewed.id,
          description: "Requested planting location reviewed.",
          metadata: { locationReviewStatus: body.status },
        },
      });
      return { notUpdated: false, order: reviewed };
    });
    if (!outcome?.order) return sendError(res, 404, "ORDER_NOT_FOUND", "Order not found.");
    if (outcome.notUpdated) {
      if (body.status === "REJECTED" &&
          outcome.order.paymentStatus === "SUCCESSFUL" &&
          outcome.order.locationReviewStatus === "PENDING") {
        return sendError(res, 409, "PAID_ORDER_REQUIRES_REFUND_WORKFLOW", "A paid order cannot be rejected until a refund workflow is available.");
      }
      return sendError(res, 409, "LOCATION_ALREADY_REVIEWED", "The requested location has already been reviewed.");
    }
    return res.json({ success: true, order: outcome.order });
  } catch (error) {
    return schemaError(res, error);
  }
}

async function listAdminDonations(req, res) {
  if (!requireCommerceAdmin(req, res)) return;
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  if (!Number.isSafeInteger(page) || page < 1 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return sendError(res, 400, "INVALID_PAGINATION", "page must be positive and limit must be from 1 to 100.");
  }
  try {
    const [donations, total] = await prisma.$transaction([
      prisma.treeDonation.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          reference: true,
          donorName: true,
          donorEmail: true,
          donorPhone: true,
          speciesName: true,
          quantity: true,
          unitPriceKobo: true,
          totalAmountKobo: true,
          currency: true,
          paymentStatus: true,
          plantingVerificationStatus: true,
          createdAt: true,
          paymentTransactions: {
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              reference: true,
              amountKobo: true,
              currency: true,
              status: true,
              verifiedAt: true,
              webhookProcessedAt: true,
              appliedAt: true,
              createdAt: true,
            },
          },
        },
      }),
      prisma.treeDonation.count(),
    ]);
    return res.json({ success: true, page, limit, total, donations });
  } catch (error) {
    return schemaError(res, error);
  }
}

async function initializeExistingPayment(req, res) {
  const body = req.body;
  if (!requireObject(body) ||
      Object.keys(body).some((key) => !["ownerType", "reference"].includes(key)) ||
      !["order", "donation"].includes(body.ownerType) ||
      typeof body.reference !== "string" ||
      !/^(order|donation)-[a-f\d-]{36}$/i.test(body.reference)) {
    return sendError(res, 400, "INVALID_PAYMENT_INITIALIZATION", "Provide a valid ownerType and checkout reference.");
  }
  try {
    paystack.assertConfigured();
  } catch (error) {
    return paystackError(res, error);
  }
  try {
    const isOrder = body.ownerType === "order";
    const owner = isOrder
      ? await prisma.treeOrder.findUnique({
          where: { reference: body.reference },
          select: { id: true, customerEmail: true, totalAmountKobo: true, currency: true, paymentStatus: true, status: true, locationReviewStatus: true },
        })
      : await prisma.treeDonation.findUnique({
          where: { reference: body.reference },
          select: { id: true, donorEmail: true, totalAmountKobo: true, currency: true, paymentStatus: true },
        });
    if (!owner) return sendError(res, 404, "CHECKOUT_NOT_FOUND", "Checkout was not found.");
    if (
      owner.paymentStatus !== "PENDING" ||
      (isOrder && (owner.status !== "PENDING_PAYMENT" || owner.locationReviewStatus === "REJECTED"))
    ) {
      return sendError(res, 409, "CHECKOUT_NOT_PAYABLE", "This checkout is no longer awaiting payment.");
    }
    const paymentReference = makeReference("payment");
    const payment = await prisma.paymentTransaction.create({
      data: {
        ...(isOrder ? { orderId: owner.id } : { donationId: owner.id }),
        reference: paymentReference,
        amountKobo: owner.totalAmountKobo,
        currency: owner.currency,
      },
      select: { reference: true, amountKobo: true, currency: true },
    });
    const initialized = await initializeExternalPayment({
      payment,
      email: isOrder ? owner.customerEmail : owner.donorEmail,
      metadata: { kind: isOrder ? "TREE_ORDER" : "TREE_DONATION", checkoutReference: body.reference },
    });
    return res.status(201).json({
      success: true,
      checkoutReference: body.reference,
      paymentReference,
      amountKobo: payment.amountKobo,
      currency: payment.currency,
      authorizationUrl: initialized.authorization_url,
      accessCode: initialized.access_code,
    });
  } catch (error) {
    if (error.status) return paystackError(res, error);
    return schemaError(res, error);
  }
}

function validPaystackTransactionId(id) {
  const maximum = 9223372036854775807n;
  if (typeof id === "number") {
    return Number.isSafeInteger(id) && id > 0 && BigInt(id) <= maximum;
  }
  if (typeof id !== "string" || !/^\d+$/.test(id)) return false;
  const value = BigInt(id);
  return value > 0n && value <= maximum;
}

async function verifyAndApplyPayment(reference, { webhook = false } = {}) {
  const payment = await prisma.paymentTransaction.findUnique({
    where: { reference },
    include: { order: true, donation: true },
  });
  if (!payment) throw new RequestError(404, "PAYMENT_NOT_FOUND", "Payment reference not found.");
  if ((payment.orderId === null) === (payment.donationId === null)) {
    throw new RequestError(409, "INVALID_PAYMENT_OWNER", "Payment ownership is invalid.");
  }
  if ((payment.orderId && (!payment.order || payment.donation)) ||
      (payment.donationId && (!payment.donation || payment.order))) {
    throw new RequestError(409, "INVALID_PAYMENT_OWNER", "Payment ownership is invalid.");
  }
  if (payment.status === "REFUNDED") {
    if (webhook && payment.appliedAt) {
      await prisma.paymentTransaction.updateMany({
        where: { id: payment.id },
        data: { webhookProcessedAt: new Date() },
      });
      return { applied: false, alreadyApplied: true, refunded: true };
    }
    throw new RequestError(409, "PAYMENT_ALREADY_REFUNDED", "A refunded payment cannot be applied again.");
  }
  if (payment.appliedAt && payment.status === "SUCCESSFUL") {
    if (webhook) {
      await prisma.paymentTransaction.updateMany({
        where: { id: payment.id },
        data: { webhookProcessedAt: new Date() },
      });
    }
    return { applied: true, alreadyApplied: true };
  }
  if (payment.status === "SUCCESSFUL" && payment.verifiedAt) {
    if (webhook) {
      await prisma.paymentTransaction.updateMany({
        where: { id: payment.id },
        data: { webhookProcessedAt: new Date() },
      });
    }
    return { applied: false, alreadyVerified: true, requiresReconciliation: true };
  }

  const expectedAmount = payment.order
    ? payment.order.totalAmountKobo
    : payment.donation.totalAmountKobo;
  const expectedCurrency = payment.order
    ? payment.order.currency
    : payment.donation.currency;
  const expectedEmail = payment.order
    ? payment.order.customerEmail
    : payment.donation.donorEmail;
  if (payment.amountKobo !== expectedAmount || payment.currency !== expectedCurrency || expectedCurrency !== NGN) {
    throw new RequestError(409, "PAYMENT_AMOUNT_MISMATCH", "Payment amount or currency does not match the checkout.");
  }

  const verified = await paystack.verifyPayment(reference);
  if (
    verified?.status !== "success" ||
    verified.reference !== reference ||
    verified.amount !== expectedAmount ||
    verified.currency !== expectedCurrency ||
    typeof verified.customer?.email !== "string" ||
    verified.customer.email.trim().toLowerCase() !== expectedEmail.trim().toLowerCase() ||
    !validPaystackTransactionId(verified.id)
  ) {
    if (verified?.reference === reference && verified?.status !== "success") {
      await prisma.paymentTransaction.updateMany({
        where: { id: payment.id, status: "PENDING", appliedAt: null },
        data: { status: "FAILED", ...(webhook ? { webhookProcessedAt: new Date() } : {}) },
      });
    }
    throw new RequestError(409, "PAYMENT_VERIFICATION_FAILED", "The payment could not be verified against this checkout.");
  }

  const verifiedAt = new Date();
  const paystackTransactionId = BigInt(verified.id);
  return prisma.$transaction(async (tx) => {
    const current = await tx.paymentTransaction.findUnique({
      where: { id: payment.id },
      select: { status: true, verifiedAt: true, appliedAt: true },
    });
    if (!current) throw new RequestError(404, "PAYMENT_NOT_FOUND", "Payment reference not found.");
    if (current.status === "REFUNDED") {
      throw new RequestError(409, "PAYMENT_ALREADY_REFUNDED", "A refunded payment cannot be applied again.");
    }
    if (current.appliedAt) {
      if (webhook) {
        await tx.paymentTransaction.updateMany({
          where: { id: payment.id },
          data: { webhookProcessedAt: new Date() },
        });
      }
      return { applied: true, alreadyApplied: true };
    }
    if (current.status === "SUCCESSFUL" && current.verifiedAt) {
      if (webhook) {
        await tx.paymentTransaction.updateMany({
          where: { id: payment.id },
          data: { webhookProcessedAt: new Date() },
        });
      }
      return { applied: false, alreadyVerified: true, requiresReconciliation: true };
    }

    const changedPayment = await tx.paymentTransaction.updateMany({
      where: {
        id: payment.id,
        status: { in: ["PENDING", "FAILED"] },
        appliedAt: null,
      },
      data: {
        status: "SUCCESSFUL",
        verifiedAt,
        paystackTransactionId,
        ...(webhook ? { webhookProcessedAt: verifiedAt } : {}),
      },
    });
    if (!changedPayment.count) {
      const latest = await tx.paymentTransaction.findUnique({
        where: { id: payment.id },
        select: { status: true, appliedAt: true },
      });
      return {
        applied: Boolean(latest?.appliedAt),
        alreadyApplied: Boolean(latest?.appliedAt),
        requiresReconciliation: !latest?.appliedAt,
      };
    }

    const ownerUpdated = payment.order
      ? await tx.treeOrder.updateMany({
          where: {
            id: payment.order.id,
            status: "PENDING_PAYMENT",
            paymentStatus: "PENDING",
            locationReviewStatus: { not: "REJECTED" },
          },
          data: { status: "PAID", paymentStatus: "SUCCESSFUL" },
        })
      : await tx.treeDonation.updateMany({
          where: { id: payment.donation.id, paymentStatus: "PENDING" },
          data: { paymentStatus: "SUCCESSFUL" },
        });
    if (!ownerUpdated.count) {
        await tx.auditLog.create({
          data: {
            actorId: null,
            action: "PAYMENT_VERIFIED_REQUIRES_RECONCILIATION",
            entityType: "PaymentTransaction",
            entityId: payment.id,
            description: "Verified payment could not be applied to an already-transitioned checkout.",
            metadata: {
              amountKobo: payment.amountKobo,
              currency: payment.currency,
              ownerType: payment.order ? "TreeOrder" : "TreeDonation",
            },
          },
        });
        return { applied: false, requiresReconciliation: true };
    }

    const applied = await tx.paymentTransaction.updateMany({
      where: {
        id: payment.id,
        status: "SUCCESSFUL",
        appliedAt: null,
      },
      data: { appliedAt: verifiedAt },
    });
    if (!applied.count) {
      throw new RequestError(409, "PAYMENT_APPLICATION_CONFLICT", "The verified payment could not be applied safely.");
    }
    await tx.auditLog.create({
      data: {
        actorId: null,
        action: "PAYMENT_VERIFIED_AND_APPLIED",
        entityType: "PaymentTransaction",
        entityId: payment.id,
        description: "Paystack payment verified and applied to its checkout.",
        metadata: {
          amountKobo: payment.amountKobo,
          currency: payment.currency,
          ownerType: payment.order ? "TreeOrder" : "TreeDonation",
        },
      },
    });
    return { applied: true, alreadyApplied: false };
  });
}

async function verifyPayment(req, res) {
  if (!requireObject(req.body) ||
      Object.keys(req.body).some((key) => key !== "reference") ||
      typeof req.body.reference !== "string" ||
      !/^payment-[a-f\d-]{36}$/i.test(req.body.reference)) {
    return sendError(res, 400, "INVALID_PAYMENT_REFERENCE", "Provide a valid payment reference.");
  }
  try {
    const result = await verifyAndApplyPayment(req.body.reference);
    return res.json({
      success: true,
      paymentStatus: result.applied ? "SUCCESSFUL" : "REQUIRES_RECONCILIATION",
      applied: result.applied,
      alreadyApplied: Boolean(result.alreadyApplied),
    });
  } catch (error) {
    if (error instanceof RequestError) return sendError(res, error.status, error.code, error.message);
    if (error.status) return paystackError(res, error);
    return schemaError(res, error);
  }
}

async function handlePaystackWebhook(req, res) {
  const signature = req.get("x-paystack-signature");
  if (!paystack.verifyWebhookSignature(req.rawBody, signature)) {
    return sendError(res, 401, "INVALID_WEBHOOK_SIGNATURE", "Webhook signature is invalid.");
  }
  const event = req.body;
  if (event?.event !== "charge.success" || typeof event?.data?.reference !== "string") {
    return res.status(200).json({ success: true, received: true });
  }
  try {
    await verifyAndApplyPayment(event.data.reference, { webhook: true });
    return res.status(200).json({ success: true, received: true });
  } catch (error) {
    if (error instanceof RequestError && error.status < 500) {
      return sendError(res, error.status, error.code, error.message);
    }
    if (error.status) return paystackError(res, error);
    return schemaError(res, error);
  }
}

module.exports = {
  createOrder,
  createDonation,
  listAdminOrders,
  reviewOrderLocation,
  listAdminDonations,
  initializeExistingPayment,
  verifyPayment,
  handlePaystackWebhook,
  verifyAndApplyPayment,
};
