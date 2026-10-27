const { prisma } = require("../config/database");

const REQUIRED_COLUMNS = [
  ["TreeSpecies", "id"],
  ["TreeSpecies", "name"],
  ["TreeSpecies", "priceKobo"],
  ["TreeSpecies", "isActive"],
  ["TreeSpecies", "isPublished"],
  ["TreeOrder", "id"],
  ["TreeOrder", "reference"],
  ["TreeOrder", "customerName"],
  ["TreeOrder", "customerEmail"],
  ["TreeOrder", "customerPhone"],
  ["TreeOrder", "requestedLocation"],
  ["TreeOrder", "status"],
  ["TreeOrder", "paymentStatus"],
  ["TreeOrder", "locationReviewStatus"],
  ["TreeOrder", "fulfilmentStatus"],
  ["TreeOrder", "plantingVerificationStatus"],
  ["TreeOrder", "totalAmountKobo"],
  ["TreeOrder", "currency"],
  ["TreeOrderItem", "orderId"],
  ["TreeOrderItem", "speciesId"],
  ["TreeOrderItem", "speciesName"],
  ["TreeOrderItem", "quantity"],
  ["TreeOrderItem", "unitPriceKobo"],
  ["TreeOrderItem", "lineTotalKobo"],
  ["TreeDonation", "id"],
  ["TreeDonation", "reference"],
  ["TreeDonation", "donorName"],
  ["TreeDonation", "donorEmail"],
  ["TreeDonation", "donorPhone"],
  ["TreeDonation", "speciesId"],
  ["TreeDonation", "speciesName"],
  ["TreeDonation", "quantity"],
  ["TreeDonation", "unitPriceKobo"],
  ["TreeDonation", "totalAmountKobo"],
  ["TreeDonation", "currency"],
  ["TreeDonation", "paymentStatus"],
  ["TreeDonation", "plantingVerificationStatus"],
  ["PaymentTransaction", "id"],
  ["PaymentTransaction", "orderId"],
  ["PaymentTransaction", "donationId"],
  ["PaymentTransaction", "reference"],
  ["PaymentTransaction", "paystackTransactionId"],
  ["PaymentTransaction", "amountKobo"],
  ["PaymentTransaction", "currency"],
  ["PaymentTransaction", "status"],
  ["PaymentTransaction", "verifiedAt"],
  ["PaymentTransaction", "webhookProcessedAt"],
  ["PaymentTransaction", "appliedAt"],
  ["PlantingRecord", "treeOrderId"],
  ["PlantingRecord", "treeDonationId"],
  ["AuditLog", "actorId"],
  ["AuditLog", "action"],
  ["AuditLog", "entityType"],
  ["AuditLog", "entityId"],
  ["AuditLog", "description"],
  ["AuditLog", "metadata"],
];

const REQUIRED_ENUMS = {
  TreeOrderStatus: ["PENDING_PAYMENT", "PAID", "PROCESSING", "COMPLETED", "CANCELLED"],
  PaymentStatus: ["PENDING", "SUCCESSFUL", "FAILED", "REFUNDED"],
  LocationReviewStatus: ["PENDING", "APPROVED", "REJECTED"],
  OrderFulfilmentStatus: ["NOT_SCHEDULED", "SCHEDULED", "PLANTED", "VERIFICATION_PENDING"],
  PlantingVerificationStatus: ["NOT_STARTED", "PENDING", "VERIFIED", "REJECTED"],
};

const REQUIRED_CONSTRAINTS = [
  "TreeSpecies_priceKobo_nonnegative_check",
  "TreeOrder_pkey",
  "TreeOrder_reference_key",
  "TreeOrder_totalAmountKobo_positive_check",
  "TreeOrder_currency_ngn_check",
  "TreeOrderItem_pkey",
  "TreeOrderItem_quantity_positive_check",
  "TreeOrderItem_unitPriceKobo_nonnegative_check",
  "TreeOrderItem_lineTotalKobo_check",
  "TreeOrderItem_orderId_fkey",
  "TreeOrderItem_speciesId_fkey",
  "TreeDonation_pkey",
  "TreeDonation_reference_key",
  "TreeDonation_quantity_positive_check",
  "TreeDonation_unitPriceKobo_nonnegative_check",
  "TreeDonation_totalAmountKobo_check",
  "TreeDonation_currency_ngn_check",
  "TreeDonation_speciesId_fkey",
  "PaymentTransaction_pkey",
  "PaymentTransaction_reference_key",
  "PaymentTransaction_paystackTransactionId_key",
  "PaymentTransaction_amountKobo_positive_check",
  "PaymentTransaction_currency_ngn_check",
  "PaymentTransaction_applied_requires_verified_payment_check",
  "PaymentTransaction_exactly_one_owner_check",
  "PaymentTransaction_orderId_fkey",
  "PaymentTransaction_donationId_fkey",
  "PlantingRecord_commerce_owner_check",
  "PlantingRecord_treeOrderId_fkey",
  "PlantingRecord_treeDonationId_fkey",
];

