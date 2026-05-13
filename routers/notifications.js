const express = require('express');
const router = express.Router();
const { Expo } = require('expo-server-sdk');
const { User } = require('../models/user');

const expo = new Expo();

// ── User push-token routes ────────────────────────────────────────────────────
/**
 * @swagger
 * /users/{userId}/push-token:
 *   put:
 *     summary: Register an Expo push token for a user
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         schema:
 *           type: string
 *         required: true
 *         description: User ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pushToken]
 *             properties:
 *               pushToken:
 *                 type: string
 *                 description: Expo push token
 *     responses:
 *       200:
 *         description: Push token saved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 userId:
 *                   type: string
 *                 totalTokens:
 *                   type: integer
 *       400:
 *         description: Invalid input
 *       404:
 *         description: User not found
 */
router.put('/:userId/push-token', async (req, res) => {
  const { userId } = req.params;
  const { pushToken } = req.body || {};

  if (!pushToken || typeof pushToken !== 'string') {
    return res.status(400).json({ message: 'pushToken is required' });
  }

  if (!Expo.isExpoPushToken(pushToken)) {
    return res.status(400).json({ message: 'Invalid Expo push token' });
  }

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  if (!user.pushTokens.includes(pushToken)) {
    user.pushTokens.push(pushToken);
    await user.save();
  }

  return res.json({
    message: 'Push token saved',
    userId,
    totalTokens: user.pushTokens.length,
  });
});

/**
 * @swagger
 * /users/{userId}/push-token:
 *   delete:
 *     summary: Remove an Expo push token for a user
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         schema:
 *           type: string
 *         required: true
 *         description: User ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pushToken]
 *             properties:
 *               pushToken:
 *                 type: string
 *                 description: Expo push token
 *     responses:
 *       200:
 *         description: Token removal processed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 removed:
 *                   type: boolean
 *       400:
 *         description: Invalid input
 *       404:
 *         description: User not found
 */
router.delete('/:userId/push-token', async (req, res) => {
  const { userId } = req.params;
  const { pushToken } = req.body || {};

  if (!pushToken) {
    return res.status(400).json({ message: 'pushToken is required' });
  }

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const before = user.pushTokens.length;
  user.pushTokens = user.pushTokens.filter((t) => t !== pushToken);
  const removed = user.pushTokens.length < before;

  if (removed) {
    await user.save();
  }

  return res.json({ message: 'Token removal processed', removed });
});

// ── Notification send/health routes ──────────────────────────────────────────
/**
 * @swagger
 * /notifications/send:
 *   post:
 *     summary: Send a push notification to all registered tokens for a user
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, title, body]
 *             properties:
 *               userId:
 *                 type: string
 *               title:
 *                 type: string
 *               body:
 *                 type: string
 *               data:
 *                 type: object
 *                 description: Optional custom data
 *     responses:
 *       200:
 *         description: Push request processed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 sent:
 *                   type: integer
 *                 tickets:
 *                   type: array
 *                   items:
 *                     type: object
 *                 receiptIds:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: Invalid input or no valid tokens
 *       404:
 *         description: User or tokens not found
 */
router.post('/send', async (req, res) => {
  const { userId, title, body, data } = req.body || {};

  if (!userId || !title || !body) {
    return res.status(400).json({ message: 'userId, title, and body are required' });
  }

  const user = await User.findById(userId).select('pushTokens');
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const tokens = user.pushTokens || [];
  if (tokens.length === 0) {
    return res.status(404).json({ message: 'No push tokens registered for this user' });
  }

  const messages = [];
  for (const pushToken of tokens) {
    if (!Expo.isExpoPushToken(pushToken)) continue;
    messages.push({
      to: pushToken,
      sound: 'default',
      title,
      body,
      data: data || {},
      priority: 'high',
    });
  }

  if (messages.length === 0) {
    return res.status(400).json({ message: 'No valid Expo tokens to send' });
  }

  const chunks = expo.chunkPushNotifications(messages);
  const tickets = [];

  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    } catch (error) {
      console.error('Error sending push chunk:', error);
    }
  }

  const receiptIds = tickets
    .filter((ticket) => ticket.status === 'ok' && ticket.id)
    .map((ticket) => ticket.id);

  return res.json({
    message: 'Push request processed',
    sent: messages.length,
    tickets,
    receiptIds,
  });
});

/**
 * @swagger
 * /notifications/health:
 *   get:
 *     summary: Health check for notifications API
 *     tags: [Notifications]
 *     responses:
 *       200:
 *         description: Health check OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 */
router.get('/health', (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
