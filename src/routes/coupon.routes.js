import express from "express";
import prisma from "../prisma.js";
import { protect, allowRoles } from "../middleware/auth.middleware.js";

const router = express.Router();

const toNumber = value => Number(value || 0);

const normalizeCode = code => String(code || "").trim().toUpperCase();

const calculateDiscount = ({ coupon, itemTotal, deliveryFee = 0 }) => {
  const total = toNumber(itemTotal);
  const fee = toNumber(deliveryFee);

  if (coupon.minOrder && total < toNumber(coupon.minOrder)) {
    return {
      valid: false,
      message: `Minimum order should be ₹${coupon.minOrder}`,
      discountAmount: 0,
    };
  }

  let discountAmount = 0;

  if (coupon.type === "PERCENT") {
    discountAmount = (total * toNumber(coupon.value)) / 100;

    if (coupon.maxDiscount) {
      discountAmount = Math.min(discountAmount, toNumber(coupon.maxDiscount));
    }
  }

  if (coupon.type === "FLAT") {
    discountAmount = toNumber(coupon.value);
  }

  if (coupon.type === "FREE_DELIVERY") {
    discountAmount = fee;
  }

  discountAmount = Math.max(0, Math.min(discountAmount, total + fee));

  return {
    valid: true,
    message: "Coupon applied successfully",
    discountAmount,
  };
};

const validateCoupon = async ({ coupon, userId, restaurantId, cityId }) => {
  const now = new Date();

  if (!coupon || !coupon.isActive) {
    return { valid: false, message: "Invalid coupon" };
  }

  if (coupon.validFrom && new Date(coupon.validFrom) > now) {
    return { valid: false, message: "Coupon is not active yet" };
  }

  if (coupon.validUntil && new Date(coupon.validUntil) < now) {
    return { valid: false, message: "Coupon expired" };
  }

  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    return { valid: false, message: "Coupon usage limit reached" };
  }

  if (coupon.scope === "RESTAURANT" && coupon.restaurantId !== restaurantId) {
    return { valid: false, message: "Coupon not valid for this restaurant" };
  }

  if (coupon.scope === "CITY" && coupon.cityId !== cityId) {
    return { valid: false, message: "Coupon not valid in your city" };
  }

  if (coupon.scope === "FIRST_ORDER") {
    const orderCount = await prisma.order.count({
      where: { userId },
    });

    if (orderCount > 0) {
      return { valid: false, message: "Coupon valid only for first order" };
    }
  }

  const userUsage = await prisma.couponRedemption.count({
    where: {
      couponId: coupon.id,
      userId,
    },
  });

  if (
    coupon.perUserUsageLimit &&
    userUsage >= coupon.perUserUsageLimit
  ) {
    return { valid: false, message: "You already used this coupon" };
  }

  return { valid: true };
};

/* =========================
   ADMIN COUPON CRUD
========================= */

router.post(
  "/admin",
  protect,
  allowRoles("ADMIN"),
  async (req, res) => {
    try {
      const {
        code,
        title,
        description,
        type,
        scope = "GLOBAL",
        value,
        maxDiscount,
        minOrder,
        restaurantId,
        cityId,
        usageLimit,
        perUserUsageLimit = 1,
        validFrom,
        validUntil,
        isActive = true,
      } = req.body;

      if (!code || !title || !type || value === undefined) {
        return res.status(400).json({
          success: false,
          message: "code, title, type and value are required",
        });
      }

      if (!["PERCENT", "FLAT", "FREE_DELIVERY"].includes(type)) {
        return res.status(400).json({
          success: false,
          message: "Invalid coupon type",
        });
      }

      if (!["GLOBAL", "RESTAURANT", "CITY", "FIRST_ORDER"].includes(scope)) {
        return res.status(400).json({
          success: false,
          message: "Invalid coupon scope",
        });
      }

      if (scope === "RESTAURANT" && !restaurantId) {
        return res.status(400).json({
          success: false,
          message: "restaurantId is required for restaurant coupon",
        });
      }

      if (scope === "CITY" && !cityId) {
        return res.status(400).json({
          success: false,
          message: "cityId is required for city coupon",
        });
      }

      const coupon = await prisma.coupon.create({
        data: {
          code: normalizeCode(code),
          title: title.trim(),
          description: description || null,
          type,
          scope,
          value: Number(value),
          maxDiscount: maxDiscount ? Number(maxDiscount) : null,
          minOrder: minOrder ? Number(minOrder) : null,
          restaurantId: restaurantId || null,
          cityId: cityId || null,
          usageLimit: usageLimit ? Number(usageLimit) : null,
          perUserUsageLimit: Number(perUserUsageLimit || 1),
          validFrom: validFrom ? new Date(validFrom) : null,
          validUntil: validUntil ? new Date(validUntil) : null,
          isActive: Boolean(isActive),
        },
        include: {
          restaurant: true,
          city: true,
        },
      });

      return res.status(201).json({
        success: true,
        message: "Coupon created successfully",
        data: coupon,
        coupon,
      });
    } catch (error) {
      console.error("Create Coupon Error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Something went wrong",
      });
    }
  }
);

