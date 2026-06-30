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
  const aliases = new Set();

  if (dbSuffix) {
    aliases.add(dbSuffix);

    // Common prefix variants, e.g. E_SHOPUSA -> SHOPUSA / USA
    if (dbSuffix.startsWith('E_')) {
      aliases.add(dbSuffix.slice(2));
    }
    if (dbSuffix.startsWith('E_SHOP')) {
      aliases.add(dbSuffix.slice('E_SHOP'.length));
    }
    if (dbSuffix.startsWith('SHOP')) {
      aliases.add(dbSuffix.slice('SHOP'.length));
    }

    // Convenience fallback for names like E_SHOPUSA -> USA
    const tokens = dbSuffix.split('_').filter(Boolean);
    if (tokens.length > 1) {
      const lastToken = tokens[tokens.length - 1];
      aliases.add(lastToken);

      // If token is SHOPUSA style, also try USA.
      if (lastToken.startsWith('SHOP') && lastToken.length > 4) {
        aliases.add(lastToken.slice(4));
      }
    }

    Array.from(aliases)
      .filter(Boolean)
      .forEach((alias) => {
        candidates.push(`STRIPE_KEY_${alias}`);
        candidates.push(`STRIPE_SECRET_KEY_${alias}`);
      });
  }

  candidates.push('STRIPE_KEY');
  candidates.push('STRIPE_SECRET_KEY');
  candidates.push('STRIPE_API_KEY');

  return candidates;
}

function resolveStripeConfig(dbName) {
  const keyCandidates = getStripeKeyCandidates(dbName);
  const configuredEntries = keyCandidates
    .filter((name) => !!process.env[name])
    .map((name) => ({ name, value: String(process.env[name]).trim() }));

  // Server-side Stripe SDK requires a secret key (sk_test_* or sk_live_*).
  const secretEntry = configuredEntries.find((entry) => isStripeSecretKey(entry.value));
  const selectedEntry = secretEntry || configuredEntries[0] || null;

  return {
    apiKey: selectedEntry ? selectedEntry.value : null,
    resolvedKeyName: selectedEntry ? selectedEntry.name : null,
    keyCandidates,
    isSecretKey: !!secretEntry,
  };
}

function isStripeTestKey(apiKey) {
  return typeof apiKey === 'string' && apiKey.startsWith('sk_test_');
}

function isStripeSecretKey(apiKey) {
  return typeof apiKey === 'string' && /^sk_(test|live)_/.test(apiKey);
}

function getStripe(dbName) {
  const { apiKey, resolvedKeyName, keyCandidates, isSecretKey } = resolveStripeConfig(dbName);

  if (!apiKey) {
    return {
      stripe: null,
      resolvedKeyName: null,
      keyCandidates,
      keyInvalidReason: null,
    };
  }

  if (!isSecretKey) {
    return {
      stripe: null,
      resolvedKeyName,
      keyCandidates,
      keyInvalidReason: 'not_secret_key',
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
    const {
      stripe: stripeInstance,
      resolvedKeyName,
      keyCandidates,
      keyInvalidReason,
    } = getStripe(req.dbName);
    const { apiKey } = resolveStripeConfig(req.dbName);

    if (keyInvalidReason === 'not_secret_key') {
      return res.status(503).json({
        code: 'STRIPE_INVALID_SECRET_KEY',
        message: 'Stripe is misconfigured. Backend requires a secret key (sk_test_* or sk_live_*).',
        canSwitchPaymentMethod: true,
        details: `Resolved env ${resolvedKeyName} is not a Stripe secret key. Do not use pk_* values on the backend.`,
        expectedEnv: keyCandidates,
      });
    }
    
    if (!stripeInstance) {
      return res.status(503).json({
        code: 'STRIPE_NOT_CONFIGURED',
        message: 'Card payment is currently unavailable. Please choose another payment method.',
        canSwitchPaymentMethod: true,
        details: `Stripe is not configured for database "${req.dbName}".`,
        expectedEnv: keyCandidates
      });
    }

    if (process.env.NODE_ENV === 'production' && isStripeTestKey(apiKey)) {
      return res.status(503).json({
        code: 'STRIPE_LIVE_KEY_REQUIRED',
        message: 'Stripe live secret key is required in production.',
        canSwitchPaymentMethod: true,
        details: resolvedKeyName
          ? `Current key ${resolvedKeyName} is a test key. Set it to an sk_live_* value in production.`
          : undefined,
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