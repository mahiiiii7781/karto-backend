import express from "express";
import prisma from "../prisma.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/:menuItemId", protect, async (req, res) => {
  try {
    const { menuItemId } = req.params;

    const menuItem = await prisma.menuItem.findUnique({
      where: { id: menuItemId },
    });

    if (!menuItem) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    const viewed = await prisma.recentlyViewedItem.upsert({
      where: {
        userId_menuItemId: {
          userId: req.user.id,
          menuItemId,
        },
      },
      update: {
        viewedAt: new Date(),
      },
      create: {
        userId: req.user.id,
        menuItemId,
      },
      include: {
        menuItem: {
          include: {
            restaurant: true,
            addons: true,
            customizations: true,
          },
        },
      },
    });

    return res.json({
      success: true,
      message: "Recently viewed saved",
      data: viewed,
    });
  } catch (error) {
    console.error("Recently Viewed Save Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

router.get("/", protect, async (req, res) => {
  try {
    const items = await prisma.recentlyViewedItem.findMany({
      where: {
        userId: req.user.id,
      },
      include: {
        menuItem: {
          include: {
            restaurant: true,
            addons: {
              where: { isActive: true },
            },
            customizations: {
              where: { isActive: true },
            },
          },
        },
      },
      orderBy: {
        viewedAt: "desc",
      },
      take: 20,
    });

    return res.json({
      success: true,
      data: items,
      items,
    });
  } catch (error) {
    console.error("Recently Viewed Get Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

router.delete("/:menuItemId", protect, async (req, res) => {
  try {
    const { menuItemId } = req.params;

    await prisma.recentlyViewedItem.deleteMany({
      where: {
        userId: req.user.id,
        menuItemId,
      },
    });

    return res.json({
      success: true,
      message: "Recently viewed item removed",
    });
  } catch (error) {
    console.error("Recently Viewed Delete Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

router.delete("/", protect, async (req, res) => {
  try {
    await prisma.recentlyViewedItem.deleteMany({
      where: {
        userId: req.user.id,
      },
    });

    return res.json({
      success: true,
      message: "Recently viewed cleared",
    });
  } catch (error) {
    console.error("Recently Viewed Clear Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

export default router;