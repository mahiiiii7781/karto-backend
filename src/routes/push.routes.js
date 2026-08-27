import express from "express";
import prisma from "../prisma.js";

import {
  protect,
} from "../middleware/auth.middleware.js";

import {
  firebaseMessaging,
} from "../config/firebase.js";

const router = express.Router();

/* =========================
   HELPERS
========================= */

const normalizeLimit = (
  value,
  fallback = 50,
  max = 100
) => {
  const num = Number(value);

  if (
    !Number.isFinite(num) ||
    num < 1
  ) {
    return fallback;
  }

  return Math.min(
    Math.trunc(num),
    max
  );
};

const normalizePage = (
  value
) => {
  const num = Number(value);

  if (
    !Number.isFinite(num) ||
    num < 1
  ) {
    return 1;
  }

  return Math.trunc(num);
};

const normalizeBool = (
  value,
  fallback = false
) => {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  if (
    typeof value === "boolean"
  ) {
    return value;
  }

  const normalized =
    String(value)
      .trim()
      .toLowerCase();

  if (
    [
      "true",
      "1",
      "yes",
      "y",
      "on",
    ].includes(normalized)
  ) {
    return true;
  }

  if (
    [
      "false",
      "0",
      "no",
      "n",
      "off",
    ].includes(normalized)
  ) {
    return false;
  }

  return fallback;
};

const cleanString = (
  value
) => {
  if (
    value === undefined ||
    value === null
  ) {
    return undefined;
  }

  return String(value).trim();
};

const normalizePlatform = (
  platform
) => {
  const value =
    String(platform || "")
      .trim()
      .toUpperCase();

  if (
    [
      "ANDROID",
      "IOS",
      "WEB",
    ].includes(value)
  ) {
    return value;
  }

  return value || null;
};

const getUnreadCount = async (
  userId
) => {
  return prisma.notification.count({
    where: {
      userId,
      isRead: false,
    },
  });
};

const getNotificationWhere = ({
  userId,
  unreadOnly = false,
  type,
}) => {
  return {
    userId,

    ...(unreadOnly
      ? {
          isRead: false,
        }
      : {}),

    ...(type &&
    type !== "ALL"
      ? {
          type,
        }
      : {}),
  };
};

const isInvalidFirebaseTokenError = (
  error
) => {
  const code =
    error?.code ||
    error?.errorInfo?.code ||
    "";

  return [
    "messaging/invalid-registration-token",
    "messaging/registration-token-not-registered",
    "messaging/invalid-argument",
  ].includes(code);
};

const deactivatePushToken = async (
  token
) => {
  if (!token) return;

  try {
    await prisma.pushToken.updateMany({
      where: {
        token,
      },
      data: {
        isActive: false,
      },
    });
  } catch (error) {
    console.error(
      "Deactivate Push Token Error:",
      error
    );
  }
};

const sendPushToToken = async ({
  token,
  title,
  body,
  data = {},
}) => {
  if (
    !firebaseMessaging ||
    !token
  ) {
    return {
      success: false,
      skipped: true,
    };
  }

  try {
    const messageId =
      await firebaseMessaging.send({
        token,

        notification: {
          title:
            String(
              title ||
                "KARTO"
            ),

          body:
            String(
              body || ""
            ),
        },

        data:
          Object.fromEntries(
            Object.entries(
              data || {}
            ).map(
              ([key, value]) => [
                String(key),
                String(
                  value ??
                    ""
                ),
              ]
            )
          ),

        android: {
          priority: "high",

          notification: {
            sound:
              "default",
          },
        },

        apns: {
          payload: {
            aps: {
              sound:
                "default",
            },
          },
        },
      });

    return {
      success: true,
      messageId,
    };
  } catch (error) {
    console.error(
      "Firebase Push Error:",
      error?.code ||
        error?.message ||
        error
    );

    if (
      isInvalidFirebaseTokenError(
        error
      )
    ) {
      await deactivatePushToken(
        token
      );
    }

    return {
      success: false,
      error,
    };
  }
};

