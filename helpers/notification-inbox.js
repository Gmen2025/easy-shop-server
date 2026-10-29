const { notificationSchema } = require('../models/notification');

async function saveNotifications({ User, userIds, title, body, data = {} }) {
  const recipients = [...new Set(userIds.map(String))];
  if (!recipients.length) return 0;

  // Use the sender's connection, not the default database, for tenant isolation.
  const Notification = User.db.models.Notification || User.db.model('Notification', notificationSchema);
  await Notification.insertMany(recipients.map((user) => ({ user, title, body, data })));
  return recipients.length;
}

module.exports = { saveNotifications };
