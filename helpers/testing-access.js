const jwt = require("jsonwebtoken");
const KEY = "testing-access";

function validateEmails(emails) {
  if (!Array.isArray(emails) || emails.some((email) => typeof email !== "string" ||
      email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))) {
    throw Object.assign(new Error("Provide a list of valid tester email addresses."), { status: 400 });
  }
  return [...new Set(emails.map((email) => email.trim().toLowerCase()))];
}

async function readTestingEmails(models, session) {
  let query = models.SiteSetting.findOne({ key: KEY });
  if (session) query = query.session(session);
  return validateEmails((await query.lean())?.testingEmails || []);
}

async function updateTestingEmails(models, emails, userId) {
  const normalized = validateEmails(emails);
  await models.SiteSetting.findOneAndUpdate({ key: KEY },
    { $set: { testingEmails: normalized, updatedBy: userId } },
    { upsert: true, new: true, runValidators: true });
  return normalized;
}

function requestUserId(req) {
  if (req.auth) return req.auth.userId || req.auth.sub;
  const authorization = req.get("Authorization");
  if (!authorization) return null;
  const token = /^Bearer (\S+)$/i.exec(authorization)?.[1];
  if (!token) throw Object.assign(new Error("Invalid sign-in token."), { status: 401 });
  if (!process.env.secret) throw new Error("JWT verification is not configured.");
  try {
    const claims = jwt.verify(token, process.env.secret, { algorithms: ["HS256"] });
    if (!claims || typeof claims !== "object" || !(claims.userId || claims.sub)) {
      throw Object.assign(new Error("Invalid sign-in token."), { status: 401 });
    }
    return claims.userId || claims.sub;
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.NotBeforeError) {
      throw Object.assign(new Error("Your sign-in token is invalid or expired. Sign in again."), { status: 401 });
    }
    throw error;
  }
}

async function canTest(models, userId, session) {
  if (!userId) return false;
  let query = models.User.findOne({ _id: userId }).select("_id email isAdmin isEmailVerified");
  if (session) query = query.session(session);
  const user = await query.lean();
  if (!user) return false;
  if (user.isAdmin === true) return true;
  if (user.isEmailVerified !== true || typeof user.email !== "string") return false;
  return (await readTestingEmails(models, session)).includes(user.email.trim().toLowerCase());
}

module.exports = { KEY, validateEmails, readTestingEmails, updateTestingEmails, requestUserId, canTest };
