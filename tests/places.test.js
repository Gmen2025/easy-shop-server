const test = require("node:test");
const assert = require("node:assert/strict");
const { autocompletePlaces, placeDetails, currentLocationAddress } = require("../helpers/places");
const { addressInput, geocodeAddress } = require("../helpers/multi-delivery");

const reply = (body, status = 200) => async (url, init) => {
  reply.calls.push({ url: String(url), init });
  return { ok: status < 400, status, json: async () => body };
};
reply.calls = [];
const PLACE = "ChIJabcdefghijklmnop";

test("place search is region-restricted, server-keyed and returns compact suggestions", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "server-key";
  t.after(() => { delete process.env.GOOGLE_MAPS_API_KEY; });
  reply.calls = [];
  assert.deepEqual(await autocompletePlaces("Bo", "ET", "session-123", { fetcher: reply({}) }), []);
  assert.equal(reply.calls.length, 0, "short input does not call Google");
  const suggestions = await autocompletePlaces("Bole Medhanialem", "ET", "session-123", { fetcher: reply({ suggestions: [
    { placePrediction: { placeId: PLACE, text: { text: "Bole Medhanialem, Addis Ababa, Ethiopia" },
      structuredFormat: { mainText: { text: "Bole Medhanialem" }, secondaryText: { text: "Addis Ababa, Ethiopia" } } } },
    { queryPrediction: { text: { text: "ignored" } } },
  ] }) });
  assert.deepEqual(suggestions, [{ placeId: PLACE, text: "Bole Medhanialem, Addis Ababa, Ethiopia",
    mainText: "Bole Medhanialem", secondaryText: "Addis Ababa, Ethiopia" }]);
  const sent = JSON.parse(reply.calls[0].init.body);
  assert.deepEqual(sent.includedRegionCodes, ["et"]);
  assert.equal(sent.sessionToken, "session-123");
  assert.equal(reply.calls[0].init.headers["X-Goog-Api-Key"], "server-key");
  await assert.rejects(autocompletePlaces("Bole road", "ET", "", { fetcher: reply({ error: { message: "denied server-key" } }, 403) }),
    /Places API \(New\)/);
});

test("place details fill an Ethiopian address without ZIP and reject other countries or invalid IDs", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "server-key";
  t.after(() => { delete process.env.GOOGLE_MAPS_API_KEY; });
  const details = (country, extra = []) => reply({ id: PLACE, displayName: { text: "Edna Mall" },
    formattedAddress: "Edna Mall, Addis Ababa, Ethiopia", location: { latitude: 8.996, longitude: 38.787 },
    addressComponents: [{ longText: "Addis Ababa", types: ["locality"] }, { longText: country, shortText: country, types: ["country"] }, ...extra] });
  const address = await placeDetails(PLACE, "ET", "session-123", { fetcher: details("ET") });
  assert.deepEqual(address, { placeId: PLACE, address1: "Edna Mall", city: "Addis Ababa", zip: "", country: "Ethiopia",
    formattedAddress: "Edna Mall, Addis Ababa, Ethiopia", location: { type: "Point", coordinates: [38.787, 8.996] } });
  const us = await placeDetails(PLACE, "US", "", { fetcher: details("US", [
    { longText: "1600", types: ["street_number"] }, { longText: "Amphitheatre Pkwy", types: ["route"] },
    { longText: "94043", types: ["postal_code"] }]) });
  assert.equal(us.address1, "Edna Mall, 1600 Amphitheatre Pkwy");
  assert.equal(us.zip, "94043");
  assert.equal(us.country, "USA");
  await assert.rejects(placeDetails(PLACE, "ET", "", { fetcher: details("KE") }), /outside the selected shopping region/);
  await assert.rejects(placeDetails("../secrets", "ET", "", { fetcher: details("ET") }), /Invalid place/);
});

test("place details do not repeat a street address used as the display name", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "server-key";
  t.after(() => { delete process.env.GOOGLE_MAPS_API_KEY; });
  for (const name of ["123 MAIN ST", "123 Main St.", "123 Main Street", " 123  Main St "]) {
    const result = await placeDetails(PLACE, "US", "", { fetcher: reply({
      id: PLACE, displayName: { text: name },
      formattedAddress: "123 Main St, Springfield, USA",
      location: { latitude: 40, longitude: -75 },
      addressComponents: [
        { longText: "123", types: ["street_number"] },
        { longText: "Main St", types: ["route"] },
        { longText: "Springfield", types: ["locality"] },
        { shortText: "US", types: ["country"] },
      ],
    }) });
    assert.equal(result.address1, "123 Main St", name);
    assert.equal(result.formattedAddress, "123 Main St, Springfield, USA");
    assert.deepEqual(result.location, { type: "Point", coordinates: [-75, 40] });
  }
});

