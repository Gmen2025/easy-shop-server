const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const mongoose = require('mongoose');
const createOrderService = require('../service/createOrder');
const { Order } = require('../models/order');

const paymentStatusStore = new Map();
const pendingTelebirrRequests = new Map();

function toTelebirrLinks(value) {
  const url = value?.checkout_url || value?.payment_url || value?.paymentUrl || '';
  if (!url) {
    return {
      paymentUrl: '',
      payment_url: '',
      checkout_url: '',
    };
  }
  return {
    paymentUrl: url,
    payment_url: url,
    checkout_url: url,
  };
}

function findPendingByOrderId(orderId) {
  if (!orderId) {
    return null;
  }
  for (const entry of pendingTelebirrRequests.values()) {
    if (entry?.orderId === orderId) {
      return entry;
    }
  }
  return null;
}

function getInitiationTimeoutMs() {
  const timeoutMsRaw = Number(process.env.TELEBIRR_INITIATE_TIMEOUT_MS || 6500);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 6500;
  return Math.min(Math.max(timeoutMs, 3000), 20000);
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    }),
  ]);
}

function classifyTelebirrError(error) {
  const rawMessage = String(error?.message || 'Unknown Telebirr error');

  if (rawMessage.includes('Telebirr is not configured')) {
    return {
      status: 503,
      code: 'TELEBIRR_NOT_CONFIGURED',
      message: 'Telebirr is not configured on the server.',
      details: rawMessage,
    };
  }

  if (rawMessage.includes('DEPTH_ZERO_SELF_SIGNED_CERT')) {
    return {
      status: 503,
      code: 'TELEBIRR_TLS_ERROR',
      message: 'Telebirr TLS certificate validation failed.',
      details: rawMessage,
    };
  }

  if (
    rawMessage.includes('ECONNABORTED') ||
    rawMessage.includes('ETIMEDOUT') ||
    rawMessage.includes('socket hang up') ||
    rawMessage.toLowerCase().includes('timeout')
  ) {
    return {
      status: 503,
      code: 'TELEBIRR_TIMEOUT',
      message: 'Telebirr gateway did not respond in time.',
      details: rawMessage,
    };
  }

  if (rawMessage.includes('ENOTFOUND') || rawMessage.includes('EAI_AGAIN') || rawMessage.includes('ECONNREFUSED')) {
    return {
      status: 503,
      code: 'TELEBIRR_UNREACHABLE',
      message: 'Telebirr gateway is unreachable from the server.',
      details: rawMessage,
    };
  }

  return {
    status: 500,
    code: 'TELEBIRR_INITIATE_FAILED',
    message: rawMessage,
    details: undefined,
  };
}

const normalizeTelebirrStatus = (rawStatus) => {
  const value = String(rawStatus || '').toLowerCase();
  if (!value) return 'pending';
  if (['success', 'completed', 'paid', 'succeeded', 'finished'].includes(value)) {
    return 'completed';
  }
  if (['failed', 'cancelled', 'canceled', 'declined'].includes(value)) {
    return 'failed';
  }
  return 'pending';
};

const mapTelebirrStatusToOrderStatus = (normalizedStatus) => {
  if (normalizedStatus === 'completed') return 'Paid';
  if (normalizedStatus === 'failed') return 'Failed';
  return 'Pending';
};

function isWebhookAuthorized(req) {
  const configuredSecret = String(process.env.TELEBIRR_WEBHOOK_SECRET || '').trim();

  // Keep compatibility for existing integrations when no secret is configured.
  if (!configuredSecret) {
    return true;
  }

  const providedSecret = String(req.get('x-telebirr-webhook-secret') || '').trim();
  if (!providedSecret) {
    return false;
  }

  const expected = Buffer.from(configuredSecret, 'utf8');
  const received = Buffer.from(providedSecret, 'utf8');

  if (expected.length !== received.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, received);
}

