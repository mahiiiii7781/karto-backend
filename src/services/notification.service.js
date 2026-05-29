import admin from "firebase-admin";
import prisma from "../prisma.js";

let firebaseReady = false;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    firebaseReady = true;
    console.log("Firebase initialized");
  } else {
    console.log("Firebase service account missing");
  }
} catch (error) {
  console.error("Firebase Init Error:", error.message);
}

export const saveNotification = async ({
  userId,
  type = "SYSTEM",
  title,
  body,
  data = {},
}) => {
  return prisma.notification.create({
    data: {
      userId,
      type,
      title,
      body,
      data,
    },
  });
};

export const sendPushToUser = async ({
  userId,
  type = "SYSTEM",
  title,
  body,
  data = {},
}) => {
  await saveNotification({
    userId,
    type,
    title,
    body,
    data,
  });

  const tokens = await prisma.pushToken.findMany({
    where: {
      userId,
      isActive: true,
    },
  });

  if (!firebaseReady || !tokens.length) {
    return {
      success: false,
      message: "Notification saved, push not sent",
    };
  }

  const payload = {
    notification: {
      title,
      body,
    },
    data: Object.fromEntries(
      Object.entries(data || {}).map(([key, value]) => [key, String(value)])
    ),
    tokens: tokens.map(t => t.token),
  };

  const response = await admin.messaging().sendEachForMulticast(payload);

  const failedTokens = [];

  response.responses.forEach((res, index) => {
    if (!res.success) {
      failedTokens.push(tokens[index].token);
    }
  });

  if (failedTokens.length) {
    await prisma.pushToken.updateMany({
      where: {
        token: { in: failedTokens },
      },
      data: {
        isActive: false,
      },
    });
  }

  return {
    success: true,
    sent: response.successCount,
    failed: response.failureCount,
  };
};

export const notificationTemplates = {
  ORDER_PLACED_VENDOR: restaurantName => ({
    title: "New order received 🛎️",
    body: `A fresh order just came in for ${restaurantName}. Please accept it quickly.`,
  }),

  ORDER_PLACED_CUSTOMER: () => ({
    title: "Order placed successfully 🎉",
    body: "Your order is received. The store will start preparing it soon.",
  }),

  ORDER_ACCEPTED_CUSTOMER: restaurantName => ({
    title: "Order accepted ✅",
    body: `${restaurantName} accepted your order. Fresh food is on the way soon.`,
  }),

  ORDER_PREPARING_CUSTOMER: () => ({
    title: "Your order is being prepared 👨‍🍳",
    body: "The store has started preparing your order with care.",
  }),

  ORDER_READY_VENDOR: () => ({
    title: "Order ready for pickup 📦",
    body: "Your order is ready. Waiting for rider pickup.",
  }),

  ORDER_ASSIGNED_RIDER: () => ({
    title: "New delivery assigned 🛵",
    body: "You have a new order to pick up. Please reach the store on time.",
  }),

  ORDER_OUT_FOR_DELIVERY_CUSTOMER: () => ({
    title: "Out for delivery 🛵",
    body: "Your order is on the way. Please keep your phone nearby.",
  }),

  ORDER_DELIVERED_CUSTOMER: () => ({
    title: "Order delivered 💚",
    body: "Hope you loved it. Thanks for choosing Karto.",
  }),

  ORDER_CANCELLED_CUSTOMER: () => ({
    title: "Order cancelled",
    body: "Your order has been cancelled. Any eligible refund will be processed soon.",
  }),
};