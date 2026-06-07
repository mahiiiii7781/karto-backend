import express from "express";
import prisma from "../prisma.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

const getFavoriteCounts = async (userId) => {
  const [restaurantCount, itemCount] = await Promise.all([
    prisma.userFavorite.count({
      where: { userId },
    }),
    prisma.userFavoriteItem.count({
      where: { userId },
    }),
  ]);

  return {
    restaurantCount,
    itemCount,
    totalCount: restaurantCount + itemCount,
  };
};

const getRestaurantFavoriteStatus = async (userId, restaurantId) => {
  const favorite = await prisma.userFavorite.findUnique({
    where: {
      userId_restaurantId: {
        userId,
        restaurantId,
      },
    },
  });

  return favorite;
};

const getItemFavoriteStatus = async (userId, menuItemId) => {
  const favorite = await prisma.userFavoriteItem.findUnique({
    where: {
      userId_menuItemId: {
        userId,
        menuItemId,
      },
    },
  });

  return favorite;
};

/* =========================
   RESTAURANT FAVORITES
========================= */

// Toggle restaurant favorite
router.post("/restaurant/:restaurantId", protect, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        category: true,
        timings: true,
      },
    });

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found",
      });
    }

    const existing = await getRestaurantFavoriteStatus(req.user.id, restaurantId);

    if (existing) {
      await prisma.userFavorite.delete({
        where: { id: existing.id },
      });

      const counts = await getFavoriteCounts(req.user.id);

      return res.json({
        success: true,
        message: "Removed from favorites",
        isFavorite: false,
        data: null,
        favorite: null,
        restaurant,
        ...counts,
      });
    }

    const favorite = await prisma.userFavorite.create({
      data: {
        userId: req.user.id,
        restaurantId,
      },
      include: {
        restaurant: {
          include: {
            category: true,
            timings: true,
          },
        },
      },
    });

    const counts = await getFavoriteCounts(req.user.id);

    return res.json({
      success: true,
      message: "Added to favorites",
      isFavorite: true,
      data: favorite,
      favorite,
      restaurant: favorite.restaurant,
      ...counts,
    });
  } catch (error) {
    console.error("Restaurant Favorite Toggle Error:", error);

    if (error.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "Restaurant is already in favorites",
      });
    }

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

    const favorite = await getRestaurantFavoriteStatus(req.user.id, restaurantId);

    return res.json({
      success: true,
      isFavorite: !!favorite,
      favorite,
      restaurantId,
    });
  } catch (error) {
    console.error("Restaurant Favorite Status Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// Remove restaurant favorite directly
router.delete("/restaurant/:restaurantId", protect, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const existing = await getRestaurantFavoriteStatus(req.user.id, restaurantId);

    if (!existing) {
      return res.json({
        success: true,
        message: "Restaurant was not in favorites",
        isFavorite: false,
        restaurantId,
      });
    }

    await prisma.userFavorite.delete({
      where: { id: existing.id },
    });

    const counts = await getFavoriteCounts(req.user.id);

    return res.json({
      success: true,
      message: "Removed from favorites",
      isFavorite: false,
      restaurantId,
      ...counts,
    });
  } catch (error) {
    console.error("Restaurant Favorite Remove Error:", error);
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
      include: {
        restaurant: {
          include: {
            category: true,
            timings: true,
          },
        },
        customizations: {
          where: { isActive: true },
          orderBy: { createdAt: "asc" },
        },
        addons: {
          where: { isActive: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!menuItem) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    const existing = await getItemFavoriteStatus(req.user.id, menuItemId);

    if (existing) {
      await prisma.userFavoriteItem.delete({
        where: { id: existing.id },
      });

      const counts = await getFavoriteCounts(req.user.id);

      return res.json({
        success: true,
        message: "Removed item from favorites",
        isFavorite: false,
        data: null,
        favorite: null,
        menuItem,
        ...counts,
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
            restaurant: {
              include: {
                category: true,
                timings: true,
              },
            },
            customizations: {
              where: { isActive: true },
              orderBy: { createdAt: "asc" },
            },
            addons: {
              where: { isActive: true },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });

    const counts = await getFavoriteCounts(req.user.id);

    return res.json({
      success: true,
      message: "Added item to favorites",
      isFavorite: true,
      data: favorite,
      favorite,
      menuItem: favorite.menuItem,
      ...counts,
    });
  } catch (error) {
    console.error("Item Favorite Toggle Error:", error);

    if (error.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "Item is already in favorites",
      });
    }

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

    const favorite = await getItemFavoriteStatus(req.user.id, menuItemId);

    return res.json({
      success: true,
      isFavorite: !!favorite,
      favorite,
      menuItemId,
    });
  } catch (error) {
    console.error("Item Favorite Status Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// Remove item favorite directly
router.delete("/item/:menuItemId", protect, async (req, res) => {
  try {
    const { menuItemId } = req.params;

    const existing = await getItemFavoriteStatus(req.user.id, menuItemId);

    if (!existing) {
      return res.json({
        success: true,
        message: "Item was not in favorites",
        isFavorite: false,
        menuItemId,
      });
    }

    await prisma.userFavoriteItem.delete({
      where: { id: existing.id },
    });

    const counts = await getFavoriteCounts(req.user.id);

    return res.json({
      success: true,
      message: "Removed item from favorites",
      isFavorite: false,
      menuItemId,
      ...counts,
    });
  } catch (error) {
    console.error("Item Favorite Remove Error:", error);
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
    const [restaurants, items, counts] = await Promise.all([
      prisma.userFavorite.findMany({
        where: { userId: req.user.id },
        include: {
          restaurant: {
            include: {
              category: true,
              timings: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),

      prisma.userFavoriteItem.findMany({
        where: { userId: req.user.id },
        include: {
          menuItem: {
            include: {
              restaurant: {
                include: {
                  category: true,
                  timings: true,
                },
              },
              customizations: {
                where: { isActive: true },
                orderBy: { createdAt: "asc" },
              },
              addons: {
                where: { isActive: true },
                orderBy: { createdAt: "asc" },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),

      getFavoriteCounts(req.user.id),
    ]);

    return res.json({
      success: true,
      data: {
        restaurants,
        items,
        ...counts,
      },
      restaurants,
      items,
      ...counts,
    });
  } catch (error) {
    console.error("Get Favorites Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

/* =========================
   COUNTS
========================= */

router.get("/count", protect, async (req, res) => {
  try {
    const counts = await getFavoriteCounts(req.user.id);

    return res.json({
      success: true,
      data: counts,
      ...counts,
    });
  } catch (error) {
    console.error("Favorite Count Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

export default router;