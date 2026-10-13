const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { getDbConnection } = require("../helpers/db-manager");

test("useDb child connections start sessions through the live base connection", async (t) => {
  const conn = getDbConnection("E_ShopUSA");
  assert.notEqual(conn, mongoose.connection);
  // Simulate the stale child state that previously caused buffering timeouts.
  conn._readyState = mongoose.ConnectionStates.disconnected;

  const fakeSession = { id: "shared-client-session" };
  const original = mongoose.connection.startSession;
  let calls = 0;
  mongoose.connection.startSession = async () => {
    calls += 1;
    return fakeSession;
  };
  t.after(() => {
    mongoose.connection.startSession = original;
  });

  assert.equal(await conn.startSession(), fakeSession);
  assert.equal(getDbConnection("E_ShopUSA"), conn);
  assert.equal(await getDbConnection("E_ShopUSA").startSession(), fakeSession);
  assert.equal(calls, 2);
});
