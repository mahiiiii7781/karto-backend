import express from "express";
import prisma from "../prisma.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

/* =========================
   RESTAURANT FAVORITES
========================= */

// Toggle restaurant favorite
router.post("/restaurant/:restaurantId", protect, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found",
      });
    }

    const existing = await prisma.userFavorite.findUnique({
      where: {
        userId_restaurantId: {
          userId: req.user.id,
          restaurantId,
        },
      },
    });

    if (existing) {
      await prisma.userFavorite.delete({
        where: { id: existing.id },
      });

      return res.json({
        success: true,
        message: "Removed from favorites",
        isFavorite: false,
      });
    }

    const favorite = await prisma.userFavorite.create({
      data: {
        userId: req.user.id,
        restaurantId,
      },
      include: {
        restaurant: true,
      },
    });

    return res.json({
      success: true,
      message: "Added to favorites",
      isFavorite: true,
      data: favorite,
    });
  } catch (error) {
    console.error("Restaurant Favorite Toggle Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// Restaurant favorite status
router.get("/restaurant/:restaurantId/status", protect, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const favorite = await prisma.userFavorite.findUnique({
      where: {
        userId_restaurantId: {
          userId: req.user.id,
          restaurantId,
        },
      },
    });

    return res.json({
      success: true,
      isFavorite: !!favorite,
    });
  } catch (error) {
    console.error("Restaurant Favorite Status Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

/* =========================
   ITEM FAVORITES
========================= */

// Toggle item favorite
router.post("/item/:menuItemId", protect, async (req, res) => {
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

    const existing = await prisma.userFavoriteItem.findUnique({
      where: {
        userId_menuItemId: {
          userId: req.user.id,
          menuItemId,
        },
      },
    });

    if (existing) {
      await prisma.userFavoriteItem.delete({
        where: { id: existing.id },
      });

      return res.json({
        success: true,
        message: "Removed item from favorites",
        isFavorite: false,
      });
    }

    const favorite = await prisma.userFavoriteItem.create({
      data: {
        userId: req.user.id,
        menuItemId,
      },
      include: {
        menuItem: {
          include: {
            restaurant: true,
          },
        },
      },
    });

    return res.json({
      success: true,
      message: "Added item to favorites",
      isFavorite: true,
      data: favorite,
    });
  } catch (error) {
    console.error("Item Favorite Toggle Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// Item favorite status
router.get("/item/:menuItemId/status", protect, async (req, res) => {
  try {
    const { menuItemId } = req.params;

    const favorite = await prisma.userFavoriteItem.findUnique({
      where: {
        userId_menuItemId: {
          userId: req.user.id,
          menuItemId,
        },
      },
    });

    return res.json({
      success: true,
      isFavorite: !!favorite,
    });
  } catch (error) {
    console.error("Item Favorite Status Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

/* =========================
   GET ALL FAVORITES
========================= */

router.get("/", protect, async (req, res) => {
  try {
    const [restaurants, items] = await Promise.all([
      prisma.userFavorite.findMany({
        where: { userId: req.user.id },
        include: {
          restaurant: true,
        },
        orderBy: { createdAt: "desc" },
      }),

      prisma.userFavoriteItem.findMany({
        where: { userId: req.user.id },
        include: {
          menuItem: {
            include: {
              restaurant: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    return res.json({
      success: true,
      data: {
        restaurants,
        items,
      },
      restaurants,
      items,
    });
  } catch (error) {
    console.error("Get Favorites Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

export default router;