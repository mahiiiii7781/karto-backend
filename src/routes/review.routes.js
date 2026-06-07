import express from "express";
import prisma from "../prisma.js";
import { protect, allowRoles } from "../middleware/auth.middleware.js";

const router = express.Router();

const round1 = value => Math.round(Number(value || 0) * 10) / 10;

const cleanReview = value => {
  if (value === undefined || value === null) return null;

  const text = String(value).trim();

  if (!text) return null;

  return text.slice(0, 500);
};

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
      ? round1(
          reviews.reduce((sum, r) => sum + Number(r.rating || 0), 0) /
            totalReviews
        )
      : 0;

  await prisma.menuItem.update({
    where: { id: menuItemId },
    data: {
      rating,
      totalReviews,
    },
  });

  return {
    rating,
    totalReviews,
  };
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

    const finalReview = cleanReview(review);

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
          review: finalReview,
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
          menuItem: true,
        },
      });
    } else {
      savedReview = await prisma.menuItemReview.create({
        data: {
          userId: req.user.id,
          menuItemId,
          orderId: orderId || null,
          rating: finalRating,
          review: finalReview,
        },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              avatarUrl: true,
            },
          },
          menuItem: true,
        },
      });
    }

    const ratingSummary = await recalculateMenuItemRating(menuItemId);

    return res.status(201).json({
      success: true,
      message: "Review saved successfully",
      data: savedReview,
      review: savedReview,
      rating: ratingSummary.rating,
      totalReviews: ratingSummary.totalReviews,
    });
  } catch (error) {
    console.error("Create Menu Review Error:", error);

    if (error.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "You already reviewed this item",
      });
    }

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
    const limit = Math.min(Number(req.query.limit || 20), 100);

    const [reviews, summary] = await Promise.all([
      prisma.menuItemReview.findMany({
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
        take: limit,
      }),
      prisma.menuItemReview.aggregate({
        where: {
          menuItemId,
          isActive: true,
        },
        _avg: {
          rating: true,
        },
        _count: {
          rating: true,
        },
      }),
    ]);

    return res.json({
      success: true,
      data: reviews,
      reviews,
      rating: round1(summary._avg.rating || 0),
      totalReviews: summary._count.rating || 0,
      count: reviews.length,
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
    const { orderId } = req.query;

    const result = await prisma.menuItemReview.updateMany({
      where: {
        menuItemId,
        userId: req.user.id,
        ...(orderId ? { orderId: String(orderId) } : {}),
      },
      data: {
        isActive: false,
      },
    });

    const ratingSummary = await recalculateMenuItemRating(menuItemId);

    return res.json({
      success: true,
      message: "Review removed successfully",
      data: result,
      updatedCount: result.count,
      rating: ratingSummary.rating,
      totalReviews: ratingSummary.totalReviews,
    });
  } catch (error) {
    console.error("Delete Menu Review Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

// Admin hide review
router.patch(
  "/menu-item/:menuItemId/:reviewId/hide",
  protect,
  allowRoles("ADMIN"),
  async (req, res) => {
    try {
      const { menuItemId, reviewId } = req.params;

      const savedReview = await prisma.menuItemReview.update({
        where: { id: reviewId },
        data: { isActive: false },
      });

      const ratingSummary = await recalculateMenuItemRating(menuItemId);

      return res.json({
        success: true,
        message: "Review hidden successfully",
        data: savedReview,
        review: savedReview,
        rating: ratingSummary.rating,
        totalReviews: ratingSummary.totalReviews,
      });
    } catch (error) {
      console.error("Admin Hide Review Error:", error);

      if (error.code === "P2025") {
        return res.status(404).json({
          success: false,
          message: "Review not found",
        });
      }

      return res.status(500).json({
        success: false,
        message: error.message || "Something went wrong",
      });
    }
  }
);

export default router;