router.get(
  "/admin",
  protect,
  allowRoles("ADMIN"),
  async (req, res) => {
    try {
      const coupons = await prisma.coupon.findMany({
        include: {
          restaurant: true,
          city: true,
          redemptions: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      return res.json({
        success: true,
        data: coupons,
        coupons,
      });
    } catch (error) {
      console.error("Get Admin Coupons Error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Something went wrong",
      });
    }
  }
);

router.patch(
  "/admin/:id",
  protect,
  allowRoles("ADMIN"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const {
        code,
        title,
        description,
        type,
        scope,
        value,
        maxDiscount,
        minOrder,
        restaurantId,
        cityId,
        usageLimit,
        perUserUsageLimit,
        validFrom,
        validUntil,
        isActive,
      } = req.body;

      const coupon = await prisma.coupon.update({
        where: { id },
        data: {
          ...(code !== undefined && { code: normalizeCode(code) }),
          ...(title !== undefined && { title: title.trim() }),
          ...(description !== undefined && { description: description || null }),
          ...(type !== undefined && { type }),
          ...(scope !== undefined && { scope }),
          ...(value !== undefined && { value: Number(value) }),
          ...(maxDiscount !== undefined && {
            maxDiscount: maxDiscount ? Number(maxDiscount) : null,
          }),
          ...(minOrder !== undefined && {
            minOrder: minOrder ? Number(minOrder) : null,
          }),
          ...(restaurantId !== undefined && {
            restaurantId: restaurantId || null,
          }),
          ...(cityId !== undefined && {
            cityId: cityId || null,
          }),
          ...(usageLimit !== undefined && {
            usageLimit: usageLimit ? Number(usageLimit) : null,
          }),
          ...(perUserUsageLimit !== undefined && {
            perUserUsageLimit: Number(perUserUsageLimit || 1),
          }),
          ...(validFrom !== undefined && {
            validFrom: validFrom ? new Date(validFrom) : null,
          }),
          ...(validUntil !== undefined && {
            validUntil: validUntil ? new Date(validUntil) : null,
          }),
          ...(isActive !== undefined && {
            isActive: Boolean(isActive),
          }),
        },
        include: {
          restaurant: true,
          city: true,
        },
      });

      return res.json({
        success: true,
        message: "Coupon updated successfully",
        data: coupon,
        coupon,
      });
    } catch (error) {
      console.error("Update Coupon Error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Something went wrong",
      });
    }
  }
);

router.delete(
  "/admin/:id",
  protect,
  allowRoles("ADMIN"),
  async (req, res) => {
    try {
      await prisma.coupon.update({
        where: { id: req.params.id },
        data: { isActive: false },
      });

      return res.json({
        success: true,
        message: "Coupon disabled successfully",
      });
    } catch (error) {
      console.error("Delete Coupon Error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Something went wrong",
      });
    }
  }
);

/* =========================
   CUSTOMER COUPONS
========================= */

