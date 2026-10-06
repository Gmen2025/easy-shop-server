const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture({ offered = {}, stalledPush = false } = {}) {
  const module = { exports: {} };
  let notifications = 0;
  const source = fs.readFileSync(path.join(__dirname, "../service/dispatchService.js"), "utf8");
  vm.runInNewContext(source, {
    module, exports: module.exports, Date, Map, Set, console, process: { env: {} },
    require: (name) => {
      if (name === "../helpers/push-notify") return {
        sendPushToUser: async () => {
          notifications += 1;
          if (stalledPush) return new Promise(() => {});
        },
      };
      return {};
    },
  });
  return {
    offer: module.exports.offerCompanyDelivery,
    options: {
      Order: { findOneAndUpdate: async (filter, update) => {
        assert.equal(filter.driver, null);
        assert.equal(filter.deliveryStatus, "Pending");
        assert.equal(update.companyOfferDriver, "driver");
        assert.equal(filter.companyDriverResponses.$not.$elemMatch.status, "rejected");
        assert.equal(filter.$and[0].$or[0].companyOfferDriver, null);
        return offered;
      } },
      User: {}, order: { _id: "order", companyOfferDriver: null },
      candidate: { _id: "driver", user: "user" },
    },
    notifications: () => notifications,
  };
}

test("persisted company offer returns promptly even when push notification never completes", async () => {
  const f = fixture({ stalledPush: true });
  let timer;
  try {
    const result = await Promise.race([
      f.offer(f.options),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Offer blocked on notification")), 200);
      }),
    ]);
    assert.equal(result.success, true);
    assert.equal(result.offered, true);
    assert.equal(result.driverId, "driver");
    assert.equal(f.notifications(), 1);
  } finally {
    clearTimeout(timer);
  }
});

test("concurrent claims prevent offers and unchanged offers do not repeatedly notify", async () => {
  const f = fixture({ offered: null });
  const result = await f.offer(f.options);
  assert.equal(result.success, false);
  assert.equal(f.notifications(), 0);
  f.options.order.companyOfferDriver = "driver";
  assert.equal((await f.offer(f.options)).success, true);
  assert.equal(f.notifications(), 0);
});
