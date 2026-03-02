const express = require('express');
const router = express.Router();
const cloudinary = require('cloudinary').v2;

// Ensure Cloudinary is configured via env vars in app startup (dotenv in app.js)

function getCloudinaryCredentials() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_NAME || process.env.CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY || process.env.CLOUDINARY_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET || process.env.CLOUDINARY_SECRET;

  if (cloudName && apiKey && apiSecret) {
    return { cloudName, apiKey, apiSecret };
  }

  const cfg = cloudinary.config(true);
  if (cfg && cfg.cloud_name && cfg.api_key && cfg.api_secret) {
    return {
      cloudName: cfg.cloud_name,
      apiKey: cfg.api_key,
      apiSecret: cfg.api_secret,
    };
  }

  return null;
}

// POST /api/v1/cloudinary/sign
// Body (optional): object containing the params that should be signed (e.g. { public_id })
router.post('/sign', (req, res) => {
  try {
    const credentials = getCloudinaryCredentials();
    if (!credentials) {
      return res.status(500).json({ message: 'Cloudinary not configured on server' });
    }

    const timestamp = Math.round(Date.now() / 1000);

    // Only include allowed params to sign. If client sends `params_to_sign`, use it.
    const paramsToSign = Object.assign({}, req.body.params_to_sign || {});
    // Ensure timestamp is part of the signature payload
    paramsToSign.timestamp = timestamp;

    // Create signature using cloudinary utility
    const signature = cloudinary.utils.api_sign_request(paramsToSign, credentials.apiSecret);

    return res.json({
      signature,
      api_key: credentials.apiKey,
      cloud_name: credentials.cloudName,
      timestamp
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
