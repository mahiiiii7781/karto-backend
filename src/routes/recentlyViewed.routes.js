import express from "express";
import prisma from "../prisma.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

const normalizeLimit = (value, fallback = 20, max = 50) => {
  const num = Number(value);

  if (!num || Number.isNaN(num) || num < 1) return fallback;

  return Math.min(num, max);
};

const getRecentlyViewedItems = async (userId, limit = 20) => {
  return prisma.recentlyViewedItem.findMany({
    where: {
      userId,
      menuItem: {
        isAvailable: true,
      },
    },
    include: {
      menuItem: {
        include: {
          restaurant: {
            include: {
              category: true,
              timings: true,
            },
          },
          addons: {
            where: { isActive: true },
            orderBy: { createdAt: "asc" },
          },
          customizations: {
            where: { isActive: true },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
    orderBy: {
      viewedAt: "desc",
    },
    take: limit,
  });
};

router.post("/:menuItemId", protect, async (req, res) => {
  try {
    const { menuItemId } = req.params;

    const menuItem = await prisma.menuItem.findUnique({
      where: { id: menuItemId },
      include: {
        restaurant: true,
      },
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
            restaurant: {
              include: {
                category: true,
                timings: true,
              },
            },
            addons: {
              where: { isActive: true },
              orderBy: { createdAt: "asc" },
            },
            customizations: {
              where: { isActive: true },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });

    const items = await getRecentlyViewedItems(req.user.id);

    return res.json({
      success: true,
      message: "Recently viewed saved",
      data: viewed,
      viewed,
      menuItem: viewed.menuItem,
      items,
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
    const limit = normalizeLimit(req.query.limit, 20, 50);
    const items = await getRecentlyViewedItems(req.user.id, limit);

    return res.json({
      success: true,
      data: items,
      items,
      count: items.length,
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

    const items = await getRecentlyViewedItems(req.user.id);

    return res.json({
      success: true,
      message: "Recently viewed item removed",
      data: { menuItemId },
      deletedId: menuItemId,
      items,
      count: items.length,
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
      data: true,
      items: [],
      count: 0,
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