const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { getCoordinates, resolvePickupStore } = require("../helpers/fulfillment-routing");

function fixture({ configured = true, store, stores, hub = "", compute } = {}) {
  const routes = {};
  const router = {
    get: () => {}, put: () => {},
    post: (path, handler) => { routes[path] = handler; },
  };
  const dependencies = {
    express: { Router: () => router },
    mongoose: { isValidObjectId: () => true },
    "../helpers/delivery": {},
    "../helpers/google-distance": {
      isGoogleDistanceApiConfigured: () => configured,
      getDrivingDistanceKm: compute || (async () => 12.5),
    },
    "../helpers/fulfillment-routing": { getCoordinates, resolvePickupStore },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../routers/settings.js"), "utf8"), {
    module: { exports: {} }, require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency ${name}`);
      return dependencies[name];
    }, console: { error: () => {} },
  });
  const query = (value) => ({ select: () => ({ lean: async () => value }) });
  const req = {
    body: { destinationAddress: "500 South State, Chicago, 60603, United States", storeId: "test-store" },
    dbModels: {
      Store: { find: () => ({ lean: async () => (stores || (store ? [{
        _id: "test-store", isCompanyOwned: true, approvalStatus: "approved", ...store,
      }] : [])).filter((entry) => entry.approvalStatus === "approved" && entry.isOpen !== false) }) },
      SiteSetting: { findOne: () => query({ deliveryOrigin: { address: hub } }) },
    },
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { handler: routes["/delivery/estimate-distance"], req, res };
}

test("checkout distance uses valid store coordinates in latitude-longitude order", async () => {
  const { handler, req, res } = fixture({
    store: { address: "810 West Grace St", location: { coordinates: [-87.65, 41.95] } },
    compute: async (origin, destination, options) => {
      assert.equal(origin, "41.95,-87.65");
      assert.match(destination, /60603/);
      assert.equal(options.throwOnError, true);
      return 12.5;
    },
  });
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.distanceKm, 12.5);
});

test("default zero coordinates use full store address instead of Gulf of Guinea", async () => {
  const { handler, req, res } = fixture({
    store: { address: "810 West Grace St", city: "Chicago", country: "United States",
      location: { coordinates: [0, 0] } },
    compute: async (origin) => {
      assert.equal(origin, "810 West Grace St, Chicago, United States");
      return 10;
    },
  });
  await handler(req, res);
  assert.equal(res.body.distanceKm, 10);
});

test("distance resolves nearest AdminStore when checkout has no cached store or hub", async () => {
  const { handler, req, res } = fixture({
    stores: [
      { _id: "far", isCompanyOwned: true, approvalStatus: "approved", location: { coordinates: [-88, 42] } },
      { _id: "near", isCompanyOwned: true, approvalStatus: "approved", location: { coordinates: [-87.65, 41.95] } },
      { _id: "closed", isCompanyOwned: true, approvalStatus: "approved", isOpen: false, location: { coordinates: [-87.65, 41.95] } },
    ],
    compute: async (origin) => {
      assert.equal(origin, "41.95,-87.65");
      return 10;
    },
  });
  req.body.storeId = null;
  req.body.customerLocation = { latitude: 41.95, longitude: -87.65 };
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.distanceKm, 10);
});

test("distance retains nearby partner priority and ignores stale preferred store IDs", async () => {
  const { handler, req, res } = fixture({
    stores: [
      { _id: "partner", approvalStatus: "approved", location: { coordinates: [-87.66, 41.95] } },
      { _id: "company", isCompanyOwned: true, approvalStatus: "approved", location: { coordinates: [-87.65, 41.95] } },
    ],
    compute: async (origin) => {
      assert.equal(origin, "41.95,-87.66");
      return 10;
    },
  });
  req.body.customerLocation = { coordinates: [-87.65, 41.95] };
  await handler(req, res);
  assert.equal(res.statusCode, 200);
});

test("unconfigured origin, API and denied lookup produce explicit failures, not success with null", async () => {
  for (const [options, status, message] of [
    [{ configured: false }, 503, /GOOGLE_MAPS_API_KEY/],
    [{}, 422, /Register an approved, open AdminStore/],
    [{ hub: "Chicago", compute: async () => { throw new Error("Google lookup REQUEST_DENIED"); } },
      502, /REQUEST_DENIED/],
  ]) {
    const { handler, req, res } = fixture(options);
    await handler(req, res);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, message);
  }
});
