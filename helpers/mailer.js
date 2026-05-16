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

function envValueWithSource(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return { value: value.trim(), key };
    }
  }
  return { value: "", key: null };
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
  const serviceMeta = envValueWithSource("EMAIL_SERVICE", "MAIL_SERVICE");
  const userMeta = envValueWithSource(
    "EMAIL_User",
    "EMAIL_USER",
    "Email_User",
    "SMTP_USER",
    "MAIL_USER",
    "GMAIL_USER"
  );
  const host = envValue("SMTP_HOST") || "smtp.gmail.com";
  const port = Number(envValue("SMTP_PORT")) || 587;
  const secure = envValue("SMTP_SECURE").toLowerCase() === "true";
  const passMeta = envValueWithSource(
    "EMAIL_Pass",
    "EMAIL_PASS",
    "Email_Pass",
    "SMTP_PASS",
    "MAIL_PASS",
    "GMAIL_APP_PASSWORD"
  );
  const service = serviceMeta.value;
  const user = userMeta.value;
  const pass = normalizePassword(passMeta.value, {
    serviceName: service,
    host,
    user,
  });

  const baseConfig = {
    auth: { user, pass },
    connectionTimeout: 30000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  };

  if (service) {
    return {
      config: {
      service,
      ...baseConfig,
      },
      meta: {
        serviceKey: serviceMeta.key,
        userKey: userMeta.key,
        passKey: passMeta.key,
      },
    };
  }

  return {
    config: {
      host,
      port,
      secure,
      ...baseConfig,
    },
    meta: {
      serviceKey: serviceMeta.key,
      userKey: userMeta.key,
      passKey: passMeta.key,
    },
  };
}

const { config: transportConfig, meta: transportMeta } = createTransportConfig();
const transporter = nodemailer.createTransport(transportConfig);

const createGmailFallbackTransporter = () => {
  if (!isGmailTransport()) {
    return null;
  }

  const auth = transportConfig?.auth || {};
  if (!auth.user || !auth.pass) {
    return null;
  }

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth,
    family: 4,
    connectionTimeout: 30000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });
};

const fallbackTransporter = createGmailFallbackTransporter();

if (!transportConfig?.auth?.user || !transportConfig?.auth?.pass) {
  console.warn("[Mail] Missing email credentials. Accepted keys for user: EMAIL_USER/EMAIL_User/SMTP_USER/MAIL_USER/GMAIL_USER. Accepted keys for pass: EMAIL_PASS/EMAIL_Pass/SMTP_PASS/MAIL_PASS/GMAIL_APP_PASSWORD.");
  console.warn("[Mail] Detected keys:", {
    serviceKey: transportMeta?.serviceKey || "none",
    userKey: transportMeta?.userKey || "none",
    passKey: transportMeta?.passKey || "none",
  });
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
  return envValue("FROM_EMAIL", "MAIL_FROM") || envValue("EMAIL_User", "EMAIL_USER", "Email_User", "SMTP_USER", "MAIL_USER", "GMAIL_USER");
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

    const shouldTryFallback =
      !!fallbackTransporter &&
      (error?.code === "ETIMEDOUT" || error?.code === "ECONNREFUSED" || error?.command === "CONN");

    if (shouldTryFallback) {
      try {
        const info = await fallbackTransporter.sendMail({ ...mailOptions, from });
        console.log(`[Mail:${context}] Sent via fallback SMTP transport to ${to}`);
        return { ok: true, info };
      } catch (fallbackError) {
        const fallbackDetails = {
          message: fallbackError?.message || "Unknown fallback mail error",
          code: fallbackError?.code,
          responseCode: fallbackError?.responseCode,
          command: fallbackError?.command,
          response: fallbackError?.response,
        };
        console.error(`[Mail:${context}] Fallback failed:`, fallbackDetails);
        return { ok: false, error: fallbackError };
      }
    }

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

    const shouldTryFallback =
      !!fallbackTransporter &&
      (error?.code === "ETIMEDOUT" || error?.code === "ECONNREFUSED" || error?.command === "CONN");

    if (shouldTryFallback) {
      try {
        await fallbackTransporter.verify();
        console.log(`[Mail:${context}] Fallback SMTP connection verified.`);
        return { ok: true, usedFallback: true };
      } catch (fallbackError) {
        const fallbackDetails = {
          message: fallbackError?.message || "Fallback SMTP verification failed",
          code: fallbackError?.code,
          responseCode: fallbackError?.responseCode,
          command: fallbackError?.command,
          response: fallbackError?.response,
        };
        console.error(`[Mail:${context}] Fallback SMTP verification failed:`, fallbackDetails);
      }
    }

    if (isGmailTransport()) {
      console.error("[Mail] Gmail hint: set EMAIL_SERVICE=gmail and use a valid Gmail App Password in EMAIL_PASS/EMAIL_Pass.");
      console.error("[Mail] Network hint: on some hosts port 587 is flaky; fallback tries port 465 secure SMTP.");
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
