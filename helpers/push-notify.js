const { Expo } = require("expo-server-sdk");

const expo = new Expo();

// Shared Expo push sender used by routers/orders.js and service/dispatchService.js.
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

    if (!user || uniqueTokens.length === 0) {
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

module.exports = { sendPushToUser };
