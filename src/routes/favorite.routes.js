import express from "express";
import prisma from "../prisma.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

// ✅ Toggle favorite add/remove
router.post("/:restaurantId", protect, async (req, res) => {
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

    res.json({
      success: true,
      message: "Added to favorites",
      isFavorite: true,
      data: favorite,
    });
  } catch (error) {
    console.error("Favorite Toggle Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// ✅ Get user favorites
router.get("/", protect, async (req, res) => {
  try {
    const favorites = await prisma.userFavorite.findMany({
      where: {
        userId: req.user.id,
      },
      include: {
        restaurant: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({
      success: true,
      data: favorites,
    });
  } catch (error) {
    console.error("Get Favorites Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// ✅ Check single restaurant favorite status
router.get("/:restaurantId/status", protect, async (req, res) => {
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

    res.json({
      success: true,
      isFavorite: !!favorite,
    });
  } catch (error) {
    console.error("Favorite Status Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

export default router;