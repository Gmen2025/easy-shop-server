const nodemailer = require("nodemailer");

function envValue(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function normalizePassword(rawPassword, serviceName) {
  if (!rawPassword) {
    return "";
  }

  const password = rawPassword.trim();
  if ((serviceName || "").toLowerCase() === "gmail") {
    // Gmail app passwords are often copied with spaces for readability.
    return password.replace(/\s+/g, "");
  }

  return password;
}

function createTransportConfig() {
  const service = envValue("EMAIL_SERVICE");
  const user = envValue("EMAIL_User", "EMAIL_USER", "Email_User");
  const pass = normalizePassword(
    envValue("EMAIL_Pass", "EMAIL_PASS", "Email_Pass"),
    service
  );

  if (service) {
    return {
      service,
      auth: { user, pass },
    };
  }

  return {
    host: envValue("SMTP_HOST") || "smtp.gmail.com",
    port: Number(envValue("SMTP_PORT")) || 587,
    secure: envValue("SMTP_SECURE").toLowerCase() === "true",
    auth: { user, pass },
  };
}

const transporter = nodemailer.createTransport(createTransportConfig());

function getMailFrom() {
  return envValue("FROM_EMAIL") || envValue("EMAIL_User", "EMAIL_USER", "Email_User");
}

async function sendMailSafe(mailOptions, context = "email") {
  const from = getMailFrom();
  const to = mailOptions?.to;

  if (!from) {
    console.warn(`[Mail:${context}] Skipped: missing FROM_EMAIL/EMAIL_User env.`);
    return { ok: false, skipped: true, reason: "missing_from" };
  }

  if (!to) {
    console.warn(`[Mail:${context}] Skipped: missing recipient email.`);
    return { ok: false, skipped: true, reason: "missing_to" };
  }

  try {
    const info = await transporter.sendMail({ ...mailOptions, from });
    console.log(`[Mail:${context}] Sent to ${to}`);
    return { ok: true, info };
  } catch (error) {
    console.error(`[Mail:${context}] Failed:`, error?.message || error);
    return { ok: false, error };
  }
}

function getFrontendBaseUrl() {
  const raw = envValue("FRONTEND_PUBLIC_URL") || envValue("FRONTEND_URL") || "http://localhost:3000";

  // If someone stored an API route instead of frontend root, normalize it.
  return raw
    .replace(/\/api\/v\d+\/users\/?$/i, "")
    .replace(/\/$/, "");
}

module.exports = {
  getFrontendBaseUrl,
  getMailFrom,
  sendMailSafe,
  transporter,
};
