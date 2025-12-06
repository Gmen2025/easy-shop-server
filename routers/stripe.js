const express = require('express');
const router = express.Router();

// Initialize Stripe lazily to avoid startup errors if key is missing
let stripe = null;
const getStripe = () => {
  if (!stripe && process.env.STRIPE_KEY) {
    stripe = require('stripe')(process.env.STRIPE_KEY);
  }
  return stripe;
};

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
 *       500:
 *         description: Stripe not configured
 */
// Create payment intent
router.post('/create-payment-intent', async (req, res) => {
  try {
    const stripeInstance = getStripe();
    
    if (!stripeInstance) {
      return res.status(500).json({ 
        error: 'Stripe is not configured. Please set STRIPE_KEY environment variable.' 
      });
    }
    
    console.log('Request body:', req.body);
    console.log('Stripe key exists:', !!process.env.STRIPE_KEY);
    
    const { amount, currency, orderId } = req.body;

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
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;