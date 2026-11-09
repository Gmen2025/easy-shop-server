function requireActiveAccount(req, res, next) {
  const userId = req.auth?.userId || req.auth?.sub;
  if (!userId) return next();

  return Promise.resolve(req.dbModels.User.exists({ _id: userId }))
    .then((exists) => {
      if (!exists) {
        return res.status(401).json({
          success: false,
          message: "Account no longer exists. Please sign in again.",
        });
      }
      return next();
    })
    .catch(next);
}

module.exports = requireActiveAccount;
