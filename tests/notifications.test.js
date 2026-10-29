const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { Expo } = require('expo-server-sdk');
const authJwt = require('../helpers/jwt');
const errorHandler = require('../helpers/error-handler');
const router = require('../routers/notifications');
const { saveNotifications } = require('../helpers/notification-inbox');
const { sendPushToUser, sendPushToTokens } = require('../helpers/push-notify');
const { getModelsForDb } = require('../helpers/db-manager');

const userId = '000000000000000000000001';
const otherUserId = '000000000000000000000002';
const notificationId = '000000000000000000000003';

function fixture() {
  const saved = [];
  const Notification = {
    insertMany: async (items) => saved.push(...items),
  };
  const users = [
    { _id: userId, pushTokens: [], expoPushTokens: [] },
    { _id: otherUserId, pushTokens: [], expoPushTokens: [] },
  ];
  const User = {
    db: { models: { Notification } },
    findById: (id) => ({ select: async () => users.find((user) => String(user._id) === String(id)) }),
    find: (filter) => ({
      select: async () => filter._id ? users.filter((user) => filter._id.$in.includes(user._id)) : users,
    }),
  };
  return { saved, User, Notification, users };
}

async function serve(t, models, auth = { userId }) {
  const previousSecret = process.env.secret;
  process.env.secret = 'notification-test-only-secret';
  const app = express();
  app.use(express.json());
  app.use(authJwt());
  app.use((req, res, next) => { req.dbModels = models; next(); });
  app.use('/api/v1/notifications', router);
  app.use(errorHandler);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const token = jwt.sign(auth, process.env.secret);
  t.after(() => {
    server.closeAllConnections();
    server.close();
    if (previousSecret === undefined) delete process.env.secret;
    else process.env.secret = previousSecret;
  });
  return async (path, method = 'GET', body, authenticated = true) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/notifications${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}

test('notification models and saved recipients stay within the selected database', async () => {
  const first = getModelsForDb('E_Shopping');
  const second = getModelsForDb('E_ShopUSA');
  assert.notEqual(first.Notification, second.Notification);
  assert.equal(first.User.db, first.Notification.db);
  assert.equal(second.User.db, second.Notification.db);
  const { User, saved } = fixture();
  await saveNotifications({ User, userIds: [userId, new mongoose.Types.ObjectId(userId)], title: 'Update', body: 'Details' });
  assert.deepEqual(saved.map((item) => item.user), [userId]);
});

test('business events persist for website-only users and keep mobile Expo payloads unchanged', async (t) => {
  const { User, saved, users } = fixture();
  const send = t.mock.method(Expo.prototype, 'sendPushNotificationsAsync', async () => [{ status: 'ok', id: 'ticket' }]);
  const message = { User, userId, title: 'Order update', body: 'Ready', data: { orderId: 'order-1' } };
  assert.deepEqual(await sendPushToUser(message), { sent: 0 });
  assert.equal(saved.length, 1);
  assert.equal(send.mock.calls.length, 0);
  users[0].pushTokens = ['ExponentPushToken[test-device]'];
  users[0].expoPushTokens = ['ExponentPushToken[test-device]'];
  assert.deepEqual(await sendPushToUser(message), { sent: 1 });
  assert.equal(saved.length, 2);
  const [push] = send.mock.calls[0].arguments[0];
  assert.deepEqual(push, {
    to: 'ExponentPushToken[test-device]', sound: 'default',
    title: message.title, body: message.body, data: message.data, priority: 'high',
  });
  await sendPushToTokens({ ...message, tokens: [] });
  assert.equal(saved.length, 3);
  assert.equal(saved[2].user, userId);
});

test('inbox failures are reported without blocking mobile delivery or rejecting business operations', async (t) => {
  const { User, Notification, users } = fixture();
  users[0].pushTokens = ['ExponentPushToken[test-device]'];
  Notification.insertMany = async () => { throw new Error('Inbox storage unavailable'); };
  const send = t.mock.method(Expo.prototype, 'sendPushNotificationsAsync', async () => [{ status: 'ok', id: 'ticket' }]);
  const log = t.mock.method(console, 'error', () => {});
  const result = await sendPushToUser({ User, userId, title: 'Update', body: 'Ready' });
  assert.equal(result.sent, 1);
  assert.equal(result.error, 'Inbox storage unavailable');
  assert.equal(send.mock.calls.length, 1);
  assert.ok(log.mock.calls.some((call) => call.arguments[0] === 'Notification inbox save failed:'));
});

test('inbox requires login, validates cursor and returns newest-first pages with total unread count', async (t) => {
  const { User, Notification } = fixture();
  let receivedFilter;
  Notification.find = (filter) => {
    receivedFilter = filter;
    return { sort: (sort) => {
      assert.deepEqual(sort, { _id: -1 });
      return { limit: (limit) => {
        assert.equal(limit, 21);
        return { lean: async () => Array.from({ length: 21 }, (_, index) => ({
          _id: String(100 - index).padStart(24, '0'), title: 'Update', body: 'Details',
          data: {}, isRead: false, createdAt: new Date(), user: userId,
        })) };
      } };
    } };
  };
  Notification.countDocuments = async (filter) => {
    assert.deepEqual(filter, { user: userId, isRead: false });
    return 40;
  };
  const call = await serve(t, { User, Notification });
  assert.equal((await call('/inbox', 'GET', null, false)).status, 401);
  assert.equal((await call('/inbox?before=invalid')).status, 400);
  const result = await call(`/inbox?before=${notificationId}&userId=${otherUserId}`);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(receivedFilter, { user: userId, _id: { $lt: notificationId } });
  assert.equal(result.body.notifications.length, 20);
  assert.equal(result.body.unreadCount, 40);
  assert.equal(result.body.nextCursor, result.body.notifications.at(-1).id);
  assert.equal('user' in result.body.notifications[0], false);
});

test('read actions are idempotent and owner-scoped, including for admins', async (t) => {
  const { Notification } = fixture();
  Notification.findOneAndUpdate = async (filter, update, options) => {
    assert.deepEqual(filter, { _id: notificationId, user: userId });
    assert.deepEqual(update, { $set: { isRead: true } });
    assert.equal(options.new, true);
    return null;
  };
  let readAllFilter;
  Notification.updateMany = async (filter) => { readAllFilter = filter; };
  const call = await serve(t, { Notification }, { userId, isAdmin: true });
  assert.equal((await call('/inbox/bad-id/read', 'PUT')).status, 400);
  assert.equal((await call(`/inbox/${notificationId}/read`, 'PUT')).status, 404);
  Notification.findOneAndUpdate = async () => ({ _id: notificationId, isRead: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual((await call(`/inbox/${notificationId}/read`, 'PUT')).body, { id: notificationId, isRead: true });
  }
  assert.equal((await call('/inbox/read-all', 'PUT')).status, 200);
  assert.deepEqual(readAllFilter, { user: userId, isRead: false });
});

test('admin send-user, send-many, broadcast and self-send reach inboxes without any Expo tokens', async (t) => {
  const { User, Notification, saved } = fixture();
  const call = await serve(t, { User, Notification }, { userId, isAdmin: true });
  const content = { title: 'News', body: 'Hello', data: { type: 'announcement' } };
  for (const [path, recipients] of [
    ['/send', { userId }],
    ['/admin/send-user', { userId: otherUserId }],
    ['/admin/send-many', { userIds: [userId, userId, otherUserId] }],
    ['/admin/broadcast', {}],
  ]) {
    const result = await call(path, 'POST', { ...content, ...recipients });
    assert.equal(result.status, 200);
    assert.equal(result.body.sent, 0);
    assert.deepEqual(result.body.tickets, []);
  }
  assert.equal(saved.length, 6);
  assert.ok(saved.every((item) => item.title === content.title && item.data.type === 'announcement'));
  assert.equal((await call('/admin/send-user', 'POST', { ...content, userId: 'bad' })).status, 400);
  assert.equal((await call('/admin/broadcast', 'POST', { title: ' ', body: 'Hello' })).status, 400);
});

test('send permissions prevent non-admins notifying other users or broadcasting', async (t) => {
  const { User, Notification, saved } = fixture();
  const call = await serve(t, { User, Notification });
  const body = { title: 'News', body: 'Hello', userId: otherUserId };
  assert.equal((await call('/send', 'POST', body)).status, 403);
  assert.equal((await call('/admin/broadcast', 'POST', body)).status, 403);
  assert.equal(saved.length, 0);
});

test('inbox and send storage failures propagate to the API error handler', async (t) => {
  const { User, Notification } = fixture();
  Notification.insertMany = async () => { throw new Error('Inbox storage unavailable'); };
  Notification.updateMany = async () => { throw new Error('Inbox storage unavailable'); };
  const call = await serve(t, { User, Notification });
  const result = await call('/send', 'POST', { userId, title: 'News', body: 'Hello' });
  assert.equal(result.status, 500);
  assert.equal(result.body.message, 'Inbox storage unavailable');
  assert.equal((await call('/inbox/read-all', 'PUT')).status, 500);
});
