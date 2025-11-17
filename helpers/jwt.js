const { expressjwt: jwt } = require("express-jwt");

function authJwt() {
  const secret = process.env.secret;
  return jwt({
    secret,
    algorithms: ["HS256"],
  }).unless({
    path: [
      "/api/v1/users/login",
      "/api/v1/users/register",
      "/api/v1/users/resend-verification",
      "/api/v1/users/forgot-password",
      "/api/v1/users/reset-password",
      "/api/v1/users/verify-reset-token",
      '/api/v1/users/test-reset',  
      {
        url: /\/api\/v1\/users\/verify-email(.*)/,
        methods: ["GET", "OPTIONS"],
      }, // Allow query parameters
      {
        url: /\/api\/v1\/users\/reset-password(.*)/,
        methods: ["GET", "POST", "OPTIONS"],
      },
      { url: /\/public\/uploads(.*)/, methods: ["GET", "OPTIONS"] },
      { url: /\/api\/v1\/products(.*)/, methods: ["GET", "OPTIONS"] },
      { url: /\/api\/v1\/categories(.*)/, methods: ["GET", "OPTIONS"] },
      { url: /\/api\/v1\/telebirr(.*)/, methods: ["POST", "GET", "OPTIONS"] },
    ],
  });
}

module.exports = authJwt;
