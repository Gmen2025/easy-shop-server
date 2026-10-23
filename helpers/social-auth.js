const crypto = require("crypto");
const { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8 } = require("jose");
const auth = require("./auth-security");
const { getModelsForDb, DEFAULT_DB_NAME } = require("./db-manager");

const jwks = {
  google: createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")),
  apple: createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys")),
};
const providers = ["google", "apple", "facebook"];
const pkce = (verifier) => crypto.createHash("sha256").update(verifier).digest("base64url");
function validPkce(verifier, challenge) {
  return typeof verifier === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) &&
    auth.same(pkce(verifier), challenge);
}

function config(provider) {
  if (!providers.includes(provider)) throw auth.fail("Unsupported provider");
  const prefix = provider.toUpperCase();
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  const base = (process.env.OAUTH_CALLBACK_BASE_URL || "").replace(/\/$/, "");
  if (!clientId || !base || !base.startsWith("https://") ||
      (provider !== "apple" && !clientSecret) ||
      (provider === "apple" && (!process.env.APPLE_TEAM_ID || !process.env.APPLE_KEY_ID || !process.env.APPLE_PRIVATE_KEY))) {
    throw auth.fail(`${provider} sign-in is not configured`, 503, "provider_unavailable");
  }
  return { clientId, clientSecret, callback: `${base}/users/auth/social/callback/${provider}` };
}

function allowRedirect(uri) {
  const allowed = (process.env.OAUTH_APP_REDIRECT_URIS || "addugeneteshop://auth").split(",").map((s) => s.trim());
  if (typeof uri !== "string" || !allowed.includes(uri)) throw auth.fail("Redirect URI is not allowed");
  const parsed = new URL(uri);
  if (parsed.search || parsed.hash || parsed.username || parsed.password) throw auth.fail("Redirect URI must not contain a query or fragment");
  return uri;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok || result.error) throw auth.fail("Provider authentication failed", 400, "provider_error");
  return result;
}