test("place details deduplicate directional abbreviations including the reported Grace Street address", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "server-key";
  t.after(() => { delete process.env.GOOGLE_MAPS_API_KEY; });
  for (const [short, full] of [
    ["W", "West"], ["E", "East"], ["N", "North"], ["S", "South"],
    ["NE", "Northeast"], ["NW", "Northwest"], ["SE", "Southeast"], ["SW", "Southwest"],
  ]) {
    for (const [name, route] of [
      [`810 ${short} Grace St`, `${full} Grace Street`],
      [`810 ${full} Grace Street`, `${short} Grace St`],
    ]) {
      const result = await placeDetails(PLACE, "US", "", { fetcher: reply({
        id: PLACE, displayName: { text: name },
        location: { latitude: 40, longitude: -75 },
        addressComponents: [
          { longText: "810", types: ["street_number"] },
          { longText: route, types: ["route"] },
          { shortText: "US", types: ["country"] },
        ],
      }) });
      assert.equal(result.address1, `810 ${route}`, name);
    }
  }
});

test("ZIP is optional only for Ethiopian addresses", () => {
  const base = { label: "Home", address1: "Bole", address2: "", city: "Addis Ababa", phone: "0911000000" };
  assert.equal(addressInput({ ...base, country: "Ethiopia" }).zip, "");
  assert.equal(addressInput({ ...base, zip: "", country: "ET" }).zip, "");
  assert.throws(() => addressInput({ ...base, zip: "", country: "USA" }), /zip/);
});

test("saved delivery addresses retain selected place IDs and clear them after manual edits", async () => {
  const mongoose = require("mongoose");
  const { deliveryAddressSchema } = require("../models/delivery-address");
  const DeliveryAddress = mongoose.models.PlaceSelectionAddress || mongoose.model("PlaceSelectionAddress", deliveryAddressSchema);
  const router = require("../routers/multi-delivery");
  const handler = (method, path) => router.stack.find((entry) =>
    entry.route?.path === path && entry.route.methods[method]).route.stack[0].handle;
  const address = { label: "Family", address1: "Edna Mall", address2: "", city: "Addis Ababa",
    country: "Ethiopia", phone: "0911000000", placeId: PLACE,
    location: { type: "Point", coordinates: [-77, 38] } };
  let saved;
  const dbModels = { DeliveryAddress: {
    create: async (fields) => { saved = new DeliveryAddress(fields); return saved.toObject(); },
    findOneAndUpdate: async (filter, fields) => { saved.set(fields); return saved.toObject(); },
  } };
  const res = { status() { return this; }, json(body) { this.body = body; } };
  const auth = { userId: "000000000000000000000099" };
  await handler("post", "/delivery-addresses")({ auth, dbModels, body: address }, res);
  assert.equal(res.body.placeId, PLACE);
  assert.equal(res.body.zip, "");
  assert.equal(res.body.location, undefined, "Client coordinates must not be stored as verified");
  const { placeId, ...edited } = address;
  await handler("put", "/delivery-addresses/:id")({
    auth, dbModels, params: { id: String(saved._id) }, body: { ...edited, address1: "Another street" },
  }, res);
  assert.equal(res.body.placeId, "");
  assert.throws(() => addressInput({ ...address, placeId: {} }), /Invalid delivery place/);
});

