const { Expo } = require("expo-server-sdk");
const { saveNotifications } = require("./notification-inbox");

const expo = new Expo();

async function sendExpoPush({ tokens = [], title, body, data = {} }) {
  try {
    const uniqueTokens = [...new Set(tokens)].filter((token) => Expo.isExpoPushToken(token));
    if (!uniqueTokens.length || !title || !body) {
      return { sent: 0 };
    }

    const messages = uniqueTokens.map((token) => ({
      to: token,
      sound: "default",
      title,
      body,
      data,
      priority: "high",
    }));

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }

    return { sent: messages.length };
  } catch (error) {
    console.error("Push send failed:", error?.message || error);
    return { sent: 0 };
  }
}

async function sendPushToTokens({ tokens = [], title, body, data = {}, User, userId }) {
  const inboxDelivery = User && userId
    ? saveNotifications({ User, userIds: [userId], title, body, data })
    : Promise.resolve();
  const [result, inboxError] = await Promise.all([
    sendExpoPush({ tokens, title, body, data }),
    inboxDelivery.then(() => null, (error) => {
      console.error("Notification inbox save failed:", error?.message || error);
      return error;
    }),
  ]);
  return inboxError ? { ...result, error: inboxError.message || String(inboxError) } : result;
}

// Shared inbox and Expo sender used by business notification events.
async function sendPushToUser({ User, userId, title, body, data = {} }) {
  try {
    if (!User || !userId || !title || !body) {
      return { sent: 0 };
    }

    const user = await User.findById(userId).select("pushTokens expoPushTokens");
    const tokens = [
      ...(Array.isArray(user?.pushTokens) ? user.pushTokens : []),
      ...(Array.isArray(user?.expoPushTokens) ? user.expoPushTokens : []),
    ];

    const uniqueTokens = [...new Set(tokens)].filter((token) => Expo.isExpoPushToken(token));

    if (!user) {
      return { sent: 0 };
    }

    return await sendPushToTokens({ tokens: uniqueTokens, title, body, data, User, userId });
  } catch (error) {
    console.error("Push send failed:", error?.message || error);
    return { sent: 0, error: error?.message || String(error) };
  }
}

module.exports = { sendPushToUser, sendPushToTokens };
