import express from "express";
import prisma from "../prisma.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

const normalizeLimit = (value, fallback = 50, max = 100) => {
  const num = Number(value);
  if (!num || Number.isNaN(num) || num < 1) return fallback;
  return Math.min(num, max);
};

const getUnreadCount = async (userId) => {
  return prisma.notification.count({
    where: {
      userId,
      isRead: false,
    },
  });
};

router.post("/register-token", protect, async (req, res) => {
  try {
    const { token, platform, deviceId } = req.body;

    if (!token || !String(token).trim()) {
      return res.status(400).json({
        success: false,
        message: "Push token is required",
      });
    }

    const savedToken = await prisma.pushToken.upsert({
      where: { token: String(token).trim() },
      update: {
        userId: req.user.id,
        platform: platform ? String(platform).trim() : null,
        deviceId: deviceId ? String(deviceId).trim() : null,
        isActive: true,
        updatedAt: new Date(),
      },
      create: {
        userId: req.user.id,
        token: String(token).trim(),
        platform: platform ? String(platform).trim() : null,
        deviceId: deviceId ? String(deviceId).trim() : null,
        isActive: true,
      },
    });

    return res.json({
      success: true,
      message: "Push token registered",
      data: savedToken,
      token: savedToken,
    });
  } catch (error) {
    console.error("Register Push Token Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

router.delete("/token", protect, async (req, res) => {
  try {
    const { token, deviceId } = req.body;

    if (!token && !deviceId) {
      return res.status(400).json({
        success: false,
        message: "Push token or device id is required",
      });
    }

    const result = await prisma.pushToken.updateMany({
      where: {
        userId: req.user.id,
        ...(token ? { token: String(token).trim() } : {}),
        ...(deviceId ? { deviceId: String(deviceId).trim() } : {}),
      },
      data: {
        isActive: false,
      },
    });

    return res.json({
      success: true,
      message: "Push token removed",
      data: result,
      removedCount: result.count,
    });
  } catch (error) {
    console.error("Remove Push Token Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

router.get("/notifications", protect, async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 50, 100);
    const onlyUnread = String(req.query.unread || "").toLowerCase() === "true";

    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: {
          userId: req.user.id,
          ...(onlyUnread ? { isRead: false } : {}),
        },
        orderBy: {
          createdAt: "desc",
        },
        take: limit,
      }),
      getUnreadCount(req.user.id),
    ]);

    return res.json({
      success: true,
      data: notifications,
      notifications,
      unreadCount,
      count: notifications.length,
    });
  } catch (error) {
    console.error("Get Notifications Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

router.get("/notifications/unread-count", protect, async (req, res) => {
  try {
    const unreadCount = await getUnreadCount(req.user.id);

    return res.json({
      success: true,
      data: { unreadCount },
      unreadCount,
    });
  } catch (error) {
    console.error("Unread Notification Count Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

router.patch("/notifications/:id/read", protect, async (req, res) => {
  try {
    const existing = await prisma.notification.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    const notification = await prisma.notification.update({
      where: {
        id: existing.id,
      },
      data: {
        isRead: true,
      },
    });

    const unreadCount = await getUnreadCount(req.user.id);

    return res.json({
      success: true,
      message: "Notification marked as read",
      data: notification,
      notification,
      unreadCount,
    });
  } catch (error) {
    console.error("Read Notification Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

router.patch("/notifications/read-all", protect, async (req, res) => {
  try {
    const result = await prisma.notification.updateMany({
      where: {
        userId: req.user.id,
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });

    return res.json({
      success: true,
      message: "All notifications marked as read",
      data: result,
      updatedCount: result.count,
      unreadCount: 0,
    });
  } catch (error) {
    console.error("Read All Notifications Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

router.delete("/notifications/:id", protect, async (req, res) => {
  try {
    const existing = await prisma.notification.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    await prisma.notification.delete({
      where: {
        id: existing.id,
      },
    });

    const unreadCount = await getUnreadCount(req.user.id);

    return res.json({
      success: true,
      message: "Notification deleted",
      data: { id: existing.id },
      deletedId: existing.id,
      unreadCount,
    });
  } catch (error) {
    console.error("Delete Notification Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

router.delete("/notifications", protect, async (req, res) => {
  try {
    const result = await prisma.notification.deleteMany({
      where: {
        userId: req.user.id,
      },
    });

    return res.json({
      success: true,
      message: "Notifications cleared",
      data: result,
      deletedCount: result.count,
      unreadCount: 0,
    });
  } catch (error) {
    console.error("Clear Notifications Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

export default router;