async function persistOrderPaymentStatus(orderId, transactionId, normalizedStatus, amount) {
  if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
    return;
  }

  const update = {
    status: mapTelebirrStatusToOrderStatus(normalizedStatus),
    paymentMethod: 'telebirr',
    paymentProvider: 'telebirr',
    paymentStatus: normalizedStatus,
    paymentTransactionId: transactionId || '',
  };

  if (normalizedStatus === 'completed') {
    update.paymentPaidAt = new Date();
  }

  if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) {
    update.totalPrice = amount;
  }

  await Order.findByIdAndUpdate(orderId, { $set: update });
}

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
    const { amount, phoneNumber, orderId, customerName, description, clientType, platform } = req.body;

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

    const finalOrderId = orderId || `ORDER_${Date.now()}`;
    const requestId = `${finalOrderId}-${Date.now()}`;

    // CHECK FOR MOCK MODE FIRST
    const useMockService = process.env.USE_MOCK_TELEBIRR === 'true';
    console.log('USE_MOCK_TELEBIRR:', useMockService);
    
    if (useMockService) {
      console.log('🎭 Using MOCK Telebirr service for testing...');
      
      // Simulate processing delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const mockOrderId = finalOrderId;
      const mockTransactionId = `TXN_${Date.now()}`;
      const mockPrepayId = `PREPAY_${Date.now()}`;
      
      const mockPaymentData = {
        paymentUrl: `https://mock-telebirr.com/pay?amount=${amount}&phone=${phoneNumber}&order=${mockOrderId}`,
        payment_url: `https://mock-telebirr.com/pay?amount=${amount}&phone=${phoneNumber}&order=${mockOrderId}`,
        checkout_url: `https://mock-telebirr.com/pay?amount=${amount}&phone=${phoneNumber}&order=${mockOrderId}`,
        orderId: mockOrderId,
        amount: amount,
        customerName: customerName,
        phoneNumber: phoneNumber,
        transactionId: mockTransactionId,
        prepayId: mockPrepayId,
        isMock: true
      };
      
      console.log('✅ Mock payment data generated:', mockPaymentData);
      
      paymentStatusStore.set(mockTransactionId, {
        transactionId: mockTransactionId,
        orderId: mockOrderId,
        status: 'completed',
        timestamp: new Date().toISOString(),
        isMock: true,
      });

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
      clientType: clientType || platform || 'web',
    };

    const serviceReq = {
      body: {
        title: orderData.title,
        amount: orderData.amount,
        clientType: orderData.clientType,
      }
    };

    let paymentResult = null;
    const serviceRes = {
      json: (data) => {
        paymentResult = data;
      },
      status: () => ({
        json: (data) => {
          throw new Error(data.error || 'Payment creation failed');
        }
      })
    };

    await withTimeout(
      createOrderService.createOrder(serviceReq, serviceRes),
      getInitiationTimeoutMs(),
      'Telebirr initiate-payment timed out while preparing checkout URL'
    );

    const transactionId = paymentResult.prepay_id;
    const urls = toTelebirrLinks(paymentResult);

    const readyState = {
      requestId,
      orderId: finalOrderId,
      amount,
      phoneNumber,
      customerName,
      description,
      status: 'ready',
      createdAt: new Date().toISOString(),
      prepayId: paymentResult.prepay_id,
      transactionId,
      ...urls,
    };

    pendingTelebirrRequests.set(requestId, readyState);

    paymentStatusStore.set(transactionId, {
      transactionId,
      orderId: finalOrderId,
      status: 'pending',
      timestamp: new Date().toISOString(),
      isMock: false,
      prepayId: paymentResult.prepay_id,
      requestId,
      ...urls,
    });

    paymentStatusStore.set(finalOrderId, {
      transactionId,
      orderId: finalOrderId,
      status: 'pending',
      timestamp: new Date().toISOString(),
      isMock: false,
      prepayId: paymentResult.prepay_id,
      requestId,
      ...urls,
    });

    return res.status(200).json({
      success: true,
      message: 'Payment initiated successfully',
      data: readyState,
      ...urls,
      prepay_id: paymentResult.prepay_id,
      transactionId,
      requestId,
      orderId: finalOrderId,
      status: 'pending',
    });

  } catch (error) {
    console.error('❌ Telebirr payment initiation error:', error);
    const mapped = classifyTelebirrError(error);

    res.status(mapped.status).json({
      success: false,
      code: mapped.code,
      message: mapped.message,
      details: mapped.details,
      canSwitchPaymentMethod: mapped.status === 503,
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
async function verifyPaymentHandler(req, res) {
  try {
    console.log('📋 Verify payment request body:', req.body);
    console.log('📋 Verify payment headers:', req.headers);

    const payload = req.body?.payload || {};
    const requestId = req.body?.requestId || payload.requestId;
    const transactionId = req.body?.transactionId || payload.transactionId;
    const orderId = req.body?.orderId || payload.orderId;

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

    const lookupKey = transactionId || orderId;
    const storedByDirectKey = lookupKey ? paymentStatusStore.get(lookupKey) : null;
    const storedByRequest = requestId ? pendingTelebirrRequests.get(requestId) : null;
    const storedByOrder = orderId ? findPendingByOrderId(orderId) : null;
    const stored = storedByDirectKey || storedByRequest || storedByOrder;

    if (!stored) {
      return res.status(202).json({
        success: true,
        message: 'Payment is pending confirmation',
        data: {
          transactionId,
          orderId,
          requestId,
          status: 'pending',
          timestamp: new Date().toISOString(),
        },
      });
    }

    const urls = toTelebirrLinks(stored);

    return res.json({
      success: true,
      message: 'Payment verification fetched',
      data: {
        ...stored,
        ...urls,
      },
      ...urls,
    });

  } catch (error) {
    console.error('❌ Payment verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify payment'
    });
  }
}

router.post('/verify-payment', verifyPaymentHandler);
router.post('/verify', verifyPaymentHandler);
router.post('/check-status', verifyPaymentHandler);
router.post('/payment-status', verifyPaymentHandler);

router.get('/verify/:transactionId', (req, res) => {
  req.body = { ...(req.body || {}), transactionId: req.params.transactionId };
  return verifyPaymentHandler(req, res);
});

/**
 * @swagger
 * /api/v1/telebirr/initiation-status/{requestId}:
 *   get:
 *     summary: Check Telebirr payment preparation status
 *     tags: [Telebirr]
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: string
 *         description: Request ID returned from initiate-payment
 *     responses:
 *       200:
 *         description: Current preparation status
 *       404:
 *         description: Request not found
 */
router.get('/initiation-status/:requestId', async (req, res) => {
  const { requestId } = req.params;
  const requestState = pendingTelebirrRequests.get(requestId);

  if (!requestState) {
    return res.status(404).json({
      success: false,
      message: 'Telebirr initiation request not found.',
    });
  }

  return res.status(200).json({
    success: true,
    data: requestState,
  });
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

    const stored = paymentStatusStore.get(transactionId);

    if (!stored) {
      return res.status(202).json({
        success: true,
        data: {
          transactionId,
          status: 'pending',
          timestamp: new Date().toISOString(),
        },
      });
    }

    res.json({
      success: true,
      data: stored
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

    if (!isWebhookAuthorized(req)) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized webhook request',
      });
    }
    
    // Process the webhook data
    const { transactionId, status, amount, orderId, prepay_id, prepayId } = req.body;

    const resolvedTransactionId = transactionId || prepay_id || prepayId;
    const resolvedStatus = normalizeTelebirrStatus(status);

    if (resolvedTransactionId) {
      const current = paymentStatusStore.get(resolvedTransactionId) || {};
      paymentStatusStore.set(resolvedTransactionId, {
        ...current,
        transactionId: resolvedTransactionId,
        orderId: orderId || current.orderId || null,
        amount: amount || current.amount || null,
        status: resolvedStatus,
        timestamp: new Date().toISOString(),
        isMock: false,
      });
    }

    await persistOrderPaymentStatus(orderId, resolvedTransactionId, resolvedStatus, amount);
    
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