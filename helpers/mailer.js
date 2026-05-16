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

function normalizePassword(rawPassword, { serviceName = "", host = "", user = "" } = {}) {
  if (!rawPassword) {
    return "";
  }

  const password = rawPassword.trim();
  const isGmailService = (serviceName || "").toLowerCase() === "gmail";
  const isGmailHost = /gmail\.com$/i.test(host || "");
  const isGmailUser = /@gmail\.com$/i.test(user || "");

  if (isGmailService || isGmailHost || isGmailUser) {
    // Gmail app passwords are often copied with spaces for readability.
    return password.replace(/\s+/g, "");
  }

  return password;
}

function createTransportConfig() {
  const service = envValue("EMAIL_SERVICE");
  const user = envValue("EMAIL_User", "EMAIL_USER", "Email_User");
  const host = envValue("SMTP_HOST") || "smtp.gmail.com";
  const port = Number(envValue("SMTP_PORT")) || 587;
  const secure = envValue("SMTP_SECURE").toLowerCase() === "true";
  const pass = normalizePassword(
    envValue("EMAIL_Pass", "EMAIL_PASS", "Email_Pass"),
    { serviceName: service, host, user }
  );

  if (service) {
    return {
      service,
      auth: { user, pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    };
  }

  return {
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  };
}

const transportConfig = createTransportConfig();
const transporter = nodemailer.createTransport(transportConfig);

if (!transportConfig?.auth?.user || !transportConfig?.auth?.pass) {
  console.warn("[Mail] Missing email credentials. Set EMAIL_USER/EMAIL_PASS (or EMAIL_User/EMAIL_Pass). Emails will fail.");
}

const isGmailTransport = () => {
  const service = String(transportConfig?.service || "").toLowerCase();
  const host = String(transportConfig?.host || "").toLowerCase();
  const user = String(transportConfig?.auth?.user || "").toLowerCase();
  return service === "gmail" || host.includes("gmail") || user.endsWith("@gmail.com");
};

if (isGmailTransport()) {
  const normalizedPass = String(transportConfig?.auth?.pass || "");
  if (!normalizedPass || normalizedPass.length < 16) {
    console.warn("[Mail] Gmail SMTP detected with a weak/missing password. Use a 16-character Gmail App Password (not your normal account password).");
  }
}

function getMailFrom() {
  return envValue("FROM_EMAIL") || envValue("EMAIL_User", "EMAIL_USER", "Email_User");
}

async function sendMailSafe(mailOptions, context = "email") {
  const from = getMailFrom();
  const to = mailOptions?.to;
  const authUser = transportConfig?.auth?.user;
  const authPass = transportConfig?.auth?.pass;

  if (!authUser || !authPass) {
    console.warn(`[Mail:${context}] Skipped: missing SMTP auth credentials.`);
    return { ok: false, skipped: true, reason: "missing_auth" };
  }

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
    const details = {
      message: error?.message || "Unknown mail error",
      code: error?.code,
      responseCode: error?.responseCode,
      command: error?.command,
      response: error?.response,
    };
    console.error(`[Mail:${context}] Failed:`, details);
    return { ok: false, error };
  }
}

async function verifyMailerConnection(context = "startup") {
  const authUser = transportConfig?.auth?.user;
  const authPass = transportConfig?.auth?.pass;

  if (!authUser || !authPass) {
    console.warn(`[Mail:${context}] Verification skipped: missing auth credentials.`);
    return { ok: false, skipped: true, reason: "missing_auth" };
  }

  try {
    await transporter.verify();
    console.log(`[Mail:${context}] SMTP connection verified.`);
    return { ok: true };
  } catch (error) {
    const details = {
      message: error?.message || "SMTP verification failed",
      code: error?.code,
      responseCode: error?.responseCode,
      command: error?.command,
      response: error?.response,
    };
    console.error(`[Mail:${context}] SMTP verification failed:`, details);

    if (isGmailTransport()) {
      console.error("[Mail] Gmail hint: set EMAIL_SERVICE=gmail and use a valid Gmail App Password in EMAIL_PASS/EMAIL_Pass.");
    }

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
  verifyMailerConnection,
  transporter,
};
