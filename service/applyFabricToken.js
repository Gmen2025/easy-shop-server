const axios = require("axios");
const https = require("https");
const tools = require("../utils/tools");
const config = require("../config/config");

exports.applyFabricToken = async () => {
  try {
    console.log("Attempting to get fabric token...");
    console.log("Config check:", {
      baseUrl: config.baseUrl,
      fabricAppId: config.fabricAppId,
      appId: config.appId,
    });

    let reqObject = createRequestObject();
    console.log("Request object:", JSON.stringify(reqObject, null, 2));

    // Validate the request object before sending
    if (!reqObject || !reqObject.sign) {
      throw new Error("Invalid request object - missing signature");
    }

    // Create axios instance with SSL certificate bypass
    const httpsAgent = new https.Agent({
      rejectUnauthorized: false, // Bypass SSL certificate validation
      requestCert: false,
      agent: false,
    });

    console.log("Making request to:", config.baseUrl + "/payment/v1/token");

    const response = await axios.post(
      config.baseUrl + "/payment/v1/token",
      reqObject,
      {
        headers: {
          "Content-Type": "application/json",
          "X-APP-Key": config.fabricAppId,
        },
        timeout: 30000,
        httpsAgent: httpsAgent, // Add this to handle SSL issues
        validateStatus: function (status) {
          return status < 500; // Accept all status codes below 500
        },
      }
    );

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

    return response.data;
  } catch (error) {
    // More detailed error logging
    console.error("Full error object:", error);

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
        config: error.config,
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
