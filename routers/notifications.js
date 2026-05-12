const express = require('express');
const router = express.Router();
const { Expo } = require('expo-server-sdk');
const { User } = require('../models/user');

const expo = new Expo();

// ── User push-token routes ────────────────────────────────────────────────────
// Mounted under ${api}/users → PUT  /api/v1/users/:userId/push-token
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

// DELETE /api/v1/users/:userId/push-token
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
// Mounted under ${api}/notifications → POST /api/v1/notifications/send
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

// GET /api/v1/notifications/health
router.get('/health', (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
