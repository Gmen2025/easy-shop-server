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

function getMissingCloudinaryKeys() {
  const missing = [];
  if (!(process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_NAME || process.env.CLOUD_NAME)) {
    missing.push('CLOUDINARY_CLOUD_NAME');
  }
  if (!(process.env.CLOUDINARY_API_KEY || process.env.CLOUDINARY_KEY)) {
    missing.push('CLOUDINARY_API_KEY');
  }
  if (!(process.env.CLOUDINARY_API_SECRET || process.env.CLOUDINARY_SECRET)) {
    missing.push('CLOUDINARY_API_SECRET');
  }
  return missing;
}

function buildParamsToSign(body, timestamp) {
  const allowedTopLevelKeys = [
    'folder',
    'public_id',
    'upload_preset',
    'tags',
    'context',
    'eager',
    'transformation',
    'type',
    'invalidate',
    'overwrite',
    'resource_type',
  ];

  const paramsToSign = Object.assign({}, body && body.params_to_sign ? body.params_to_sign : {});

  for (const key of allowedTopLevelKeys) {
    if (paramsToSign[key] === undefined && body && body[key] !== undefined) {
      paramsToSign[key] = body[key];
    }
  }

  paramsToSign.timestamp = timestamp;
  return paramsToSign;
}

// POST /api/v1/cloudinary/sign
// Body (optional): object containing the params that should be signed (e.g. { public_id })
router.post('/sign', (req, res) => {
  try {
    const credentials = getCloudinaryCredentials();
    if (!credentials) {
      const missing = getMissingCloudinaryKeys();
      return res.status(500).json({
        message: 'Cloudinary not configured on server',
        missing,
      });
    }

    const timestamp = Math.round(Date.now() / 1000);
    const paramsToSign = buildParamsToSign(req.body || {}, timestamp);

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
