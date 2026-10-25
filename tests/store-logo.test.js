const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeStoreLogo } = require("../helpers/store-logo");
const { publicStore } = require("../helpers/store-inventory");
const stores = require("../routers/stores");
const inventory = require("../routers/store-inventory");
const owners = require("../routers/storeOwner");

const id = "000000000000000000000001";
const logo = "https://res.cloudinary.com/example/image/upload/store.png";
const route = (router, path, method) => router.stack.find((entry) => entry.route?.path === path &&
  entry.route.methods[method]).route.stack.at(-1).handle;
const response = () => ({ code: 200, status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; } });

test("optional logos are normalized, removable and HTTPS-only", () => {
  assert.equal(normalizeStoreLogo(undefined), undefined);
  assert.equal(normalizeStoreLogo("   "), "");
  assert.equal(normalizeStoreLogo(` ${logo} `), logo);
  for (const value of [null, {}, 1, "http://example.test/logo.png", "file:///logo.png",
    "data:image/png;base64,abc", "https://", "https://user:password@example.test/logo.png",
    "https://example.test/logo file.png", `https://example.test/${"a".repeat(500)}`]) {
    assert.throws(() => normalizeStoreLogo(value), (error) => error.status === 400);
  }
});

test("company-store creation persists optional logos, including older clients omitting them", async () => {
  for (const supplied of [undefined, logo, ""]) {
    const res = response();
    const user = { _id: id, save: async () => {} };
    class Store {
      constructor(fields) { Object.assign(this, fields); this._id = id; }
      async save() { return this; }
    }
    await route(stores, "/admin/company-stores", "post")({
      body: { name: "Bole Market", address: "Bole", email: "store@example.test", phone: "123",
        password: "password", latitude: 9, longitude: 38, ...(supplied === undefined ? {} : { logo: supplied }) },
      auth: { userId: id, isAdmin: true }, dbModels: { Store, User: { findOne: async () => user } },
    }, res);
    assert.equal(res.code, 201);
    assert.equal(res.body.store.logo, supplied || "");
    assert.equal(publicStore(res.body.store).logo, supplied || "");
  }
});

test("company-store edits preserve, replace and remove logos without touching account credentials", async () => {
  for (const supplied of [undefined, "https://example.test/new.png", ""]) {
    const store = { _id: id, logo, owner: null, save: async function () { return this; } };
    const res = response();
    await route(stores, "/admin/company-stores/:id", "put")({
      params: { id }, body: supplied === undefined ? { name: "New name" } : { logo: supplied },
      dbModels: { Store: { findOne: async () => store } },
    }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.store.logo, supplied === undefined ? logo : supplied);
  }
  const res = response();
  await route(stores, "/admin/company-stores", "post")({ body: { logo: "javascript:alert(1)" } }, res);
  assert.equal(res.code, 400);
  assert.match(res.body.message, /HTTPS/);
});

test("generic store create/edit endpoints round-trip logos and reject invalid values", async () => {
  class Store {
    constructor(fields) { Object.assign(this, fields); }
    async save() { return this; }
  }
  let res = response();
  await route(stores, "/", "post")({ body: { name: "Bole Market", address: "Bole", logo }, dbModels: { Store } }, res);
  assert.equal(res.code, 201);
  assert.equal(res.body.logo, logo);
  for (const supplied of [undefined, "", "https://example.test/edited.png"]) {
    res = response();
    await route(stores, "/:id", "put")({
      params: { id }, body: supplied === undefined ? {} : { logo: supplied },
      dbModels: { Store: { findByIdAndUpdate: async (storeId, update) => {
        assert.equal(storeId, id); return { _id: id, logo, ...update };
      } } },
    }, res);
    assert.equal(res.body.logo, supplied === undefined ? logo : supplied);
  }
  res = response();
  await route(stores, "/:id", "put")({ body: { logo: "data:image/png;base64,abc" }, dbModels: {} }, res);
  assert.equal(res.code, 400);
});

test("owner profile and branch edits use the same optional logo contract and public directory field", async () => {
  const store = { _id: id, owner: id, name: "Root", address: "Bole", logo,
    set(fields) { Object.assign(this, fields); }, async save() {} };
  for (const supplied of [undefined, "https://example.test/owner.png", ""]) {
    const before = store.logo;
    const res = response();
    await route(inventory, "/me/locations/:id", "put")({
      auth: { userId: id }, params: { id }, body: supplied === undefined ? {} : { logo: supplied },
      dbModels: { Store: { findOne: async () => store } },
    }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.logo, supplied === undefined ? before : supplied);
  }
  const branch = response();
  await route(inventory, "/me/locations/:id/branches", "post")({
    auth: { userId: id }, params: { id }, body: { name: "Branch", address: "Bole", description: "", latitude: 9, longitude: 38 },
    dbModels: { Store: { findOne: async () => store, create: async (fields) => ({ _id: id, ...fields }) } },
  }, branch);
  assert.equal(branch.code, 201);
  assert.equal(branch.body.logo, "");
  const invalid = response();
  await route(inventory, "/me/locations/:id", "put")({
    auth: { userId: id }, params: { id }, body: { logo: "http://example.test/logo.png" },
    dbModels: { Store: { findOne: async () => store } },
  }, invalid);
  assert.equal(invalid.code, 400);
});

test("legacy owner profile APIs return and allow clearing the saved logo", async () => {
  const store = { id, name: "Market", logo, save: async () => {} };
  const dbModels = { Store: { findOne: async () => store } };
  const mine = response();
  await route(owners, "/mine/by-owner", "get")({ auth: { userId: id }, dbModels }, mine);
  assert.equal(mine.body.store.logo, logo);
  const update = response();
  await route(owners, "/mine/update", "put")({ auth: { userId: id }, dbModels, body: { logo: "" } }, update);
  assert.equal(update.body.store.logo, "");
  const invalid = response();
  await route(owners, "/mine/update", "put")({ body: { logo: "file:///local.png" } }, invalid);
  assert.equal(invalid.code, 400);
});

test("owner registration persists an optional logo before returning its normal sign-in response", async () => {
  const authSecurity = require("../helpers/auth-security");
  const originalLogin = authSecurity.login;
  let savedStore;
  class User {
    constructor(fields) { Object.assign(this, fields); this._id = id; this.id = id; }
    static async findOne() { return null; }
    async save() { return this; }
  }
  class Store {
    constructor(fields) { Object.assign(this, fields); this._id = id; this.id = id; }
    async save() { savedStore = this; return this; }
  }
  authSecurity.login = async (req, user, source, result) => result;
  try {
    for (const supplied of [undefined, logo]) {
      const res = response();
      await route(owners, "/register-owner", "post")({
        body: { fullName: "Owner", storeName: "Bole Market", email: "owner@example.test", password: "password",
          address: "Bole", latitude: 9, longitude: 38, ...(supplied === undefined ? {} : { logo: supplied }) },
        dbModels: { Store, User },
      }, res);
      assert.equal(res.code, 201);
      assert.equal(res.body.success, true);
      assert.equal(savedStore.logo, supplied || "");
    }
  } finally { authSecurity.login = originalLogin; }
});
