const express = require('express');
const router = express.Router();
const { Expo } = require('expo-server-sdk');
const mongoose = require('mongoose');
const { saveNotifications } = require('../helpers/notification-inbox');

const expo = new Expo();

const getUserModel = (req) => req.dbModels?.User;
const getDriverModel = (req) => req.dbModels?.Driver;

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

const validateNotification = (req, res, next) => {
  const { title, body, data } = req.body || {};
  if (typeof title !== 'string' || !title.trim() || typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ message: 'A non-empty title and body are required' });
  }
  if (data !== undefined && (data === null || typeof data !== 'object' || Array.isArray(data))) {
    return res.status(400).json({ message: 'Notification data must be an object' });
  }
  next();
};

const sendToTokens = async ({ tokens, title, body, data }) => {
  console.log('[PushNotification] sendToTokens called', {
    tokenCount: Array.isArray(tokens) ? tokens.length : 0,
    tokens,
    title,
  });

  const messages = [];
  for (const pushToken of tokens) {
    if (!Expo.isExpoPushToken(pushToken)) {
      console.log('[PushNotification] Skipping invalid token', { pushToken });
      continue;
    }

    console.log('[PushNotification] Queueing token', { pushToken });

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

const getUserTokens = (user) => {
  const tokens = [
    ...(Array.isArray(user?.pushTokens) ? user.pushTokens : []),
    ...(Array.isArray(user?.expoPushTokens) ? user.expoPushTokens : []),
  ];

  return [...new Set(tokens)].filter((token) => Expo.isExpoPushToken(token));
};

const getDriverTokens = (driver) =>
  [...new Set(Array.isArray(driver?.pushTokens) ? driver.pushTokens : [])].filter((token) =>
    Expo.isExpoPushToken(token)
  );

router.use('/inbox', (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.auth?.userId)) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  if (!req.dbModels?.Notification) {
    return res.status(500).json({ message: 'Notification model is not available' });
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.get('/inbox', async (req, res, next) => {
  try {
    const { Notification } = req.dbModels;
    const { before } = req.query;
    if (before !== undefined && !mongoose.isObjectIdOrHexString(before)) {
      return res.status(400).json({ message: 'Invalid notification cursor' });
    }
    const user = req.auth.userId;
    const filter = { user, ...(before ? { _id: { $lt: before } } : {}) };
    const [items, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ _id: -1 }).limit(21).lean(),
      Notification.countDocuments({ user, isRead: false }),
    ]);
    const hasMore = items.length > 20;
    const notifications = items.slice(0, 20).map(({ _id, title, body, data, isRead, createdAt }) => ({
      id: String(_id), title, body, data, isRead, createdAt,
    }));
    return res.json({
      notifications,
      unreadCount,
      nextCursor: hasMore ? notifications.at(-1).id : null,
    });
  } catch (error) {
    next(error);
  }
});

router.put('/inbox/read-all', async (req, res, next) => {
  try {
    await req.dbModels.Notification.updateMany(
      { user: req.auth.userId, isRead: false }, { $set: { isRead: true } }
    );
    return res.json({ message: 'Notifications marked as read' });
  } catch (error) {
    next(error);
  }
});

router.put('/inbox/:notificationId/read', async (req, res, next) => {
  try {
    if (!mongoose.isObjectIdOrHexString(req.params.notificationId)) {
      return res.status(400).json({ message: 'Invalid notification ID' });
    }
    const item = await req.dbModels.Notification.findOneAndUpdate(
      { _id: req.params.notificationId, user: req.auth.userId },
      { $set: { isRead: true } }, { new: true }
    );
    if (!item) return res.status(404).json({ message: 'Notification not found' });
    return res.json({ id: String(item._id), isRead: item.isRead });
  } catch (error) {
    next(error);
  }
});