export const sendPushToUser = async ({
  userId,
  title,
  body,
  data = {},
}) => {
  if (!userId) {
    return {
      success: false,
      sent: 0,
      failed: 0,
    };
  }

  const tokens =
    await prisma.pushToken.findMany({
      where: {
        userId,
        isActive: true,
      },

      select: {
        token: true,
      },
    });

  if (!tokens.length) {
    return {
      success: true,
      sent: 0,
      failed: 0,
    };
  }

  let sent = 0;
  let failed = 0;

  for (const item of tokens) {
    const result =
      await sendPushToToken({
        token: item.token,
        title,
        body,
        data,
      });

    if (result.success) {
      sent += 1;
    } else {
      failed += 1;
    }
  }

  return {
    success: true,
    sent,
    failed,
  };
};

/* =========================
   PUSH TOKEN
========================= */

router.post(
  "/register-token",
  protect,
  async (req, res) => {
    try {
      const token =
        cleanString(
          req.body?.token
        );

      const deviceId =
        cleanString(
          req.body?.deviceId
        );

      const platform =
        normalizePlatform(
          req.body?.platform
        );

      if (!token) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Push token is required",
          });
      }

      /*
        If the same physical device gets a new FCM token,
        disable the old token for that device first.
      */
      if (deviceId) {
        await prisma.pushToken.updateMany({
          where: {
            userId:
              req.user.id,

            deviceId,

            token: {
              not: token,
            },

            isActive: true,
          },

          data: {
            isActive: false,
          },
        });
      }

      /*
        A token should belong to only one logged-in user.
        Upsert transfers it safely to the current user.
      */
      const savedToken =
        await prisma.pushToken.upsert({
          where: {
            token,
          },

          update: {
            userId:
              req.user.id,

            platform,

            deviceId:
              deviceId ||
              null,

            isActive: true,
          },

          create: {
            userId:
              req.user.id,

            token,

            platform,

            deviceId:
              deviceId ||
              null,

            isActive: true,
          },
        });

      return res.json({
        success: true,
        message:
          "Push token registered",

        data:
          savedToken,

        token:
          savedToken,
      });
    } catch (error) {
      console.error(
        "Register Push Token Error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            error.message ||
            "Something went wrong",
        });
    }
  }
);

router.delete(
  "/token",
  protect,
  async (req, res) => {
    try {
      const token =
        cleanString(
          req.body?.token
        );

      const deviceId =
        cleanString(
          req.body?.deviceId
        );

      if (
        !token &&
        !deviceId
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Push token or device id is required",
          });
      }

      const result =
        await prisma.pushToken.updateMany({
          where: {
            userId:
              req.user.id,

            ...(token
              ? {
                  token,
                }
              : {}),

            ...(deviceId
              ? {
                  deviceId,
                }
              : {}),

            isActive: true,
          },

          data: {
            isActive: false,
          },
        });

      return res.json({
        success: true,
        message:
          "Push token removed",

        data:
          result,

        removedCount:
          result.count,
      });
    } catch (error) {
      console.error(
        "Remove Push Token Error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            error.message ||
            "Something went wrong",
        });
    }
  }
);

router.delete(
  "/tokens/all",
  protect,
  async (req, res) => {
    try {
      const result =
        await prisma.pushToken.updateMany({
          where: {
            userId:
              req.user.id,

            isActive: true,
          },

          data: {
            isActive: false,
          },
        });

      return res.json({
        success: true,
        message:
          "All push tokens removed",

        removedCount:
          result.count,
      });
    } catch (error) {
      console.error(
        "Remove All Push Tokens Error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Unable to remove push tokens",
        });
    }
  }
);

/* =========================
   NOTIFICATIONS
========================= */

router.get(
  "/notifications",
  protect,
  async (req, res) => {
    try {
      const page =
        normalizePage(
          req.query.page
        );

      const limit =
        normalizeLimit(
          req.query.limit,
          30,
          100
        );

      const unreadOnly =
        normalizeBool(
          req.query.unread,
          false
        );

      const type =
        cleanString(
          req.query.type
        );

      const where =
        getNotificationWhere({
          userId:
            req.user.id,

          unreadOnly,

          type,
        });

      const [
        notifications,
        total,
        unreadCount,
      ] =
        await Promise.all([
          prisma.notification.findMany({
            where,

            orderBy: {
              createdAt:
                "desc",
            },

            skip:
              (page - 1) *
              limit,

            take: limit,
          }),

          prisma.notification.count({
            where,
          }),

          getUnreadCount(
            req.user.id
          ),
        ]);

      return res.json({
        success: true,

        data:
          notifications,

        notifications,

        unreadCount,

        count:
          notifications.length,

        pagination: {
          page,
          limit,
          total,

          totalPages:
            Math.ceil(
              total /
                limit
            ),
        },
      });
    } catch (error) {
      console.error(
        "Get Notifications Error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            error.message ||
            "Something went wrong",
        });
    }
  }
);

