const test = require("node:test");
const assert = require("node:assert/strict");
const { decodePolyline, computeDrivingRoute } = require("../helpers/google-route");
const { createDriverRouteHandler } = require("../service/driverRoute");

test("decodes Google route polylines and rejects malformed input", () => {
  assert.deepEqual(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@"), [
    { latitude: 38.5, longitude: -120.2 },
    { latitude: 40.7, longitude: -120.95 },
    { latitude: 43.252, longitude: -126.453 },
  ]);
  assert.throws(() => decodePolyline("_"), /Invalid/);
});

test("Routes request keeps the key in headers and returns km, minutes and coordinates", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.GOOGLE_ROUTES_API_KEY;
  process.env.GOOGLE_ROUTES_API_KEY = "server-only-test";
  global.fetch = async (url, options) => {
    assert.equal(url, "https://routes.googleapis.com/directions/v2:computeRoutes");
    assert.equal(options.headers["X-Goog-Api-Key"], "server-only-test");
    assert.equal(JSON.parse(options.body).origin.location.latLng.longitude, -120.2);
    return { ok: true, json: async () => ({ routes: [{
      distanceMeters: 1200, duration: "180s",
      polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" },
    }] }) };
  };
  try {
    const result = await computeDrivingRoute([-120.2, 38.5], [-126.453, 43.252]);
    assert.equal(result.distance, 1.2);
    assert.equal(result.duration, 3);
    assert.equal(result.coordinates.length, 3);
    global.fetch = async () => ({
      ok: false, status: 403,
      json: async () => ({ error: { message: "Denied server-only-test" } }),
    });
    await assert.rejects(computeDrivingRoute([0, 0], [1, 1]), (error) =>
      error.message.includes("[redacted]") && !error.message.includes("server-only-test"));
    global.fetch = async () => ({ ok: true, json: async () => ({ routes: [] }) });
    await assert.rejects(computeDrivingRoute([0, 0], [1, 1]), (error) => error.status === 422);
    delete process.env.GOOGLE_ROUTES_API_KEY;
    await assert.rejects(computeDrivingRoute([0, 0], [1, 1]), (error) => error.status === 503);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GOOGLE_ROUTES_API_KEY;
    else process.env.GOOGLE_ROUTES_API_KEY = previousKey;
  }
});

function fixture({ suspended = false, assigned = true, status = "Driver Assigned", location = true } = {}) {
  const req = {
    auth: { userId: "user" }, dbName: "E_Shopping",
    params: { id: "507f1f77bcf86cd799439011" },
    body: { origin: { longitude: 38, latitude: 9 }, destination: { longitude: 99, latitude: 99 } },
    dbModels: {
      Driver: { findOne: async () => ({ _id: "driver", approvalStatus: "approved", isSuspended: suspended }) },
      Order: { findOne: (filter) => {
        assert.equal(filter.driver, "driver");
        assert.deepEqual(filter.deliveryStatus.$in, ["Driver Assigned", "Picked Up"]);
        return { populate: async () => assigned ? {
          deliveryStatus: status, store: { location: location ? { coordinates: [38.1, 9.1] } : null },
          customerLocation: { coordinates: [38.2, 9.2] },
        } : null };
      } },
    },
  };
  const res = {
    statusCode: 200, status(code) { this.statusCode = code; return this; },
    set() { return this; }, json(body) { this.body = body; return this; },
  };
  return { req, res };
}

test("route destination is server-selected for pickup and delivery; rapid requests are throttled", async () => {
  for (const status of ["Driver Assigned", "Picked Up"]) {
    const { req, res } = fixture({ status });
    const handler = createDriverRouteHandler({ compute: async (origin, destination) => {
      assert.deepEqual(origin, [38, 9]);
      assert.deepEqual(destination, status === "Picked Up" ? [38.2, 9.2] : [38.1, 9.1]);
      return { coordinates: [], distance: 1, duration: 2 };
    } });
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    await handler(req, res);
    assert.equal(res.statusCode, 429);
  }
});

test("unauthorized, suspended, unassigned and invalid-location requests never call Google", async () => {
  const scenarios = [
    [{}, (req) => { req.auth = null; }, 401],
    [{ suspended: true }, () => {}, 403],
    [{ assigned: false }, () => {}, 404],
    [{ location: false }, () => {}, 422],
    [{}, (req) => { req.body.origin = { latitude: 91, longitude: 0 }; }, 400],
  ];
  for (const [options, mutate, expected] of scenarios) {
    const { req, res } = fixture(options);
    mutate(req);
    await createDriverRouteHandler({ compute: async () => { assert.fail("Google must not be called"); } })(req, res);
    assert.equal(res.statusCode, expected);
  }
});
