const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_KEY);

// Create payment intent
router.post('/create-payment-intent', async (req, res) => {
  try {
    console.log('Request body:', req.body);
    console.log('Stripe key exists:', !!process.env.STRIPE_KEY);
    
    const { amount, currency, orderId } = req.body;

    const paymentIntent = await stripe.paymentIntents.create({
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