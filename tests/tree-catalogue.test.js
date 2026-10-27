const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../src/config/database");
const {
  listPublicSpecies,
  listAdminSpecies,
  createSpecies,
  setPublication,
} = require("../src/controllers/tree-catalogue.controller");

const originalFindMany = prisma.treeSpecies.findMany;
const originalCount = prisma.treeSpecies.count;
const originalTransaction = prisma.$transaction;

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

function request(body = {}, role = "ADMIN") {
  return {
    params: { id: "tree-1" },
    query: {},
    body,
    user: { id: "admin-1", role },
  };
}

test.afterEach(() => {
  prisma.treeSpecies.findMany = originalFindMany;
  prisma.treeSpecies.count = originalCount;
  prisma.$transaction = originalTransaction;
});

test("public catalogue lists only published, active, priced trees with pagination", async () => {
  let query;
  prisma.treeSpecies.findMany = async (args) => {
    query = args;
    return [{ id: "tree-1", name: "Oak", priceKobo: 25000 }];
  };
  prisma.treeSpecies.count = async ({ where }) => {
    assert.deepEqual(where, query.where);
    return 1;
  };
  prisma.$transaction = async (queries) => Promise.all(queries);
  const res = response();

  await listPublicSpecies({ query: { page: "2", limit: "10" } }, res);

  assert.deepEqual(query.where, {
    isActive: true,
    isPublished: true,
    priceKobo: { gt: 0 },
  });
  assert.equal(query.skip, 10);
  assert.equal(query.take, 10);
  assert.equal(res.body.trees[0].name, "Oak");
});

test("invalid catalogue prices and non-admin creation are rejected", async () => {
  const invalid = response();
  await createSpecies(request({ name: "Oak", priceKobo: -10 }), invalid);
  assert.equal(invalid.statusCode, 400);

  const forbidden = response();
  await createSpecies(request({ name: "Oak", priceKobo: 25000 }, "PROGRAMME_MANAGER"), forbidden);
  assert.equal(forbidden.statusCode, 403);
});

test("authenticated non-admin roles cannot view unpublished catalogue entries", async () => {
  let queries = 0;
  prisma.treeSpecies.findMany = async () => {
    queries += 1;
    return [];
  };
  const res = response();
  await listAdminSpecies(request({}, "DATA_ENTRY_OFFICER"), res);
  assert.equal(res.statusCode, 403);
  assert.equal(queries, 0);
});

test("new tree species start unpublished and creation is audited atomically", async () => {
  let data;
  let audit;
  prisma.$transaction = async (callback) => callback({
    treeSpecies: {
      async create(args) {
        data = args.data;
        return { id: "tree-1", ...args.data };
      },
    },
    auditLog: {
      async create(args) {
        audit = args.data;
      },
    },
  });
  const res = response();

  await createSpecies(request({ name: " Oak ", priceKobo: 25000 }), res);

  assert.equal(res.statusCode, 201);
  assert.equal(data.name, "Oak");
  assert.equal(data.isPublished, false);
  assert.equal(data.createdById, "admin-1");
  assert.equal(audit.action, "TREE_SPECIES_CREATED");
});

test("a tree cannot be published without an active state and positive price", async () => {
  prisma.$transaction = async (callback) => callback({
    treeSpecies: {
      async findUnique() {
        return { id: "tree-1", name: "Oak", priceKobo: 0, isActive: true };
      },
    },
  });
  const res = response();

  await setPublication(request({ isPublished: true }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, "TREE_NOT_SELLABLE");
});
