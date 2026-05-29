import express from "express";
import prisma from "../prisma.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

const recalculateMenuItemRating = async menuItemId => {
  const reviews = await prisma.menuItemReview.findMany({
    where: {
      menuItemId,
      isActive: true,
    },
    select: {
      rating: true,
    },
  });

  const totalReviews = reviews.length;
  const rating =
    totalReviews > 0
      ? reviews.reduce((sum, r) => sum + Number(r.rating || 0), 0) / totalReviews
      : 0;

  await prisma.menuItem.update({
    where: { id: menuItemId },
    data: {
      rating,
      totalReviews,
    },
  });
};

// Create/update menu item review
router.post("/menu-item/:menuItemId", protect, async (req, res) => {
  try {
    const { menuItemId } = req.params;
    const { rating, review, orderId } = req.body;

    const finalRating = Number(rating);

    if (!finalRating || finalRating < 1 || finalRating > 5) {
      return res.status(400).json({
        success: false,
        message: "Rating must be between 1 and 5",
      });
    }

    const menuItem = await prisma.menuItem.findUnique({
      where: { id: menuItemId },
    });

    if (!menuItem) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    if (orderId) {
      const order = await prisma.order.findFirst({
        where: {
          id: orderId,
          userId: req.user.id,
          status: "DELIVERED",
          items: {
            some: {
              menuItemId,
            },
          },
        },
      });

      if (!order) {
        return res.status(403).json({
          success: false,
          message: "You can review only delivered items you ordered",
        });
      }
    }

    const existing = await prisma.menuItemReview.findFirst({
      where: {
        userId: req.user.id,
        menuItemId,
        ...(orderId ? { orderId } : {}),
      },
    });

    let savedReview;

    if (existing) {
      savedReview = await prisma.menuItemReview.update({
        where: { id: existing.id },
        data: {
          rating: finalRating,
          review: review || null,
          isActive: true,
        },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              avatarUrl: true,
            },
          },
        },
      });
    } else {
      savedReview = await prisma.menuItemReview.create({
        data: {
          userId: req.user.id,
          menuItemId,
          orderId: orderId || null,
          rating: finalRating,
          review: review || null,
        },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              avatarUrl: true,
            },
          },
        },
      });
    }

    await recalculateMenuItemRating(menuItemId);

    return res.status(201).json({
      success: true,
      message: "Review saved successfully",
      data: savedReview,
      review: savedReview,
    });
  } catch (error) {
    console.error("Create Menu Review Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// Get menu item reviews
router.get("/menu-item/:menuItemId", async (req, res) => {
  try {
    const { menuItemId } = req.params;

    const reviews = await prisma.menuItemReview.findMany({
      where: {
        menuItemId,
        isActive: true,
      },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return res.json({
      success: true,
      data: reviews,
      reviews,
    });
  } catch (error) {
    console.error("Get Menu Reviews Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// Delete/deactivate own review
router.delete("/menu-item/:menuItemId", protect, async (req, res) => {
  try {
    const { menuItemId } = req.params;

    await prisma.menuItemReview.updateMany({
      where: {
        menuItemId,
        userId: req.user.id,
      },
      data: {
        isActive: false,
      },
    });

    await recalculateMenuItemRating(menuItemId);

    return res.json({
      success: true,
      message: "Review removed successfully",
    });
  } catch (error) {
    console.error("Delete Menu Review Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

export default router;