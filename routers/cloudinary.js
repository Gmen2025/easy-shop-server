const express = require('express');
const router = express.Router();
const cloudinary = require('cloudinary').v2;

// Ensure Cloudinary is configured via env vars in app startup (dotenv in app.js)

// POST /api/v1/cloudinary/sign
// Body (optional): object containing the params that should be signed (e.g. { public_id })
router.post('/sign', (req, res) => {
  try {
    // Validate Cloudinary config is present
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (!apiSecret || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_CLOUD_NAME) {
      return res.status(500).json({ message: 'Cloudinary not configured on server' });
    }

    const timestamp = Math.round(Date.now() / 1000);

    // Only include allowed params to sign. If client sends `params_to_sign`, use it.
    const paramsToSign = Object.assign({}, req.body.params_to_sign || {});
    // Ensure timestamp is part of the signature payload
    paramsToSign.timestamp = timestamp;

    // Create signature using cloudinary utility
    const signature = cloudinary.utils.api_sign_request(paramsToSign, apiSecret);

    return res.json({
      signature,
      api_key: process.env.CLOUDINARY_API_KEY,
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      timestamp
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
