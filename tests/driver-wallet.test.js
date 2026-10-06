const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(overrides = {}) {
  const messages = [];
  let saves = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../helpers/driver-wallet.js"), "utf8"), {
    module, process: { env: {} }, Date,
    require: (name) => {
      assert.equal(name, "./push-notify");
      return { sendPushToUser: async (message) => messages.push(message) };
    },
  });
  const driver = {
    user: "company-user", isCompanyOwned: true, walletBalance: -20,
    isSuspended: false, isAvailable: true,
    save: async () => { saves += 1; },
    ...overrides,
  };
  return { helper: module.exports, driver, messages, saves: () => saves };
}

test("AdminDrivers need no prepaid balance and receive no low-balance warning or suspension", async () => {
  for (const walletBalance of [-20, 0, 10]) {
    const { helper, driver, messages, saves } = fixture({ walletBalance });
    await helper.checkBalanceThresholds({ driver });
    assert.equal(driver.isSuspended, false);
    assert.equal(driver.isAvailable, true);
    assert.equal(messages.length, 0);
    assert.equal(saves(), 0);
  }
});

test("legacy AdminDriver low-balance suspension is restored without a deposit", async () => {
  const { helper, driver, messages } = fixture({
    isSuspended: true, autoSuspended: true, isAvailable: false,
    suspensionReason: "Wallet balance too low to cover platform commission.",
  });
  await helper.checkBalanceThresholds({ driver });
  assert.equal(driver.isSuspended, false);
  assert.equal(driver.autoSuspended, false);
  assert.equal(driver.isAvailable, true);
  assert.equal(driver.walletBalance, -20);
  assert.match(messages[0].body, /do not require a prepaid wallet/);
});

test("AdminDriver manual suspensions and other suspension reasons remain intact", async () => {
  for (const overrides of [
    { autoSuspended: false, suspensionReason: "Admin suspension" },
    { autoSuspended: true, suspensionReason: "Other reason" },
  ]) {
    const { helper, driver, saves } = fixture({
      isSuspended: true, isAvailable: false, ...overrides,
    });
    await helper.checkBalanceThresholds({ driver });
    assert.equal(driver.isSuspended, true);
    assert.equal(driver.isAvailable, false);
    assert.equal(saves(), 0);
  }
});

test("partner drivers retain low-balance suspension and top-up reinstatement", async () => {
  const { helper, driver, messages } = fixture({ isCompanyOwned: false });
  await helper.checkBalanceThresholds({ driver });
  assert.equal(driver.isSuspended, true);
  assert.equal(driver.autoSuspended, true);
  assert.equal(driver.isAvailable, false);
  assert.equal(messages.length, 1);
  driver.walletBalance = 100;
  await helper.reinstateDriverIfEligible({ driver });
  assert.equal(driver.isSuspended, false);
  assert.equal(driver.isAvailable, true);
});

test("dispatch recovery only clears approved company drivers' automatic low-balance suspensions", async () => {
  const { helper } = fixture();
  let calls = 0;
  await helper.restoreCompanyDriversSuspendedForBalance({
    updateMany: async (filter, update) => {
      calls += 1;
      assert.equal(filter.isCompanyOwned, true);
      assert.equal(filter.approvalStatus, "approved");
      assert.equal(filter.isSuspended, true);
      assert.equal(filter.autoSuspended, true);
      assert.equal(filter.suspensionReason, "Wallet balance too low to cover platform commission.");
      assert.equal(update.$set.isSuspended, false);
      assert.equal(update.$set.isAvailable, true);
      assert.equal(update.$set.availabilityStatus, true);
      assert.equal(update.$set.walletBalance, undefined);
    },
  });
  assert.equal(calls, 1);
});
