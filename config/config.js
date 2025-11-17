const fs = require('fs');
const path = require('path');

// Check if private key file exists
// const privateKeyPath = process.env.TELEBIRR_PRIVATE_KEY_PATH || './config/private_key.pem';
// let privateKey = null;

// try {
//   if (fs.existsSync(privateKeyPath)) {
//     privateKey = fs.readFileSync(privateKeyPath, 'utf8');
//     console.log('Private key loaded successfully');
//   } else {
//     console.warn('Private key file not found at:', privateKeyPath);
//   }
// } catch (error) {
//   console.error('Error loading private key:', error.message);
// }

module.exports = {
  // Telebirr API Configuration
  baseUrl: process.env.TELEBIRR_BASE_URL || "https://api.telebirr.com", // Replace with actual Telebirr API URL
  fabricAppId: process.env.TELEBIRR_FABRIC_APP_ID || "your_fabric_app_id",
  appId: process.env.TELEBIRR_APP_ID || "your_app_id", 
  merchantCode: process.env.TELEBIRR_MERCHANT_CODE || "your_merchant_code",
  merchantAppId: process.env.TELEBIRR_MERCHANT_APP_ID || "your_merchant_app_id",
  
  // Webhook and redirect URLs
  notifyUrl: process.env.NOTIFY_URL || "https://yourdomain.com/api/v1/telebirr/webhook",
  redirectUrl: process.env.REDIRECT_URL || "https://yourdomain.com/payment/success",
  webBaseUrl: process.env.TELEBIRR_WEB_BASE_URL || "https://telebirr.com/payment/checkout",
  
  // Private key for signing (path to your private key file)
  // Only load from file if TELEBIRR_PRIVATE_KEY env var is not set
  get privateKey() {
    if (process.env.TELEBIRR_PRIVATE_KEY) {
      return process.env.TELEBIRR_PRIVATE_KEY;
    }
    // Try to load from file only if file exists (for local development)
    const keyPath = path.join(__dirname, 'telebirr_private_key.pem');
    if (fs.existsSync(keyPath)) {
      return fs.readFileSync(keyPath, 'utf8');
    }
    // Return empty string if mock mode is enabled
    if (process.env.USE_MOCK_TELEBIRR === 'true') {
      return 'mock_private_key';
    }
    throw new Error('TELEBIRR_PRIVATE_KEY not configured');
  }
};