router.put('/drivers/:driverId/push-token', async (req, res) => {
  const Driver = getDriverModel(req);
  const { driverId } = req.params;
  const { pushToken } = req.body || {};

  if (!Driver) {
    return res.status(500).json({ message: 'Driver model is not available' });
  }

  if (!pushToken || !Expo.isExpoPushToken(pushToken)) {
    return res.status(400).json({ message: 'A valid Expo pushToken is required' });
  }

  const driver = await Driver.findById(driverId);
  if (!driver) {
    return res.status(404).json({ message: 'Driver not found' });
  }

  if (!Array.isArray(driver.pushTokens)) {
    driver.pushTokens = [];
  }
  if (!driver.pushTokens.includes(pushToken)) {
    driver.pushTokens.push(pushToken);
    await driver.save();
  }

  return res.json({
    message: 'Driver push token saved',
    driverId,
    totalTokens: driver.pushTokens.length,
  });
});

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

  console.log('[PushToken] Received token for user', {
    userId,
    pushToken,
  });

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  if (!user.pushTokens.includes(pushToken)) {
    user.pushTokens.push(pushToken);
  }

  if (!Array.isArray(user.expoPushTokens)) {
    user.expoPushTokens = [];
  }

  if (!user.expoPushTokens.includes(pushToken)) {
    user.expoPushTokens.push(pushToken);
  }

  await user.save();

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
  if (Array.isArray(user.expoPushTokens)) {
    user.expoPushTokens = user.expoPushTokens.filter((t) => t !== pushToken);
  }
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
router.post('/send', validateNotification, async (req, res, next) => {
  const User = getUserModel(req);
  const { userId, title, body, data } = req.body || {};

  if (!User) {
    return res.status(500).json({ message: 'User model is not available' });
  }

  if (!mongoose.isObjectIdOrHexString(userId)) {
    return res.status(400).json({ message: 'A valid userId is required' });
  }

  if (!canManageUserTokens(req, userId)) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  try {
    const user = await User.findById(userId).select('pushTokens expoPushTokens');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const [result] = await Promise.all([
      sendToTokens({ tokens: getUserTokens(user), title, body, data }),
      saveNotifications({ User, userIds: [user._id], title, body, data }),
    ]);
    return res.json({ message: 'Push request processed', ...result });
  } catch (error) {
    return next(error);
  }
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
router.post('/admin/send-user', requireAdmin, validateNotification, async (req, res, next) => {
  const User = getUserModel(req);
  const { userId, title, body, data } = req.body || {};

  if (!User) {
    return res.status(500).json({ message: 'User model is not available' });
  }

  if (!mongoose.isObjectIdOrHexString(userId)) {
    return res.status(400).json({ message: 'A valid userId is required' });
  }

  try {
    const user = await User.findById(userId).select('pushTokens expoPushTokens');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const [result] = await Promise.all([
      sendToTokens({ tokens: getUserTokens(user), title, body, data: data || {} }),
      saveNotifications({ User, userIds: [user._id], title, body, data }),
    ]);

    return res.json({ message: 'Admin notification processed', ...result });
  } catch (error) {
    return next(error);
  }
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
router.post('/admin/send-many', requireAdmin, validateNotification, async (req, res, next) => {
  const User = getUserModel(req);
  const { userIds = [], title, body, data } = req.body || {};

  if (!User) {
    return res.status(500).json({ message: 'User model is not available' });
  }

  if (!Array.isArray(userIds) || userIds.length === 0 || !userIds.every((id) => mongoose.isObjectIdOrHexString(id))) {
    return res.status(400).json({ message: 'userIds must be a non-empty array of valid user IDs' });
  }

  try {
    const users = await User.find({ _id: { $in: userIds } }).select('pushTokens expoPushTokens');
    const tokens = users.flatMap((user) => getUserTokens(user));

    const [result] = await Promise.all([
      sendToTokens({ tokens, title, body, data: data || {} }),
      saveNotifications({ User, userIds: users.map((user) => user._id), title, body, data }),
    ]);

    return res.json({ message: 'Bulk admin notification processed', ...result });
  } catch (error) {
    return next(error);
  }
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
router.post('/admin/broadcast', requireAdmin, validateNotification, async (req, res, next) => {
  const User = getUserModel(req);
  const { title, body, data } = req.body || {};

  if (!User) {
    return res.status(500).json({ message: 'User model is not available' });
  }

  if (!title || !body) {
    return res.status(400).json({ message: 'title and body are required' });
  }

  try {
    const users = await User.find({}).select('pushTokens expoPushTokens');
    const tokens = users.flatMap((user) => getUserTokens(user));

    console.log('[PushNotification] Broadcast prepared', {
      userCount: users.length,
      tokenCount: tokens.length,
      tokens,
      title,
    });

    const [result] = await Promise.all([
      sendToTokens({ tokens, title, body, data: data || {} }),
      saveNotifications({ User, userIds: users.map((user) => user._id), title, body, data }),
    ]);

    return res.json({ message: 'Broadcast notification processed', ...result });
  } catch (error) {
    return next(error);
  }
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

  const user = await User.findById(userId).select('name email pushTokens expoPushTokens');
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const tokens = getUserTokens(user);

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