const REQUIRED_INDEXES = [
  "PaymentTransaction_one_applied_payment_per_order_key",
  "PaymentTransaction_one_applied_payment_per_donation_key",
];

async function checkCommerceSchemaCompatibility(db = prisma) {
  const expectedColumns = REQUIRED_COLUMNS.map(([table, column]) => `('${table}', '${column}')`).join(", ");
  const columnRows = await db.$queryRawUnsafe(
    `SELECT required.table_name, required.column_name
     FROM (VALUES ${expectedColumns}) AS required(table_name, column_name)
     LEFT JOIN information_schema.columns actual
       ON actual.table_schema = 'public'
      AND actual.table_name = required.table_name
      AND actual.column_name = required.column_name
     WHERE actual.column_name IS NULL`
  );
  const enumRows = await db.$queryRaw`
    SELECT t.typname AS enum_name,
           array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname IN (
        'TreeOrderStatus',
        'PaymentStatus',
        'LocationReviewStatus',
        'OrderFulfilmentStatus',
        'PlantingVerificationStatus'
      )
    GROUP BY t.typname`;
  const integrityRows = await db.$queryRaw`
    SELECT 'constraint' AS kind, conname AS name
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND convalidated = true
      AND conname = ANY(ARRAY[
        'TreeSpecies_priceKobo_nonnegative_check',
        'TreeOrder_pkey',
        'TreeOrder_reference_key',
        'TreeOrder_totalAmountKobo_positive_check',
        'TreeOrder_currency_ngn_check',
        'TreeOrderItem_pkey',
        'TreeOrderItem_quantity_positive_check',
        'TreeOrderItem_unitPriceKobo_nonnegative_check',
        'TreeOrderItem_lineTotalKobo_check',
        'TreeOrderItem_orderId_fkey',
        'TreeOrderItem_speciesId_fkey',
        'TreeDonation_pkey',
        'TreeDonation_reference_key',
        'TreeDonation_quantity_positive_check',
        'TreeDonation_unitPriceKobo_nonnegative_check',
        'TreeDonation_totalAmountKobo_check',
        'TreeDonation_currency_ngn_check',
        'TreeDonation_speciesId_fkey',
        'PaymentTransaction_pkey',
        'PaymentTransaction_reference_key',
        'PaymentTransaction_paystackTransactionId_key',
        'PaymentTransaction_amountKobo_positive_check',
        'PaymentTransaction_currency_ngn_check',
        'PaymentTransaction_applied_requires_verified_payment_check',
        'PaymentTransaction_exactly_one_owner_check',
        'PaymentTransaction_orderId_fkey',
        'PaymentTransaction_donationId_fkey',
        'PlantingRecord_commerce_owner_check',
        'PlantingRecord_treeOrderId_fkey',
        'PlantingRecord_treeDonationId_fkey'
      ])
    UNION ALL
    SELECT 'index' AS kind, indexname AS name
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = ANY(ARRAY[
        'PaymentTransaction_one_applied_payment_per_order_key',
        'PaymentTransaction_one_applied_payment_per_donation_key'
      ])
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND indexdef ILIKE '% WHERE %'`;

  const actualEnums = new Map(enumRows.map(({ enum_name, labels }) => [enum_name, labels]));
  const missingEnums = Object.entries(REQUIRED_ENUMS)
    .filter(([name, expected]) => {
      const actual = actualEnums.get(name);
      return !actual || expected.some((label) => !actual.includes(label));
    })
    .map(([name]) => name);
  const availableIntegrity = new Set(integrityRows.map(({ name }) => name));
  const missingConstraints = REQUIRED_CONSTRAINTS.filter((name) => !availableIntegrity.has(name));
  const missingIndexes = REQUIRED_INDEXES.filter((name) => !availableIntegrity.has(name));
  return {
    compatible:
      columnRows.length === 0 &&
      missingEnums.length === 0 &&
      missingConstraints.length === 0 &&
      missingIndexes.length === 0,
    missing: {
      columns: columnRows.map(({ table_name, column_name }) => `${table_name}.${column_name}`),
      enums: missingEnums,
      constraints: missingConstraints,
      indexes: missingIndexes,
    },
  };
}

module.exports = { checkCommerceSchemaCompatibility };
