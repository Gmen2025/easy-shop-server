const express = require('express');
const router = express.Router();
const createOrderService = require('../service/createOrder');

/**
 * @swagger
 * /api/v1/telebirr/initiate-payment:
 *   post:
 *     summary: Initiate Telebirr payment
 *     tags: [Payment - Telebirr]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *               - phoneNumber
 *               - customerName
 *             properties:
 *               amount:
 *                 type: number
 *                 example: 100
 *               phoneNumber:
 *                 type: string
 *                 example: "251912345678"
 *               customerName:
 *                 type: string
 *                 example: John Doe
 *               orderId:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment initiated successfully
 *       400:
 *         description: Invalid request data
 */
// Create/Initiate Telebirr payment
router.post('/initiate-payment', async (req, res) => {
  try {
    const { amount, phoneNumber, orderId, customerName, description } = req.body;

    // Validate required fields
    if (!amount || !phoneNumber || !customerName) {
      return res.status(400).json({
        success: false,
        message: 'Amount, phone number, and customer name are required'
      });
    }

    // Validate Ethiopian phone number format
    if (!phoneNumber.startsWith('251') || phoneNumber.length !== 12) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid Ethiopian phone number (251XXXXXXXXX)'
      });
    }

    console.log('Initiating payment for:', { amount, phoneNumber, customerName });

    // CHECK FOR MOCK MODE FIRST
    const useMockService = process.env.USE_MOCK_TELEBIRR === 'true';
    console.log('USE_MOCK_TELEBIRR:', useMockService);
    
    if (useMockService) {
      console.log('🎭 Using MOCK Telebirr service for testing...');
      
      // Simulate processing delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const mockOrderId = orderId || `ORDER_${Date.now()}`;
      const mockTransactionId = `TXN_${Date.now()}`;
      const mockPrepayId = `PREPAY_${Date.now()}`;
      
      const mockPaymentData = {
        paymentUrl: `https://mock-telebirr.com/pay?amount=${amount}&phone=${phoneNumber}&order=${mockOrderId}`,
        orderId: mockOrderId,
        amount: amount,
        customerName: customerName,
        phoneNumber: phoneNumber,
        transactionId: mockTransactionId,
        prepayId: mockPrepayId,
        isMock: true
      };
      
      console.log('✅ Mock payment data generated:', mockPaymentData);
      
      return res.json({
        success: true,
        message: 'Payment initiated successfully (MOCK MODE)',
        data: mockPaymentData
      });
    }

    // REAL TELEBIRR SERVICE (only runs if USE_MOCK_TELEBIRR=false)
    console.log('🔄 Using REAL Telebirr service...');
    
    const orderData = {
      title: description || `Payment for ${customerName}`,
      amount: amount,
      platform: 'mobile'
    };

    // Create request for createOrder service
    const serviceReq = {
      body: {
        title: orderData.title,
        amount: orderData.amount,
        platform: orderData.platform
      }
    };

    // Call the createOrder service
    let paymentResult = null;
    const serviceRes = {
      json: (data) => {
        paymentResult = data;
      },
      status: (code) => ({
        json: (data) => {
          throw new Error(data.error || 'Payment creation failed');
        }
      })
    };

    await createOrderService.createOrder(serviceReq, serviceRes);

    // Return success response
    res.json({
      success: true,
      message: 'Payment initiated successfully',
      data: {
        paymentUrl: paymentResult.payment_url,
        prepayId: paymentResult.prepay_id,
        orderId: orderId || `ORDER_${Date.now()}`,
        amount: amount,
        customerName: customerName,
        phoneNumber: phoneNumber,
        transactionId: `TXN_${Date.now()}`
      }
    });

  } catch (error) {
    console.error('❌ Telebirr payment initiation error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to initiate payment'
    });
  }
});

/**
 * @swagger
 * /api/v1/telebirr/verify-payment:
 *   post:
 *     summary: Verify Telebirr payment status
 *     tags: [Telebirr]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               transactionId:
 *                 type: string
 *               orderId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment verification result
 *       400:
 *         description: Missing transaction or order ID
 *       500:
 *         description: Verification failed
 */
// Verify payment status
router.post('/verify-payment', async (req, res) => {
  try {
    console.log('📋 Verify payment request body:', req.body);
    console.log('📋 Verify payment headers:', req.headers);
    
    const { transactionId, orderId } = req.body;

    if (!transactionId && !orderId) {
      console.log('❌ Missing required fields:', { transactionId, orderId });
      return res.status(400).json({
        success: false,
        message: 'Transaction ID or Order ID is required'
      });
    }

    console.log('🔍 Verifying payment for:', { transactionId, orderId });

    // For mock mode, always return success
    const useMockService = process.env.USE_MOCK_TELEBIRR === 'true';
    
    if (useMockService) {
      console.log('✅ Mock payment verification - always successful');
      
      await new Promise(resolve => setTimeout(resolve, 500)); // Simulate delay
      
      const paymentStatus = {
        transactionId: transactionId || `TXN_${Date.now()}`,
        orderId: orderId || `ORDER_${Date.now()}`,
        status: 'completed',
        amount: 100,
        currency: 'ETB',
        timestamp: new Date().toISOString(),
        paymentMethod: 'telebirr',
        isMock: true
      };

      return res.json({
        success: true,
        message: 'Payment verification successful (MOCK)',
        data: paymentStatus
      });
    }

    // Real verification logic would go here
    res.json({
      success: true,
      message: 'Payment verification successful',
      data: {
        transactionId,
        orderId,
        status: 'completed',
        amount: 100,
        currency: 'ETB',
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Payment verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify payment'
    });
  }
});

/**
 * @swagger
 * /api/v1/telebirr/payment-status/{transactionId}:
 *   get:
 *     summary: Get payment status by transaction ID
 *     tags: [Telebirr]
 *     parameters:
 *       - in: path
 *         name: transactionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Transaction ID
 *     responses:
 *       200:
 *         description: Payment status retrieved
 *       500:
 *         description: Failed to retrieve status
 */
// Get payment status
router.get('/payment-status/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;

    const useMockService = process.env.USE_MOCK_TELEBIRR === 'true';
    
    if (useMockService) {
      console.log('📊 Mock payment status check');
      
      const paymentStatus = {
        transactionId,
        status: 'completed',
        amount: 100,
        currency: 'ETB',
        timestamp: new Date().toISOString(),
        isMock: true
      };

      return res.json({
        success: true,
        data: paymentStatus
      });
    }

    // Real status check logic would go here
    res.json({
      success: true,
      data: {
        transactionId,
        status: 'completed',
        amount: 100,
        currency: 'ETB',
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Payment status check error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check payment status'
    });
  }
});

/**
 * @swagger
 * /api/v1/telebirr/webhook:
 *   post:
 *     summary: Receive Telebirr payment notifications
 *     tags: [Telebirr]
 *     description: Webhook endpoint for receiving payment status updates from Telebirr
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               transactionId:
 *                 type: string
 *               status:
 *                 type: string
 *               amount:
 *                 type: number
 *               orderId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *       500:
 *         description: Webhook processing failed
 */
// Webhook endpoint for Telebirr notifications
router.post('/webhook', async (req, res) => {
  try {
    console.log('📨 Telebirr webhook received:', req.body);
    
    // Process the webhook data
    const { transactionId, status, amount, orderId } = req.body;
    
    // Update your database with the payment status
    // Example: await Order.findOneAndUpdate({ orderId }, { paymentStatus: status });
    
    res.status(200).json({
      success: true,
      message: 'Webhook processed successfully'
    });

  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process webhook'
    });
  }
});

module.exports = router;