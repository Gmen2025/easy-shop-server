const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const authJwt = require("../helpers/jwt");
const settingsRouter = require("../routers/settings");
const serviceRouter = require("../routers/service-requests");
const { readServiceAvailability, requireServiceAvailable } = require("../helpers/service-availability");
const { siteSettingSchema } = require("../models/site-setting");

const secret = "service-availability-test-only";
const userId = "000000000000000000000001";
const requestId = "000000000000000000000002";
function fixture() {
  const regions = new Map(), requests = new Map();
  let outage = false, adminExists = true;
  const models = (database) => ({
    SiteSetting: {
      findOne: ({ key }) => {
        assert.equal(key, "service-availability");
        const query = { session: () => query, lean: async () => {
          if (outage) throw new Error("Database unavailable");
          return regions.get(database);
        } };
        return query;
      },
      findOneAndUpdate: ({ key }, update, options) => ({ lean: async () => {
        assert.equal(key, "service-availability");
        assert.equal(options.upsert, true);
        assert.equal(options.runValidators, true);
        if (outage) throw new Error("Database unavailable");
        const value = regions.get(database) || { serviceAvailability: {} };
        for (const [field, enabled] of Object.entries(update.$set)) {
          if (field.startsWith("serviceAvailability.")) value.serviceAvailability[field.split(".")[1]] = enabled;
          else value[field] = enabled;
        }
        regions.set(database, value);
        return value;
      } }),
    },
    User: { findOne: (filter) => ({ select: () => ({ lean: async () => {
      assert.equal(filter.isAdmin, true);
      return filter._id === userId && adminExists ? { _id: userId } : null;
    } }) }) },
    ServiceRequest: {
      create: async (payload) => {
        const record = { ...payload, _id: requestId };
        requests.set(database, record);
        return record;
      },
      find: () => ({ populate: () => ({ sort: async () => requests.has(database) ? [requests.get(database)] : [] }) }),
      findById: async () => requests.get(database),
      findOneAndUpdate: async (filter, update) => {
        const record = requests.get(database);
        assert.equal(filter._id, requestId);
        return { ...record, ...update, populate: async () => {} };
      },
    },
  });
  return { models, regions, requests, outage: () => { outage = true; }, revokeAdmin: () => { adminExists = false; } };
}
async function serve(t, state) {
  process.env.secret = secret;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.dbModels = state.models(req.get("x-database-name") || "E_Shopping"); next(); });
  app.use(authJwt());
  app.use("/api/v1/settings", settingsRouter);
  app.use("/api/v1/service-requests", serviceRouter);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ message: error.message }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (path, { database = "E_Shopping", admin, method = "GET", body } = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, {
      method, headers: { "Content-Type": "application/json", "x-database-name": database,
        ...(admin === undefined ? {} : { Authorization: `Bearer ${jwt.sign({ userId, isAdmin: admin }, secret)}` }) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}
const path = "/settings/service-availability";
test("public uncached defaults, partial independent regional updates and current-admin authorization", async (t) => {
  const state = fixture(), request = await serve(t, state);
  const initial = await request(path);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  assert.deepEqual(await initial.json(), { rides: true, services: true });
  assert.equal((await request(path, { method: "PUT", body: { rides: false } })).status, 401);
  state.revokeAdmin();
  assert.equal((await request(path, { method: "PUT", admin: true, body: { rides: false } })).status, 403);
  assert.equal(state.regions.size, 0);
  const active = fixture(), save = await serve(t, active);
  await Promise.all(["rides", "services"].map((key) => save(path, {
    method: "PUT", database: "E_ShopUSA", admin: true, body: { [key]: false },
  })));
  assert.deepEqual(await (await save(path, { database: "E_ShopUSA" })).json(), { rides: false, services: false });
  assert.deepEqual(await (await save(path)).json(), { rides: true, services: true });
  assert.equal(active.regions.get("E_ShopUSA").updatedBy, userId);
  await save(path, { method: "PUT", database: "E_ShopUSA", admin: true, body: { rides: true } });
  assert.deepEqual(await (await save(path, { database: "E_ShopUSA" })).json(), { rides: true, services: false });
});
test("malformed switches never write; storage failures never report enabled or saved", async (t) => {
  const state = fixture(), request = await serve(t, state);
  for (const body of [{}, [], { rides: "false" }, { services: 0 }, { enabled: true }, { rides: true, unknown: false }]) {
    assert.equal((await request(path, { method: "PUT", admin: true, body })).status, 400);
  }
  assert.equal(state.regions.size, 0);
  state.regions.set("E_Shopping", { serviceAvailability: { rides: "false" } });
  await assert.rejects(readServiceAvailability(state.models("E_Shopping")), /Invalid/);
  await assert.rejects(requireServiceAvailable(state.models("E_Shopping"), "rides"), { status: 503 });
  state.outage();
  assert.equal((await request(path)).status, 503);
  assert.equal((await request(path, { method: "PUT", admin: true, body: { services: false } })).status, 503);
  assert.equal((await request("/service-requests", { method: "POST", admin: false, body: {} })).status, 503);
  assert.equal(state.requests.size, 0);
});
test("service OFF blocks new requests regardless of payload country, not existing history or updates", async (t) => {
  const state = fixture(), request = await serve(t, state);
  const body = { country: "Ethiopia", serviceLocation: "On-site", machineType: "Machine",
    problemDescription: "Needs repair", contactPhone: "12345678" };
  for (const database of ["E_Shopping", "E_ShopUSA"]) {
    assert.equal((await request("/service-requests", { method: "POST", database, admin: false, body })).status, 201);
    await request(path, { method: "PUT", database, admin: true, body: { services: false } });
    for (const country of ["USA", "Ethiopia"]) {
      const blocked = await request("/service-requests", { method: "POST", database, admin: false, body: { ...body, country } });
      assert.equal(blocked.status, 403);
      assert.match((await blocked.json()).message, /Existing requests remain accessible/);
    }
    const history = await request("/service-requests/mine", { database, admin: false });
    assert.equal(history.status, 200);
    assert.equal((await history.json()).length, 1);
    assert.equal((await request(`/service-requests/${requestId}`, {
      method: "PUT", database, admin: false, body: { serviceLocation: "Updated location" },
    })).status, 200);
    await request(path, { method: "PUT", database, admin: true, body: { services: true } });
    assert.equal((await request("/service-requests", { method: "POST", database, admin: false, body })).status, 201);
  }
});
test("availability switches are declared in the persisted schema without changing legacy defaults", () => {
  for (const key of ["rides", "services"]) {
    const field = siteSettingSchema.path(`serviceAvailability.${key}`);
    assert.equal(field.instance, "Boolean");
    assert.equal(field.defaultValue, undefined);
  }
});
