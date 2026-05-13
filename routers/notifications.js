const express = require('express');
const router = express.Router();
const { Expo } = require('expo-server-sdk');

const expo = new Expo();

const getUserModel = (req) => req.dbModels?.User;

const getAuthUser = (req) => req.auth || {};

const canManageUserTokens = (req, userId) => {
  const auth = getAuthUser(req);
  return auth?.isAdmin || String(auth?.userId || '') === String(userId);
};

const requireAdmin = (req, res, next) => {
  const auth = getAuthUser(req);
  if (!auth?.isAdmin) {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
};

const sendToTokens = async ({ tokens, title, body, data }) => {
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
    return { sent: 0, tickets: [], receiptIds: [] };
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

  return {
    sent: messages.length,
    tickets,
    receiptIds,
  };
};

// ── User push-token routes ────────────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/users/{userId}/push-token:
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
  const User = getUserModel(req);
  const { userId } = req.params;
  const { pushToken } = req.body || {};

  if (!User) {
    return res.status(500).json({ message: 'User model is not available' });
  }

  if (!canManageUserTokens(req, userId)) {
    return res.status(403).json({ message: 'Forbidden' });
  }

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
 * /api/v1/users/{userId}/push-token:
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
  const User = getUserModel(req);
  const { userId } = req.params;
  const { pushToken } = req.body || {};

  if (!User) {
    return res.status(500).json({ message: 'User model is not available' });
  }

  if (!canManageUserTokens(req, userId)) {
    return res.status(403).json({ message: 'Forbidden' });
  }

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
 * /api/v1/notifications/send:
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
  const User = getUserModel(req);
  const { userId, title, body, data } = req.body || {};

  if (!User) {
    return res.status(500).json({ message: 'User model is not available' });
  }

  if (!userId || !title || !body) {
    return res.status(400).json({ message: 'userId, title, and body are required' });
  }

  if (!canManageUserTokens(req, userId)) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const user = await User.findById(userId).select('pushTokens');
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const tokens = user.pushTokens || [];
  if (tokens.length === 0) {
    return res.status(404).json({ message: 'No push tokens registered for this user' });
  }

  const result = await sendToTokens({ tokens, title, body, data });
  if (result.sent === 0) {
    return res.status(400).json({ message: 'No valid Expo tokens to send' });
  }

  return res.json({
    message: 'Push request processed',
    sent: result.sent,
    tickets: result.tickets,
    receiptIds: result.receiptIds,
  });
});

/**
 * @swagger
 * /api/v1/notifications/admin/send-user:
 *   post:
 *     summary: Admin sends a push notification to one user
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
 *                 description: Optional custom payload
 *     responses:
 *       200:
 *         description: Admin notification processed
 *       400:
 *         description: Invalid request body
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User not found
 */
router.post('/admin/send-user', requireAdmin, async (req, res) => {
  const User = getUserModel(req);
  const { userId, title, body, data } = req.body || {};

  if (!User) {
    return res.status(500).json({ message: 'User model is not available' });
  }

  if (!userId || !title || !body) {
    return res.status(400).json({ message: 'userId, title, and body are required' });
  }

  const user = await User.findById(userId).select('pushTokens');
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const result = await sendToTokens({
    tokens: user.pushTokens || [],
    title,
    body,
    data: data || {},
  });

  return res.json({ message: 'Admin notification processed', ...result });
});

/**
 * @swagger
 * /api/v1/notifications/admin/send-many:
 *   post:
 *     summary: Admin sends a push notification to specific users
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userIds, title, body]
 *             properties:
 *               userIds:
 *                 type: array
 *                 items:
 *                   type: string
 *               title:
 *                 type: string
 *               body:
 *                 type: string
 *               data:
 *                 type: object
 *     responses:
 *       200:
 *         description: Bulk admin notification processed
 *       400:
 *         description: Invalid request body
 *       403:
 *         description: Admin access required
 */
router.post('/admin/send-many', requireAdmin, async (req, res) => {
  const User = getUserModel(req);
  const { userIds = [], title, body, data } = req.body || {};

  if (!User) {
    return res.status(500).json({ message: 'User model is not available' });
  }

  if (!Array.isArray(userIds) || userIds.length === 0 || !title || !body) {
    return res.status(400).json({ message: 'userIds[], title, and body are required' });
  }

  const users = await User.find({ _id: { $in: userIds } }).select('pushTokens');
  const tokens = users.flatMap((user) => user.pushTokens || []);

  const result = await sendToTokens({
    tokens,
    title,
    body,
    data: data || {},
  });

  return res.json({ message: 'Bulk admin notification processed', ...result });
});

/**
 * @swagger
 * /api/v1/notifications/admin/broadcast:
 *   post:
 *     summary: Admin broadcasts a push notification to all users with tokens
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, body]
 *             properties:
 *               title:
 *                 type: string
 *               body:
 *                 type: string
 *               data:
 *                 type: object
 *     responses:
 *       200:
 *         description: Broadcast notification processed
 *       400:
 *         description: Invalid request body
 *       403:
 *         description: Admin access required
 */
router.post('/admin/broadcast', requireAdmin, async (req, res) => {
  const User = getUserModel(req);
  const { title, body, data } = req.body || {};

  if (!User) {
    return res.status(500).json({ message: 'User model is not available' });
  }

  if (!title || !body) {
    return res.status(400).json({ message: 'title and body are required' });
  }

  const users = await User.find({}).select('pushTokens');
  const tokens = users.flatMap((user) => user.pushTokens || []);

  const result = await sendToTokens({
    tokens,
    title,
    body,
    data: data || {},
  });

  return res.json({ message: 'Broadcast notification processed', ...result });
});

/**
 * @swagger
 * /api/v1/notifications/admin/user/{userId}/tokens:
 *   get:
 *     summary: Admin checks stored push tokens for a specific user
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: Target user ID
 *     responses:
 *       200:
 *         description: User token details
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User not found
 */
router.get('/admin/user/:userId/tokens', requireAdmin, async (req, res) => {
  const User = getUserModel(req);
  const { userId } = req.params;

  if (!User) {
    return res.status(500).json({ message: 'User model is not available' });
  }

  const user = await User.findById(userId).select('name email pushTokens');
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const tokens = Array.isArray(user.pushTokens) ? user.pushTokens : [];

  return res.json({
    userId,
    name: user.name,
    email: user.email,
    tokenCount: tokens.length,
    tokens,
  });
});

/**
 * @swagger
 * /api/v1/notifications/health:
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
