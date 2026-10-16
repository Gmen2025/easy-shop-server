const test = require("node:test");
const assert = require("node:assert/strict");
const { autocompletePlaces, placeDetails } = require("../helpers/places");
const { addressInput } = require("../helpers/multi-delivery");

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
