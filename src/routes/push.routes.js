import express from "express";
import prisma from "../prisma.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/register-token", protect, async (req, res) => {
  try {
    const { token, platform, deviceId } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "Push token is required",
      });
    }

    const savedToken = await prisma.pushToken.upsert({
      where: { token },
      update: {
        userId: req.user.id,
        platform: platform || null,
        deviceId: deviceId || null,
        isActive: true,
      },
      create: {
        userId: req.user.id,
        token,
        platform: platform || null,
        deviceId: deviceId || null,
        isActive: true,
      },
    });

    return res.json({
      success: true,
      message: "Push token registered",
      data: savedToken,
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
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "Push token is required",
      });
    }

    await prisma.pushToken.updateMany({
      where: {
        token,
        userId: req.user.id,
      },
      data: {
        isActive: false,
      },
    });

    return res.json({
      success: true,
      message: "Push token removed",
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
    const notifications = await prisma.notification.findMany({
      where: {
        userId: req.user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 50,
    });

    return res.json({
      success: true,
      data: notifications,
      notifications,
    });
  } catch (error) {
    console.error("Get Notifications Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

router.patch("/notifications/:id/read", protect, async (req, res) => {
  try {
    const notification = await prisma.notification.updateMany({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
      data: {
        isRead: true,
      },
    });

    return res.json({
      success: true,
      message: "Notification marked as read",
      data: notification,
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
    await prisma.notification.updateMany({
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
    });
  } catch (error) {
    console.error("Read All Notifications Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

export default router;