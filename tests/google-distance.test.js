const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function loadDistance({ key = "test-server-key", fetch } = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../helpers/google-distance.js"), "utf8"), {
    module, process: { env: { GOOGLE_MAPS_API_KEY: key } },
    URL, AbortSignal, fetch, console: { error: () => {} },
  });
  return module.exports;
}

test("Distance Matrix requests driving mode and returns road kilometers", async () => {
  const helper = loadDistance({ fetch: async (url, options) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get("mode"), "driving");
    assert.equal(params.get("origins"), "41.9,-87.6");
    assert.ok(options.signal);
    return { ok: true, json: async () => ({
      status: "OK", rows: [{ elements: [{ status: "OK", distance: { value: 12345 } }] }],
    }) };
  } });
  assert.equal(await helper.getDrivingDistanceKm("41.9,-87.6", "Chicago", { throwOnError: true }), 12.35);
});

test("strict distance lookup reports missing configuration and denied/no-route responses", async () => {
  await assert.rejects(loadDistance({ key: "" }).getDrivingDistanceKm("A", "B", {
    throwOnError: true,
  }), /GOOGLE_MAPS_API_KEY.*Distance Matrix API/);
  for (const data of [
    { status: "REQUEST_DENIED" },
    { status: "OK", rows: [{ elements: [{ status: "ZERO_RESULTS" }] }] },
    { status: "OK", rows: [{ elements: [{ status: "OK", distance: { value: -1 } }] }] },
  ]) {
    const helper = loadDistance({ fetch: async () => ({ ok: true, json: async () => data }) });
    await assert.rejects(helper.getDrivingDistanceKm("A", "B", { throwOnError: true }),
      /REQUEST_DENIED|ZERO_RESULTS|invalid driving distance/);
    assert.equal(await helper.getDrivingDistanceKm("A", "B"), null);
  }
});

test("distance lookup redacts server key from network errors", async () => {
  const helper = loadDistance({ fetch: async () => {
    throw new Error("Network failed https://example.invalid?key=test-server-key");
  } });
  await assert.rejects(helper.getDrivingDistanceKm("A", "B", { throwOnError: true }), (error) =>
    !error.message.includes("test-server-key") && error.message.includes("[redacted]"));
});