test("delivery geocoding verifies selected places in the recipient country and reports country-specific manual failures", async (t) => {
  const previous = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "server-key";
  t.after(() => {
    if (previous === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = previous;
  });
  const address = { address1: "Edna Mall", city: "Addis Ababa", country: "Ethiopia", placeId: PLACE,
    location: { type: "Point", coordinates: [-77, 38] } };
  let actualCountry = "ET";
  const calls = [];
  t.mock.method(global, "fetch", async (url) => {
    calls.push(new URL(url));
    return { ok: true, json: async () => url.searchParams.get("place_id") === PLACE ? {
      status: "OK", results: [{ geometry: { location: { lng: 38.787, lat: 8.996 } },
        address_components: [{ short_name: actualCountry, types: ["country"] }] }],
    } : { status: "ZERO_RESULTS", results: [] } };
  });
  assert.deepEqual(await geocodeAddress(address), { type: "Point", coordinates: [38.787, 8.996] });
  assert.equal(calls[0].searchParams.has("address"), false);
  actualCountry = "US";
  await assert.rejects(geocodeAddress(address), /different country/);
  const { placeId, ...manual } = address;
  await assert.rejects(geocodeAddress(manual), (error) =>
    /Ethiopia.*could not be verified/.test(error.message) && /postal code is not required/.test(error.message) && !/USA/.test(error.message));
  assert.equal(calls.at(-1).searchParams.get("components"), "country:ET");
  await assert.rejects(geocodeAddress({ ...manual, country: "USA", zip: "12345" }), /USA.*ZIP code/);
  assert.equal(calls.at(-1).searchParams.get("components"), "country:US");
});

test("current pickup reverse lookup verifies the region and keeps the exact GPS point", async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = "server-key";
  t.after(() => { delete process.env.GOOGLE_MAPS_API_KEY; });
  const point = { latitude: 8.996, longitude: 38.787 };
  const body = { status: "OK", results: [{
    formatted_address: "Bole Road, Addis Ababa, Ethiopia",
    address_components: [
      { long_name: "Bole Road", types: ["route"] },
      { long_name: "Addis Ababa", types: ["locality"] },
      { short_name: "ET", types: ["country"] },
    ],
    geometry: { location: { lat: 9, lng: 38.8 } },
  }] };
  reply.calls = [];
  const address = await currentLocationAddress(point, "ET", { fetcher: reply(body) });
  assert.equal(new URL(reply.calls[0].url).searchParams.get("latlng"), "8.996,38.787");
  assert.equal(address.address1, "Bole Road");
  assert.equal(address.country, "Ethiopia");
  assert.equal(address.zip, "");
  assert.deepEqual(address.location, { type: "Point", coordinates: [38.787, 8.996] });
  assert.deepEqual(address.currentLocation, point);
  await assert.rejects(currentLocationAddress(point, "US", { fetcher: reply(body) }), /outside the selected shopping region/);
  for (const invalid of [{ latitude: 91, longitude: 38 }, { latitude: 0, longitude: 0 },
    { latitude: "9", longitude: 38 }, {}]) {
    await assert.rejects(currentLocationAddress(invalid, "ET"), /valid current GPS/);
  }
  await assert.rejects(currentLocationAddress(point, "ET", { fetcher: reply({ status: "ZERO_RESULTS" }) }), /No address/);
  await assert.rejects(currentLocationAddress(point, "ET", { fetcher: reply({ status: "REQUEST_DENIED" }) }), /permissions/);
});

test("delivery search routes use the recipient region and preserve ride defaults", async (t) => {
  const router = require("../routers/rides");
  const places = require("../helpers/places");
  const calls = [];
  t.mock.method(places, "autocompletePlaces", async (...args) => { calls.push(args); return []; });
  t.mock.method(places, "placeDetails", async (...args) => { calls.push(args); return { country: args[1] }; });
  const handler = (path) => router.stack.find((entry) => entry.route?.path === path && entry.route.methods.get).route.stack[0].handle;
  for (const [dbName, region, expected] of [
    ["E_SHOPUSA", "ET", "ET"], ["E_SHOP", "US", "US"],
    ["E_SHOPUSA", undefined, "US"], ["E_SHOP", undefined, "ET"],
  ]) {
    const req = { auth: { userId: "region-test" }, dbName, params: { placeId: PLACE },
      query: { input: "Bole", session: "session-123", ...(region ? { region } : {}) } };
    const res = { json(body) { this.body = body; }, status(code) { this.statusCode = code; return this; } };
    await handler("/places/autocomplete")(req, res);
    assert.deepEqual(calls.at(-1), ["Bole", expected, "session-123"]);
    await handler("/places/details/:placeId")(req, res);
    assert.deepEqual(calls.at(-1), [PLACE, expected, "session-123"]);
    assert.equal(res.body.country, expected);
  }
  const count = calls.length;
  for (const region of ["KE", ["ET", "US"], ""]) {
    const res = { json(body) { this.body = body; }, status(code) { this.statusCode = code; return this; } };
    await handler("/places/autocomplete")({
      auth: { userId: "region-test" }, dbName: "E_SHOPUSA", query: { input: "Bole", region },
    }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /US or ET/);
  }
  assert.equal(calls.length, count, "Invalid regions must not reach Google");
});

test("checkout identifies a browser-restricted server key without accepting client coordinates", async (t) => {
  const previous = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "server-key";
  t.after(() => {
    if (previous === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = previous;
  });
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  t.mock.method(global, "fetch", async () => ({ ok: true, json: async () => ({
    status: "REQUEST_DENIED", error_message: "API keys with referer restrictions cannot be used with this API. server-key",
  }) }));
  await assert.rejects(geocodeAddress({ country: "Ethiopia", address1: "Bole",
    location: { type: "Point", coordinates: [38.787, 8.996] } }), (error) => {
    assert.match(error.message, /GOOGLE_MAPS_API_KEY.*server key.*referrer restrictions/);
    assert.doesNotMatch(error.message, /server-key/);
    return true;
  });
  assert.match(logs[0], /REQUEST_DENIED/);
  assert.doesNotMatch(logs[0], /server-key/);
});
