const axios = require("axios");
const https = require("https");
const tools = require("../utils/tools");
const config = require("../config/config");

let cachedFabricToken = null;
let cachedFabricTokenExpiresAt = 0;

function getTelebirrTimeoutMs() {
  const timeoutMsRaw = Number(process.env.TELEBIRR_TOKEN_TIMEOUT_MS || process.env.TELEBIRR_TIMEOUT_MS || 7000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 7000;
  return Math.min(Math.max(timeoutMs, 3000), 20000);
}

function isRetryableTelebirrTimeout(error) {
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toUpperCase();

  return (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    message.includes('timeout') ||
    message.includes('socket hang up')
  );
}

async function requestFabricToken(reqObject, timeoutMs) {
  const allowInsecureTls =
    process.env.USE_MOCK_TELEBIRR === 'true' ||
    process.env.TELEBIRR_ALLOW_INSECURE_TLS === 'true';

  if (allowInsecureTls) {
    console.warn('[Telebirr] TLS certificate verification is disabled. Do not use this in production.');
  }

  const httpsAgent = new https.Agent({
    rejectUnauthorized: !allowInsecureTls,
    requestCert: false,
    agent: false,
  });

  console.log('Making request to:', config.baseUrl + '/payment/v1/token', { timeoutMs });

  return axios.post(
    config.baseUrl + '/payment/v1/token',
    reqObject,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-APP-Key': config.fabricAppId,
      },
      timeout: timeoutMs,
      httpsAgent,
      validateStatus(status) {
        return status < 500;
      },
    }
  );
}

exports.applyFabricToken = async () => {
  try {
    if (cachedFabricToken && Date.now() < cachedFabricTokenExpiresAt) {
      return cachedFabricToken;
    }

    console.log("Attempting to get fabric token...");
    const configIssues = config.getTelebirrConfigIssues();
    if (configIssues.length > 0) {
      throw new Error(
        `Telebirr is not configured on this server. Missing or placeholder env vars: ${configIssues.join(', ')}`
      );
    }

    console.log("Config check:", {
      baseUrl: config.baseUrl,
      fabricAppId: config.fabricAppId,
      appId: config.appId,
    });

    const reqObject = createRequestObject();
    console.log("Request object:", JSON.stringify(reqObject, null, 2));

    // Validate the request object before sending
    if (!reqObject || !reqObject.sign) {
      throw new Error("Invalid request object - missing signature");
    }

    const timeoutMs = getTelebirrTimeoutMs();
    let response;
    try {
      response = await requestFabricToken(reqObject, timeoutMs);
    } catch (error) {
      if (!isRetryableTelebirrTimeout(error)) {
        throw error;
      }

      const retryTimeoutMs = Math.min(timeoutMs + 3000, 15000);
      console.warn('[Telebirr] Retrying fabric token request after timeout', {
        firstTimeoutMs: timeoutMs,
        retryTimeoutMs,
        code: error?.code,
        message: error?.message,
      });
      response = await requestFabricToken(reqObject, retryTimeoutMs);
    }

    console.log("API Response Status:", response.status);
    console.log("API Response Headers:", response.headers);
    console.log("Fabric token response:", response.data);

    // Check response status
    if (response.status !== 200) {
      throw new Error(
        `API returned status ${response.status}: ${JSON.stringify(
          response.data
        )}`
      );
    }

    // Check if response contains token
    if (!response.data || !response.data.token) {
      throw new Error(
        `No token received from API. Response: ${JSON.stringify(response.data)}`
      );
    }

    const expiresInSeconds = Number(response.data.expires_in || response.data.expiresIn || 3600);
    const cacheLifetimeMs = Number.isFinite(expiresInSeconds) && expiresInSeconds > 120
      ? (expiresInSeconds - 60) * 1000
      : 30 * 60 * 1000;

    cachedFabricToken = response.data;
    cachedFabricTokenExpiresAt = Date.now() + cacheLifetimeMs;

    return response.data;
  } catch (error) {
    // Keep logs concise while preserving actionable diagnostics.
    console.error("Telebirr token request error:", {
      message: error?.message,
      code: error?.code,
      status: error?.response?.status,
    });

    if (error.response) {
      console.error("API Error Response:", {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        headers: error.response.headers,
      });
      throw new Error(
        `API Error ${error.response.status}: ${JSON.stringify(
          error.response.data
        )}`
      );
    } else if (error.request) {
      console.error("Network Error - No response received:", {
        message: error.message,
        code: error.code,
        url: error.config?.url,
      });
      throw new Error(
        `Network Error: ${error.message} (Code: ${error.code || "unknown"})`
      );
    } else {
      console.error("Request Setup Error:", {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
      throw new Error(
        `Request Error: ${error.message || "Unknown error in request setup"}`
      );
    }
  }
};

function createRequestObject() {
  try {
    // Validate required config
    if (!config.appId) {
      throw new Error("Missing appId in configuration");
    }

    console.log("Creating request object...");

    let req = {
      timestamp: tools.createTimeStamp(),
      nonce_str: tools.createNonceStr(),
      method: "payment.applytoken",
      version: "1.0",
    };

    console.log("Basic request object created:", req);

    req.biz_content = {
      app_id: config.appId,
    };

    console.log("Added biz_content:", req);

    // Check if tools.signRequestObject exists and is a function
    if (typeof tools.signRequestObject !== "function") {
      throw new Error("tools.signRequestObject is not a function");
    }

    console.log("About to sign request object...");
    req.sign = tools.signRequestObject(req);
    console.log("Request signed successfully. Signature:", req.sign);

    req.sign_type = "SHA256WithRSA";

    console.log("Final request object:", req);
    return req;
  } catch (error) {
    console.error("Error creating request object:", error);
    throw error;
  }
}
