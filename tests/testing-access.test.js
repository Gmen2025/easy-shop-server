const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const authJwt = require("../helpers/jwt");
const { maintenanceGuard } = require("../helpers/maintenance");
const { requireServiceAvailable } = require("../helpers/service-availability");
const ADMIN = "000000000000000000000001";
const TESTER = "000000000000000000000002";
const ORDINARY = "000000000000000000000003";
const UNVERIFIED = "000000000000000000000004";
const secret = "regional-testing-only-secret";
const query = (value) => {
  const result = { lean: async () => value, select: () => result, session: () => result,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
  return result;
};

async function fixture(t) {
  const previous = process.env.secret;
  process.env.secret = secret;
  t.after(() => { if (previous === undefined) delete process.env.secret; else process.env.secret = previous; });
  const users = new Map([
    [ADMIN, { _id: ADMIN, email: "admin@example.test", isAdmin: true }],
    [TESTER, { _id: TESTER, email: "Tester@Example.Test", isEmailVerified: true }],
    [ORDINARY, { _id: ORDINARY, email: "ordinary@example.test", isEmailVerified: true }],
    [UNVERIFIED, { _id: UNVERIFIED, email: "unverified@example.test", isEmailVerified: false }],
  ]);
  const regions = new Map();
  let outage = false;
  const workspace = () => {
    const documents = new Map();
    return { documents, db: { startSession: async () => ({
      withTransaction: async (action) => action(), endSession: async () => {},
    }) }, findOne: ({ owner }) => query(documents.get(owner)),
    create: async ([document]) => { documents.set(document.owner, document); } };
  };
  const models = (database) => {
    if (!regions.has(database)) regions.set(database, {
      settings: new Map(), CustomerFinancialWorkspace: workspace(), FinancialWorkspace: workspace(),
    });
    const region = regions.get(database);
    return { ...region,
      User: { findOne: (filter) => {
        const user = users.get(filter._id);
        return query(user && (!filter.isAdmin || user.isAdmin === true) ? user : null);
      } },
      SiteSetting: {
        findOne: ({ key }) => {
          if (outage) throw new Error("Settings unavailable");
          return query(region.settings.get(key));
        },
        findOneAndUpdate: ({ key }, update) => {
          if (outage) throw new Error("Settings unavailable");
          const setting = region.settings.get(key) || {};
          for (const [field, value] of Object.entries(update.$set)) {
            if (field.startsWith("serviceAvailability.")) {
              setting.serviceAvailability ||= {};
              setting.serviceAvailability[field.split(".")[1]] = value;
            } else setting[field] = value;
          }
          region.settings.set(key, setting);
          return query(setting);
        },
      },
      ServiceRequest: { create: async (body) => ({ ...body, _id: "request" }) },
    };
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.dbModels = models(req.get("x-database-name") || "E_Shopping"); next(); });
  app.use(authJwt());
  app.use("/api/v1", maintenanceGuard);
  app.use("/api/v1/settings", require("../routers/settings"));
  app.use("/api/v1/service-requests", require("../routers/service-requests"));
  const financial = require("../routers/financial-management");
  app.use("/api/v1/financial-health", financial.createRouter(true));
  app.use("/api/v1/financial-management", financial);
  app.get("/api/v1/products", (req, res) => res.json({ available: true }));
  app.post("/api/v1/stores/checkouts/saved/confirm", (req, res) => res.json({ recovered: true }));
  app.post("/api/v1/telebirr/webhook", (req, res) => res.json({ received: true }));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ message: error.message }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (path, { as = ADMIN, database = "E_Shopping", method = "GET", body, claims = {} } = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, {
      method, headers: { "Content-Type": "application/json", "x-database-name": database,
        ...(as ? { Authorization: `Bearer ${jwt.sign({ ...claims, userId: as }, secret)}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const save = (path, body, options = {}) => request(`/settings/${path}`, { method: "PUT", body, ...options });
  return { request, save, models, regions, users, outage: () => { outage = true; } };
}

test("verified regional testers can use disabled services without Admin permissions, and removal revokes access", async (t) => {
  const f = await fixture(t);
  const setting = "/settings/service-availability";
  await f.save("service-availability", { rides: false, services: false });
  const emails = await f.save("testing-access", { emails: [" Tester@Example.Test ", "tester@example.test", "unverified@example.test"] });
  assert.deepEqual(await emails.json(), { emails: ["tester@example.test", "unverified@example.test"] });
  const publicStatus = await (await f.request(setting, { as: null })).json();
  assert.deepEqual(publicStatus, { rides: false, services: false, financialHealth: false, testingAccess: false });
  const testerStatus = await f.request(setting, { as: TESTER });
  assert.match(testerStatus.headers.get("cache-control"), /private.*no-store/);
  assert.equal((await testerStatus.json()).testingAccess, true);
  assert.equal((await (await f.request(setting, { as: TESTER, database: "E_ShopUSA" })).json()).testingAccess, false);
  for (const as of [ORDINARY, UNVERIFIED]) {
    assert.equal((await (await f.request(setting, { as, claims: { isAdmin: true, email: "tester@example.test" } })).json()).testingAccess, false);
    await assert.rejects(requireServiceAvailable(f.models("E_Shopping"), "rides", null, as), { status: 403 });
  }
  for (const as of [ADMIN, TESTER]) await requireServiceAvailable(f.models("E_Shopping"), "rides", null, as);
  const body = { country: "Ethiopia", serviceLocation: "On-site", machineType: "Machine",
    problemDescription: "Repair", contactPhone: "12345678" };
  assert.equal((await f.request("/service-requests", { as: TESTER, method: "POST", body })).status, 201);
  assert.equal((await f.request("/service-requests", { as: ORDINARY, method: "POST", body })).status, 403);
  assert.equal((await f.save("service-availability", { rides: true }, { as: TESTER })).status, 403);
  assert.equal((await f.request("/settings/testing-access", { as: TESTER })).status, 403);
  assert.equal((await f.save("testing-access", { emails: [] }, { as: TESTER })).status, 403);
  await f.save("testing-access", { emails: [] });
  await assert.rejects(requireServiceAvailable(f.models("E_Shopping"), "rides", null, TESTER), { status: 403 });
  assert.equal((await (await f.request(setting, { as: TESTER })).json()).testingAccess, false);
});

test("Financial Health shares its existing switch and preserves owner-private customer and Admin workspaces", async (t) => {
  const f = await fixture(t);
  await f.save("testing-access", { emails: ["tester@example.test"] });
  assert.equal((await f.request("/financial-health/workspace", { as: ORDINARY })).status, 403);
  assert.equal((await f.request("/financial-health/workspace?owner=" + ADMIN, { as: TESTER })).status, 400);
  assert.equal((await f.request("/financial-health/workspace", { as: TESTER })).status, 200);
  const customers = f.regions.get("E_Shopping").CustomerFinancialWorkspace.documents;
  assert.equal(customers.has(TESTER), true);
  assert.equal(customers.has(ADMIN), false);
  assert.equal((await f.request("/financial-management/workspace", { as: TESTER })).status, 403);
  await f.save("service-availability", { financialHealth: true });
  assert.equal((await (await f.request("/settings/financial-health", { as: null })).json()).enabled, true);
  assert.equal((await f.request("/financial-health/workspace", { as: ORDINARY })).status, 200);
  await f.save("financial-health", { enabled: false });
  assert.equal((await (await f.request("/settings/service-availability", { as: null })).json()).financialHealth, false);
  assert.equal((await f.request("/financial-health/workspace", { as: ORDINARY })).status, 403);
  assert.equal((await f.request("/financial-health/workspace", { as: ADMIN })).status, 200);
  assert.equal((await f.request("/financial-health/workspace", { as: TESTER, database: "E_ShopUSA" })).status, 403);
});

test("maintenance uses the same regional verified tester list and allows login/status and saved payment recovery", async (t) => {
  const f = await fixture(t);
  await f.save("testing-access", { emails: ["tester@example.test", "unverified@example.test"] });
  await f.save("maintenance", { enabled: true });
  for (const as of [null, ORDINARY, UNVERIFIED]) {
    assert.equal((await f.request("/products", { as })).status, 503);
    assert.equal((await (await f.request("/settings/maintenance", { as })).json()).testingAccess, false);
  }
  for (const as of [ADMIN, TESTER]) assert.equal((await f.request("/products", { as })).status, 200);
  assert.equal((await f.request("/products", { as: ORDINARY, database: "E_ShopUSA" })).status, 200);
  assert.equal((await f.request("/stores/checkouts/saved/confirm", { as: ORDINARY, method: "POST" })).status, 200);
  assert.equal((await f.request("/telebirr/webhook", { as: null, method: "POST" })).status, 200);
  for (const path of ["/stripe/create-payment-intent", "/telebirr/initiate-payment"]) {
    assert.equal((await f.request(path, { as: ORDINARY, method: "POST" })).status, 503);
  }
  assert.equal((await f.save("maintenance", { enabled: false }, { as: TESTER })).status, 403);
  await f.save("testing-access", { emails: [] });
  assert.equal((await f.request("/products", { as: TESTER })).status, 503);
  assert.equal((await f.save("testing-access", { emails: ["not-an-email"] })).status, 400);
  assert.equal((await f.save("maintenance", { enabled: "false" })).status, 400);
  f.outage();
  assert.equal((await f.request("/products", { as: ADMIN })).status, 503);
  assert.equal((await f.request("/settings/service-availability", { as: TESTER })).status, 503);
});
