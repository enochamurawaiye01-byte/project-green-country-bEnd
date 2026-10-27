const test = require("node:test");
const assert = require("node:assert/strict");
const { checkCommerceSchemaCompatibility } = require("../src/services/commerce-schema.service");

test("commerce enablement refuses a database missing tables, columns, enums and integrity constraints", async () => {
  let columnQuery;
  const db = {
    async $queryRawUnsafe(query) {
      columnQuery = query;
      return [
        { table_name: "TreeOrder", column_name: "id" },
        { table_name: "PaymentTransaction", column_name: "reference" },
      ];
    },
    async $queryRaw() {
      return [];
    },
  };

  const result = await checkCommerceSchemaCompatibility(db);

  assert.equal(columnQuery.includes("information_schema.columns"), true);
  assert.equal(result.compatible, false);
  assert.equal(result.missing.columns.includes("TreeOrder.id"), true);
  assert.equal(result.missing.enums.length, 5);
  assert.ok(result.missing.constraints.length > 0);
  assert.equal(result.missing.indexes.length, 2);
});