router.get(
  "/notifications/unread-count",
  protect,
  async (req, res) => {
    try {
      const unreadCount =
        await getUnreadCount(
          req.user.id
        );

      return res.json({
        success: true,

        data: {
          unreadCount,
        },

        unreadCount,
      });
    } catch (error) {
      console.error(
        "Unread Notification Count Error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            error.message ||
            "Something went wrong",
        });
    }
  }
);

router.get(
  "/notifications/:id",
  protect,
  async (req, res) => {
    try {
      const notification =
        await prisma.notification.findFirst({
          where: {
            id:
              req.params.id,

            userId:
              req.user.id,
          },
        });

      if (!notification) {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "Notification not found",
          });
      }

      return res.json({
        success: true,
        data:
          notification,
        notification,
      });
    } catch (error) {
      console.error(
        "Notification Detail Error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Unable to fetch notification",
        });
    }
  }
);

router.patch(
  "/notifications/:id/read",
  protect,
  async (req, res) => {
    try {
      const existing =
        await prisma.notification.findFirst({
          where: {
            id:
              req.params.id,

            userId:
              req.user.id,
          },
        });

      if (!existing) {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "Notification not found",
          });
      }

      const notification =
        existing.isRead
          ? existing
          : await prisma.notification.update({
              where: {
                id:
                  existing.id,
              },

              data: {
                isRead: true,

                readAt:
                  new Date(),
              },
            });

      const unreadCount =
        await getUnreadCount(
          req.user.id
        );

      return res.json({
        success: true,
        message:
          "Notification marked as read",

        data:
          notification,

        notification,

        unreadCount,
      });
    } catch (error) {
      console.error(
        "Read Notification Error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            error.message ||
            "Something went wrong",
        });
    }
  }
);

router.patch(
  "/notifications/read-all",
  protect,
  async (req, res) => {
    try {
      const now =
        new Date();

      const result =
        await prisma.notification.updateMany({
          where: {
            userId:
              req.user.id,

            isRead: false,
          },

          data: {
            isRead: true,
            readAt: now,
          },
        });

      return res.json({
        success: true,
        message:
          "All notifications marked as read",

        data:
          result,

        updatedCount:
          result.count,

        unreadCount: 0,
      });
    } catch (error) {
      console.error(
        "Read All Notifications Error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            error.message ||
            "Something went wrong",
        });
    }
  }
);

router.delete(
  "/notifications/:id",
  protect,
  async (req, res) => {
    try {
      const existing =
        await prisma.notification.findFirst({
          where: {
            id:
              req.params.id,

            userId:
              req.user.id,
          },
        });

      if (!existing) {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "Notification not found",
          });
      }

      await prisma.notification.delete({
        where: {
          id:
            existing.id,
        },
      });

      const unreadCount =
        await getUnreadCount(
          req.user.id
        );

      return res.json({
        success: true,
        message:
          "Notification deleted",

        data: {
          id:
            existing.id,
        },

        deletedId:
          existing.id,

        unreadCount,
      });
    } catch (error) {
      console.error(
        "Delete Notification Error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            error.message ||
            "Something went wrong",
        });
    }
  }
);

router.delete(
  "/notifications",
  protect,
  async (req, res) => {
    try {
      const onlyRead =
        normalizeBool(
          req.query.readOnly,
          false
        );

      const result =
        await prisma.notification.deleteMany({
          where: {
            userId:
              req.user.id,

            ...(onlyRead
              ? {
                  isRead: true,
                }
              : {}),
          },
        });

      const unreadCount =
        onlyRead
          ? await getUnreadCount(
              req.user.id
            )
          : 0;

      return res.json({
        success: true,

        message:
          onlyRead
            ? "Read notifications cleared"
            : "Notifications cleared",

        data:
          result,

        deletedCount:
          result.count,

        unreadCount,
      });
    } catch (error) {
      console.error(
        "Clear Notifications Error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            error.message ||
            "Something went wrong",
        });
    }
  }
);

export default router;
