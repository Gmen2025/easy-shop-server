const mongoose = require("mongoose");

function operatorScope(req, kind, selfScope) {
  if (!req.auth?.userId) throw Object.assign(new Error("Sign in required."), { status: 401 });
  if (!req.params?.accountId) return selfScope;
  if (!req.auth.isAdmin) throw Object.assign(new Error("Admin access required."), { status: 403 });
  if (!mongoose.isValidObjectId(req.params.accountId)) {
    throw Object.assign(new Error(`Invalid ${kind} ID.`), { status: 400 });
  }
  return { _id: req.params.accountId };
}

function operatorGet(router, selfPath, adminPath, handler) {
  router.get(selfPath, handler);
  router.get(adminPath, handler);
}

module.exports = { operatorScope, operatorGet };
