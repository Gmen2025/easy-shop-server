const router = require("express").Router();
const engine = require("../helpers/financial-management");
const { workspace } = require("../helpers/financial-management-report");

const handle = (action) => async (req, res) => {
  try { await action(req, res); }
  catch (error) {
    if (!error.status) console.error("Private accounting request failed:", error.message);
    const unavailable = /Transaction numbers|replica set|mongos|does not support transactions/i.test(error.message || "");
    res.status(error.status || (unavailable ? 503 : 500)).json({
      error: { code: error.code && error.status ? error.code : unavailable ? "TRANSACTIONS_REQUIRED" : "INTERNAL_ERROR",
        message: error.status ? error.message : unavailable ? "Accounting requires a MongoDB replica set with transactions enabled." : "Unable to complete accounting request." },
    });
  }
};
router.use((req, res, next) => {
  if (!req.auth?.userId) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in required." } });
  return handle(async () => {
    const userId = engine.identifier(req.auth.userId, "authenticated user");
    const user = await req.dbModels.User.findOne({ _id: userId, isAdmin: true }).select("_id").lean();
    engine.check(user, "Administrator access required.", "FORBIDDEN", 403);
    req.financialOwnerId = userId;
    next();
  })(req, res);
});

async function load(Model, owner, session) {
  let query = Model.findOne({ _id: owner, owner });
  if (session) query = query.session(session);
  const current = await query.lean();
  return current || { owner, revision: 0, state: engine.createState(), isNew: true };
}
function retriable(error) {
  return error.code === 11000 || error.code === "WRITE_CONFLICT" || error.code === 112 || error.hasErrorLabel?.("TransientTransactionError");
}
async function mutate(Model, owner, operation, body, resourceId, requestKey) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const session = await Model.db.startSession();
    try {
      let output;
      await session.withTransaction(async () => {
        const document = await load(Model, owner, session);
        const mutation = engine.execute(document.state, operation, body, resourceId, requestKey);
        output = mutation.result;
        if (mutation.replayed) return;
        if (document.isNew) {
          await Model.create([{ _id: owner, owner, revision: 1, state: mutation.state }], { session });
        } else {
          const update = await Model.updateOne({ _id: document._id, owner, revision: document.revision },
            { $set: { state: mutation.state }, $inc: { revision: 1 } }, { session });
          engine.check(update.modifiedCount === 1, "Workspace changed; retry your request.", "WRITE_CONFLICT", 409);
        }
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      return output;
    } catch (error) {
      if (!retriable(error) || attempt === 4) throw error;
    } finally { await session.endSession(); }
  }
}
async function initialized(Model, owner) {
  // Read initialization is also a transaction so concurrent first visits cannot
  // create multiple PERSONAL ledgers or return IDs that were not persisted.
  for (let attempt = 0; attempt < 5; attempt++) {
    const session = await Model.db.startSession();
    try {
      let state;
      await session.withTransaction(async () => {
        const document = await load(Model, owner, session);
        state = document.state;
        if (document.isNew) await Model.create([{ _id: owner, owner, revision: 0, state }], { session });
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      return state;
    } catch (error) {
      if (!retriable(error) || attempt === 4) throw error;
    } finally { await session.endSession(); }
  }
}
router.get("/workspace", handle(async (req, res) => {
  const state = await initialized(req.dbModels.FinancialWorkspace, req.financialOwnerId);
  res.set("Cache-Control", "private, no-store");
  res.json(workspace(state, req.query));
}));
const routes = [
  ["post", "/entities", "entity"], ["post", "/accounts", "account"],
  ["put", "/accounts/:id", "account-update"], ["post", "/categories", "category"],
  ["post", "/accounts/:id/adjustments", "adjustment"],
  ["post", "/transactions", "transaction"], ["post", "/transactions/:id/payments", "payment"],
  ["post", "/transactions/:id/reverse", "reverse"], ["post", "/transfers", "transfer"],
  ["post", "/goals", "goal"], ["put", "/goals/:id", "goal-update"], ["put", "/settings", "settings"],
];
for (const [method, path, operation] of routes) {
  router[method](path, handle(async (req, res) => {
    if (req.params.id) engine.identifier(req.params.id);
    const result = await mutate(req.dbModels.FinancialWorkspace, req.financialOwnerId, operation, req.body, req.params.id, req.body?.requestKey || req.get("Idempotency-Key"));
    res.set("Cache-Control", "private, no-store");
    res.status(method === "post" && !result.replayed ? 201 : 200).json(result);
  }));
}
module.exports = router;
module.exports.mutate = mutate;
module.exports.initialized = initialized;