router.get("/available", protect, async (req, res) => {
  try {
    const { restaurantId, cityId, itemTotal = 0 } = req.query;
    const now = new Date();

    const coupons = await prisma.coupon.findMany({
      where: {
        isActive: true,
        OR: [
          { validFrom: null },
          { validFrom: { lte: now } },
        ],
        AND: [
          {
            OR: [
              { validUntil: null },
              { validUntil: { gte: now } },
            ],
          },
          {
            OR: [
              { scope: "GLOBAL" },
              { scope: "FIRST_ORDER" },
              restaurantId ? { restaurantId } : {},
              cityId ? { cityId } : {},
            ],
          },
        ],
      },
      include: {
        restaurant: true,
        city: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const validCoupons = [];

    for (const coupon of coupons) {
      const validation = await validateCoupon({
        coupon,
        userId: req.user.id,
        restaurantId: restaurantId || null,
        cityId: cityId || null,
      });

      if (!validation.valid) continue;

      if (coupon.minOrder && Number(itemTotal) < Number(coupon.minOrder)) {
        validCoupons.push({
          ...coupon,
          canApply: false,
          reason: `Add ₹${Number(coupon.minOrder) - Number(itemTotal)} more to apply`,
        });
      } else {
        validCoupons.push({
          ...coupon,
          canApply: true,
          reason: null,
        });
      }
    }

    return res.json({
      success: true,
      data: validCoupons,
      coupons: validCoupons,
    });
  } catch (error) {
    console.error("Available Coupons Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

router.post("/apply", protect, async (req, res) => {
  try {
    const {
      code,
      restaurantId,
      cityId,
      itemTotal,
      deliveryFee = 0,
    } = req.body;

    if (!code || !restaurantId || itemTotal === undefined) {
      return res.status(400).json({
        success: false,
        message: "code, restaurantId and itemTotal are required",
      });
    }

    const coupon = await prisma.coupon.findUnique({
      where: {
        code: normalizeCode(code),
      },
    });

    const validation = await validateCoupon({
      coupon,
      userId: req.user.id,
      restaurantId,
      cityId: cityId || null,
    });

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.message,
      });
    }

    const discount = calculateDiscount({
      coupon,
      itemTotal,
      deliveryFee,
    });

    if (!discount.valid) {
      return res.status(400).json({
        success: false,
        message: discount.message,
      });
    }

    return res.json({
      success: true,
      message: discount.message,
      data: {
        couponId: coupon.id,
        code: coupon.code,
        type: coupon.type,
        scope: coupon.scope,
        discountAmount: discount.discountAmount,
        finalAmount:
          Number(itemTotal) + Number(deliveryFee) - discount.discountAmount,
      },
    });
  } catch (error) {
    console.error("Apply Coupon Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

/* =========================
   RIDER COUPON
========================= */

router.post(
  "/admin/rider-coupon",
  protect,
  allowRoles("ADMIN"),
  async (req, res) => {
    try {
      const { riderId, orderId, title, amount, message } = req.body;

      if (!riderId || !orderId || !title || amount === undefined) {
        return res.status(400).json({
          success: false,
          message: "riderId, orderId, title and amount are required",
        });
      }

      const rider = await prisma.user.findFirst({
        where: {
          id: riderId,
          role: "RIDER",
        },
      });

      if (!rider) {
        return res.status(404).json({
          success: false,
          message: "Rider not found",
        });
      }

      const code = `RIDER${Date.now().toString().slice(-6)}`;

      const riderCoupon = await prisma.riderCoupon.create({
        data: {
          riderId,
          orderId,
          code,
          title,
          amount: Number(amount),
          message: message || "Great job! You earned a reward coupon.",
        },
        include: {
          rider: {
            select: {
              id: true,
              fullName: true,
              phone: true,
            },
          },
          order: true,
        },
      });

      return res.status(201).json({
        success: true,
        message: "Rider coupon created successfully",
        data: riderCoupon,
        riderCoupon,
      });
    } catch (error) {
      console.error("Create Rider Coupon Error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Something went wrong",
      });
    }
  }
);

export default router;