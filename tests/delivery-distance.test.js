const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { getCoordinates } = require("../helpers/fulfillment-routing");

function fixture({ configured = true, store, hub = "", compute } = {}) {
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
    "../helpers/fulfillment-routing": { getCoordinates },
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
      Store: { findById: () => query(store) },
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

test("unconfigured origin, API and denied lookup produce explicit failures, not success with null", async () => {
  for (const [options, status, message] of [
    [{ configured: false }, 503, /GOOGLE_MAPS_API_KEY/],
    [{}, 422, /origin address/],
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