async function start(req) {
  const provider = req.query.provider;
  const cfg = config(provider);
  const redirectUri = allowRedirect(req.query.redirectUri);
  const codeChallenge = req.query.codeChallenge;
  if (typeof codeChallenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw auth.fail("S256 codeChallenge is required");
  await auth.rateLimit(req, `oauth:${req.ip}`, 30);
  const central = { dbModels: getModelsForDb(DEFAULT_DB_NAME) };
  const verifier = auth.opaque() + auth.opaque();
  const nonce = auth.opaque();
  const { id } = await auth.createRecord(central, "oauth-state", null, {
    dbName: req.dbName, provider, redirectUri, codeChallenge, nonce, verifier,
  }, 10 * 60 * 1000);
  const endpoint = provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth"
    : provider === "apple" ? "https://appleid.apple.com/auth/authorize"
      : `https://www.facebook.com/${process.env.FACEBOOK_GRAPH_VERSION || "v22.0"}/dialog/oauth`;
  const url = new URL(endpoint);
  const params = {
    client_id: cfg.clientId, redirect_uri: cfg.callback, response_type: "code", state: id,
    scope: provider === "google" ? "openid email profile" : provider === "apple" ? "name email" : "email,public_profile",
  };
  if (provider !== "facebook") params.nonce = nonce;
  if (provider === "apple") params.response_mode = "form_post";
  if (provider === "google") {
    params.code_challenge = pkce(verifier);
    params.code_challenge_method = "S256";
  }
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

async function appleSecret(clientId) {
  const key = await importPKCS8(process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"), "ES256");
  return new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: process.env.APPLE_KEY_ID })
    .setIssuer(process.env.APPLE_TEAM_ID).setSubject(clientId).setAudience("https://appleid.apple.com")
    .setIssuedAt().setExpirationTime("5m").sign(key);
}

async function providerIdentity(provider, code, payload) {
  const cfg = config(provider);
  if (typeof code !== "string" || code.length > 4096) throw auth.fail("Missing authorization code");
  if (provider === "facebook") {
    const root = `https://graph.facebook.com/${process.env.FACEBOOK_GRAPH_VERSION || "v22.0"}`;
    const token = await requestJson(`${root}/oauth/access_token?${new URLSearchParams({
      client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.callback, code,
    })}`);
    const debug = await requestJson(`${root}/debug_token?${new URLSearchParams({
      input_token: token.access_token, access_token: `${cfg.clientId}|${cfg.clientSecret}`,
    })}`);
    const data = debug.data;
    if (!data?.is_valid || data.type !== "USER" || String(data.app_id) !== cfg.clientId || !data.user_id ||
        !data.expires_at || data.expires_at * 1000 <= Date.now() ||
        (data.data_access_expires_at && data.data_access_expires_at * 1000 <= Date.now())) {
      throw auth.fail("Invalid Facebook token");
    }
    const proof = crypto.createHmac("sha256", cfg.clientSecret).update(token.access_token).digest("hex");
    const profile = await requestJson(`${root}/me?${new URLSearchParams({
      fields: "id,name,email", access_token: token.access_token, appsecret_proof: proof,
    })}`);
    if (String(profile.id) !== String(data.user_id) || !profile.email) throw auth.fail("Provider email is required", 400, "email_required");
    return { subject: String(profile.id), email: profile.email.toLowerCase(), name: profile.name };
  }
  const tokenUrl = provider === "google" ? "https://oauth2.googleapis.com/token" : "https://appleid.apple.com/auth/token";
  const body = {
    grant_type: "authorization_code", code, redirect_uri: cfg.callback, client_id: cfg.clientId,
    client_secret: provider === "apple" ? await appleSecret(cfg.clientId) : cfg.clientSecret,
  };
  if (provider === "google") body.code_verifier = payload.verifier;
  const result = await requestJson(tokenUrl, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const { payload: identity } = await jwtVerify(result.id_token, jwks[provider], {
    algorithms: ["RS256"], audience: cfg.clientId,
    issuer: provider === "google" ? ["https://accounts.google.com", "accounts.google.com"] : "https://appleid.apple.com",
    requiredClaims: ["sub", "exp", "iat", "nonce", "email"],
  });
  if (!auth.same(identity.nonce, payload.nonce) || ![true, "true"].includes(identity.email_verified) ||
      (identity.azp && identity.azp !== cfg.clientId)) {
    throw auth.fail("Provider email is not verified");
  }
  return { subject: identity.sub, email: String(identity.email).trim().toLowerCase(), name: identity.name };
}

async function resolveIdentity(req, provider, identity) {
  const { AuthIdentity, User } = req.dbModels;
  const existing = await AuthIdentity.findOne({ provider, subject: identity.subject });
  if (existing) {
    const user = await User.findById(existing.userId);
    if (!user) throw auth.fail("Social account is unavailable", 400, "account_unavailable");
    return user;
  }
  // Even a provider-verified email is not permission to link an existing account.
  const conflict = await User.findOne({ email: identity.email }).collation({ locale: "en", strength: 2 });
  if (conflict) throw auth.fail("An account with this email already exists. Sign in using its original method.", 409, "account_conflict");
  let user;
  try {
    user = await User.create({
      name: String(identity.name || identity.email.split("@")[0]).slice(0, 100),
      email: identity.email, socialAccount: true, isEmailVerified: true,
    });
    await AuthIdentity.create({ provider, subject: identity.subject, userId: user._id });
    return user;
  } catch (error) {
    if (user) await User.deleteOne({ _id: user._id });
    if (error.code === 11000) throw auth.fail("Account already exists; sign in again using the original method.", 409, "account_conflict");
    throw error;
  }
}

async function callback(req, res) {
  const values = req.method === "POST" ? req.body : req.query;
  let payload;
  try {
    const central = { dbModels: getModelsForDb(DEFAULT_DB_NAME) };
    const record = await auth.attempt(central, values.state, "oauth-state");
    payload = record.payload;
    await auth.consume(central, record);
    if (payload.provider !== req.params.provider || values.error) throw auth.fail("Provider authorization was cancelled");
    req.dbName = payload.dbName;
    req.dbModels = getModelsForDb(payload.dbName);
    const identity = await providerIdentity(payload.provider, values.code, payload);
    const user = await resolveIdentity(req, payload.provider, identity);
    const { id } = await auth.createRecord(req, "oauth-handoff", user._id, {
      codeChallenge: payload.codeChallenge,
    }, 60 * 1000);
    const redirect = new URL(payload.redirectUri);
    redirect.searchParams.set("code", id);
    return res.redirect(303, redirect.toString());
  } catch (error) {
    if (!payload) return res.status(400).json({ message: "Invalid or expired OAuth state", code: "invalid_state" });
    const redirect = new URL(payload.redirectUri);
    redirect.searchParams.set("error", error.code === "account_conflict" ? "account_conflict" :
      error.code === "email_required" ? "email_required" : "social_auth_failed");
    return res.redirect(303, redirect.toString());
  }
}

async function exchange(req) {
  await auth.rateLimit(req, `exchange:${req.ip}`, 60);
  const record = await auth.attempt(req, req.body.code, "oauth-handoff");
  if (!validPkce(req.body.codeVerifier, record.payload.codeChallenge)) throw auth.fail("Invalid PKCE verifier");
  await auth.consume(req, record);
  const user = await req.dbModels.User.findById(record.userId);
  if (!user) throw auth.fail("Account is unavailable");
  return auth.login(req, user);
}

module.exports = { start, callback, exchange, pkce, validPkce, config, allowRedirect, providerIdentity, resolveIdentity };
