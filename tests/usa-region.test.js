const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const authJwt = require("../helpers/jwt");
const { createUsaRegionGuard } = require("../helpers/usa-region");
const db = require("../helpers/db-manager");
const settings = require("../routers/settings");

const secret = "usa-availability-test-only";
const admin = "000000000000000000000001";
const tester = "000000000000000000000002";
const customer = "000000000000000000000003";
const unverified = "000000000000000000000004";

test("USA switch blocks new shopping but preserves existing activity and verified regional access", async (t) => {
  const previous = process.env.secret;
  process.env.secret = secret;
  let enabled = true;
  let outage = false;
  let testerEmails = ["tester@example.test"];
  const users = {
    [admin]: { _id: admin, isAdmin: true },
    [tester]: { _id: tester, isEmailVerified: true, email: "tester@example.test" },
    [customer]: { _id: customer, isEmailVerified: true, email: "customer@example.test" },
    [unverified]: { _id: unverified, isEmailVerified: false, email: "tester@example.test" },
  };
  const models = {
    SiteSetting: {
      findOne: ({ key }) => ({ lean: async () => {
        if (outage) throw new Error("Database unavailable");
        return key === "usa-region-availability"
          ? { usaRegionEnabled: enabled } : key === "testing-access" ? { testingEmails: testerEmails } : null;
      } }),
      findOneAndUpdate: async (filter, update) => {
        assert.equal(filter.key, "usa-region-availability");
        enabled = update.$set.usaRegionEnabled;
        return { usaRegionEnabled: enabled };
      },
    },
    User: { findOne: (filter) => ({ select: () => ({ lean: async () => {
      const user = users[filter._id];
      return filter.isAdmin && !user?.isAdmin ? null : user;
    } }) }) },
  };
  t.mock.method(db, "getModelsForDb", () => models);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.dbName = req.get("x-database-name") || "E_Shopping"; req.dbModels = models; next(); });
  app.use(authJwt());
  app.use("/api/v1", createUsaRegionGuard());
  app.use("/api/v1/settings", settings);
  app.get("/api/v1/products", (req, res) => res.json({ ok: true }));
  app.get("/api/v1/users/profile", (req, res) => res.json({ ok: true }));
  app.get("/api/v1/stores/checkouts", (req, res) => res.json({ ok: true }));
  app.post("/api/v1/stores/checkouts/quote", (req, res) => res.json({ ok: true }));
  app.post("/api/v1/stores/checkouts/:id/prepare", (req, res) => res.json({ ok: true }));
  app.post("/api/v1/stores/checkouts/:id/confirm", (req, res) => res.json({ ok: true }));
  app.get("/api/v1/drivers/me/queue", (req, res) => res.json({ ok: true }));
  app.post("/api/v1/users/login", (req, res) => res.json({ ok: true }));
  app.post("/api/v1/users/register", (req, res) => res.json({ ok: true }));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ message: error.message }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => {
    server.closeAllConnections(); server.close();
    if (previous === undefined) delete process.env.secret; else process.env.secret = previous;
  });
  const request = (path, { id, database = "E_ShopUSA", method = "GET", body } = {}) => fetch(
    `http://127.0.0.1:${server.address().port}/api/v1${path}`, {
      method, headers: { "Content-Type": "application/json", "x-database-name": database,
        ...(id ? { Authorization: `Bearer ${jwt.sign({ userId: id }, secret)}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  assert.equal((await request("/products")).status, 200);
  assert.equal((await request("/settings/usa-availability", { id: customer, method: "PUT", body: { enabled: false } })).status, 403);
  assert.equal((await request("/settings/usa-availability", { id: admin, method: "PUT", body: { enabled: "false" } })).status, 400);
  assert.equal((await request("/settings/usa-availability", { id: admin, database: "E_Shopping", method: "PUT", body: { enabled: false } })).status, 200);
  for (const database of ["E_ShopUSA", "E_ShoppingUSA"]) {
    assert.equal((await request("/products", { database })).status, 403);
    assert.equal((await request("/products", { database, id: customer })).status, 403);
    assert.equal((await request("/PRODUCTS", { database, id: customer })).status, 403);
    assert.equal((await request("/products", { database, id: unverified })).status, 403);
    assert.equal((await request("/products", { database, id: tester })).status, 200);
    assert.equal((await request("/products", { database, id: admin })).status, 200);
    assert.equal((await request("/users/login", { database, method: "POST" })).status, 200);
    assert.equal((await request("/users/register", { database, method: "POST" })).status, 403);
    assert.equal((await request("/users/profile", { database, id: customer })).status, 200);
    assert.equal((await request("/stores/checkouts", { database, id: customer })).status, 200);
    assert.equal((await request("/stores/checkouts/abc/confirm", { database, id: customer, method: "POST" })).status, 200);
    assert.equal((await request("/drivers/me/queue", { database, id: customer })).status, 200);
    assert.equal((await request("/stores/checkouts/quote", { database, id: customer, method: "POST" })).status, 403);
    assert.equal((await request("/stores/checkouts/abc/prepare", { database, id: customer, method: "POST" })).status, 403);
    assert.equal((await request("/STORES/CHECKOUTS/abc/PREPARE", { database, id: customer, method: "POST" })).status, 403);
  }
  testerEmails = [];
  assert.equal((await request("/products", { id: tester })).status, 403);
  testerEmails = ["tester@example.test"];
  outage = true;
  assert.equal((await request("/products", { id: tester })).status, 503);
  assert.equal((await request("/settings/usa-availability")).status, 503);
  outage = false;
  assert.equal((await request("/products", { database: "E_Shopping" })).status, 200);
  assert.equal((await (await request("/settings/maintenance", { id: tester })).json()).usaRegionEnabled, false);
  assert.equal((await request("/settings/usa-availability", { id: admin, method: "PUT", body: { enabled: true } })).status, 200);
  assert.equal((await request("/products")).status, 200);
});
