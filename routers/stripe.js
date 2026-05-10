const express = require('express');
const router = express.Router();

// Cache Stripe clients by resolved API key to support multi-database flows.
const stripeClientsByKey = new Map();

function normalizeDbEnvSuffix(dbName) {
  if (!dbName || typeof dbName !== 'string') {
    return '';
  }

  return dbName
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function getStripeKeyCandidates(dbName) {
  const dbSuffix = normalizeDbEnvSuffix(dbName);
  const candidates = [];

  if (dbSuffix) {
    candidates.push(`STRIPE_KEY_${dbSuffix}`);
    candidates.push(`STRIPE_SECRET_KEY_${dbSuffix}`);

    // Convenience fallback for names like E_SHOPUSA -> USA
    const tokens = dbSuffix.split('_').filter(Boolean);
    if (tokens.length > 1) {
      const lastToken = tokens[tokens.length - 1];
      candidates.push(`STRIPE_KEY_${lastToken}`);
      candidates.push(`STRIPE_SECRET_KEY_${lastToken}`);
    }
  }

  candidates.push('STRIPE_KEY');
  candidates.push('STRIPE_SECRET_KEY');
  candidates.push('STRIPE_API_KEY');

  return candidates;
}

function resolveStripeConfig(dbName) {
  const keyCandidates = getStripeKeyCandidates(dbName);
  const resolvedKeyName = keyCandidates.find((name) => !!process.env[name]);
  const apiKey = resolvedKeyName ? process.env[resolvedKeyName] : null;

  return {
    apiKey,
    resolvedKeyName,
    keyCandidates,
  };
}

function getStripe(dbName) {
  const { apiKey, resolvedKeyName, keyCandidates } = resolveStripeConfig(dbName);

  if (!apiKey) {
    return {
      stripe: null,
      resolvedKeyName: null,
      keyCandidates,
    };
  }

  if (!stripeClientsByKey.has(apiKey)) {
    stripeClientsByKey.set(apiKey, require('stripe')(apiKey));
  }

  return {
    stripe: stripeClientsByKey.get(apiKey),
    resolvedKeyName,
    keyCandidates,
  };
}

/**
 * @swagger
 * /api/v1/stripe/create-payment-intent:
 *   post:
 *     summary: Create Stripe payment intent
 *     tags: [Payment - Stripe]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *               - currency
 *             properties:
 *               amount:
 *                 type: number
 *                 example: 2000
 *                 description: Amount in cents (e.g., 2000 = $20.00)
 *               currency:
 *                 type: string
 *                 example: usd
 *               orderId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment intent created successfully
 *       400:
 *         description: Invalid request
 *       503:
 *         description: Card payment is currently unavailable
 */
// Create payment intent
router.post('/create-payment-intent', async (req, res) => {
  try {
    const { stripe: stripeInstance, resolvedKeyName, keyCandidates } = getStripe(req.dbName);
    
    if (!stripeInstance) {
      return res.status(503).json({
        code: 'STRIPE_NOT_CONFIGURED',
        message: 'Card payment is currently unavailable. Please choose another payment method.',
        canSwitchPaymentMethod: true,
        details: `Stripe is not configured for database "${req.dbName}".`,
        expectedEnv: keyCandidates
      });
    }

    console.log(`[Stripe] DB=${req.dbName} using key=${resolvedKeyName}`);

    const { amount, currency, orderId } = req.body;

    if (!amount || amount <= 0 || !currency) {
      return res.status(400).json({
        code: 'INVALID_PAYMENT_INTENT_REQUEST',
        message: 'Amount and currency are required to create a payment intent.'
      });
    }

    const paymentIntent = await stripeInstance.paymentIntents.create({
      amount,
      currency,
      metadata: { orderId },
      automatic_payment_methods: {
        enabled: true,
      },
    });

    res.json({
      client_secret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error('Stripe error details:', error); // Log full error
    const status = error && error.type && error.type.startsWith('Stripe') ? 400 : 500;
    res.status(status).json({
      code: 'STRIPE_PAYMENT_INTENT_FAILED',
      message: error.message || 'Unable to create payment intent at this time.'
    });
  }
});

module.exports = router;