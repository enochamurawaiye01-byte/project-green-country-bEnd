const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../src/config/database");
const {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  createNotification,
} = require("../src/controllers/notification.controller");

const originalNotificationFindMany = prisma.notification.findMany;
const originalNotificationCount = prisma.notification.count;
const originalNotificationCreate = prisma.notification.create;
const originalNotificationUpdateMany = prisma.notification.updateMany;

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

function request(body = {}, role = "DATA_ENTRY_OFFICER", id = "notification-1") {
  return {
    params: { id },
    query: {},
    body,
    user: { id: "user-1", role },
  };
}

test.afterEach(() => {
  prisma.notification.findMany = originalNotificationFindMany;
  prisma.notification.count = originalNotificationCount;
  prisma.notification.create = originalNotificationCreate;
  prisma.notification.updateMany = originalNotificationUpdateMany;
});

test("notification listing is scoped to the authenticated user", async () => {
  let where;
  prisma.notification.findMany = async (query) => {
    where = query.where;
    return [{ id: "notification-1", isRead: false }];
  };
  prisma.notification.count = async ({ where: filter }) => filter.isRead === false ? 1 : 3;
  const res = response();

  await listNotifications(request(), res);

  assert.deepEqual(where, { userId: "user-1" });
  assert.equal(res.body.unreadCount, 1);
  assert.equal(res.body.total, 3);
  assert.equal(res.body.page, 1);
  assert.equal(res.body.limit, 50);
});

test("notification pagination remains scoped to the current user", async () => {
  let query;
  prisma.notification.findMany = async (args) => {
    query = args;
    return [];
  };
  prisma.notification.count = async () => 11;
  const res = response();
  const req = request();
  req.query = { page: "2", limit: "5" };

  await listNotifications(req, res);

  assert.deepEqual(query.where, { userId: "user-1" });
  assert.equal(query.skip, 5);
  assert.equal(query.take, 5);
  assert.equal(res.body.total, 11);
});

test("invalid notification pagination is rejected", async () => {
  const res = response();
  const req = request();
  req.query = { page: "0", limit: "101" };
  await listNotifications(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, "INVALID_PAGINATION");
});

test("marking a notification read cannot access another user's notification", async () => {
  let where;
  prisma.notification.updateMany = async (query) => {
    where = query.where;
    return { count: 0 };
  };
  const res = response();

  await markNotificationRead(request(), res);

  assert.deepEqual(where, { id: "notification-1", userId: "user-1" });
  assert.equal(res.statusCode, 404);
});

test("mark-all-read only updates the authenticated user's unread notifications", async () => {
  let query;
  prisma.notification.updateMany = async (args) => {
    query = args;
    return { count: 3 };
  };
  const res = response();

  await markAllNotificationsRead(request(), res);

  assert.deepEqual(query.where, { userId: "user-1", isRead: false });
  assert.equal(res.body.updatedCount, 3);
});

test("only administrators can create notifications and links must remain same-site", async () => {
  const forbidden = response();
  await createNotification(
    request({ userId: "user-2", title: "Hello", message: "Hi" }),
    forbidden
  );
  assert.equal(forbidden.statusCode, 403);

  const unsafeLink = response();
  await createNotification(
    request(
      { userId: "user-2", title: "Hello", message: "Hi", link: "//attacker.invalid" },
      "ADMIN"
    ),
    unsafeLink
  );
  assert.equal(unsafeLink.statusCode, 400);

  let created;
  prisma.notification.create = async ({ data }) => {
    created = data;
    return { id: "notification-2", ...data, isRead: false };
  };
  const res = response();
  await createNotification(
    request(
      { userId: "user-2", title: "Hello", message: "Hi", link: "/dashboard" },
      "ADMIN"
    ),
    res
  );

  assert.equal(res.statusCode, 201);
  assert.equal(created.userId, "user-2");
  assert.equal(created.link, "/dashboard");
});
