const { expressjwt: jwt } = require("express-jwt");

function authJwt() {
  const secret = process.env.secret;
  return jwt({
    secret,
    algorithms: ["HS256"],
  }).unless({
    path: [
      { url: /^\/api\/v1\/users\/auth\/social\/start$/, methods: ["GET"] },
      { url: /^\/api\/v1\/users\/auth\/social\/callback\/(?:google|apple|facebook)$/, methods: ["GET"] },
      { url: /^\/api\/v1\/users\/auth\/social\/callback\/apple$/, methods: ["POST"] },
      { url: /^\/api\/v1\/users\/auth\/(?:social\/exchange|2fa\/verify|2fa\/resend)$/, methods: ["POST"] },
      "/api/v1/users/login",
      "/api/v1/users/driver-login",
      "/api/v1/users/store-owner-login",
      "/api/v1/users/register",
      "/api/v1/stores/register-owner",
      "/api/v1/users/resend-verification",
      "/api/v1/users/forgot-password",
      "/api/v1/users/reset-password",
      "/api/v1/users/verify-reset-token",
      '/api/v1/users/test-reset',
      '/api-docs',  // Swagger documentation
      '/api-docs/swagger.json',  // Swagger spec
      { url: /\/api-docs\/.*/ },  // Swagger static files
      {
        url: /\/api\/v1\/users\/verify-email(.*)/,
        methods: ["GET", "OPTIONS"],
      }, // Allow query parameters
      {
        url: /\/api\/v1\/users\/reset-password(.*)/,
        methods: ["GET", "POST", "OPTIONS"],
      },
      { url: /\/public\/uploads(.*)/, methods: ["GET", "OPTIONS"] },
      {
        url: /^\/api\/v1\/products(?!\/(?:company|admin)(?:\/|$))(?:\/.*)?$/,
        methods: ["GET", "OPTIONS"],
      },
      { url: /\/api\/v1\/categories(.*)/, methods: ["GET", "OPTIONS"] },
      { url: /^\/api\/v1\/stores\/directory(?:\/[^/]+\/products)?$/, methods: ["GET", "OPTIONS"] },
      { url: /\/api\/v1\/telebirr(.*)/, methods: ["POST", "GET", "OPTIONS"] },
      { url: /\/api\/v1\/cloudinary\/sign$/, methods: ["POST", "OPTIONS"] },
      { url: /\/sign$/, methods: ["POST", "OPTIONS"] },
      { url: /\/api\/v1\/database(.*)/, methods: ["GET", "POST", "OPTIONS"] },
      { url: /\/api\/v1\/settings\/maintenance$/, methods: ["GET", "OPTIONS"] },
      { url: /\/api\/v1\/settings\/bank-account$/, methods: ["GET", "OPTIONS"] },
      { url: /\/api\/v1\/notifications\/health$/, methods: ["GET", "OPTIONS"] },
    ],
  });
}

module.exports = authJwt;
