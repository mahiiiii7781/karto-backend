import express from "express";
import prisma from "../prisma.js";
import { protect, allowRoles } from "../middleware/auth.middleware.js";

const router = express.Router();

const toNumber = value => Number(value || 0);

const round2 = value =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const normalizeCode = code => String(code || "").trim().toUpperCase();

const validTypes = ["PERCENT", "FLAT", "FREE_DELIVERY"];
const validScopes = ["GLOBAL", "RESTAURANT", "CITY", "FIRST_ORDER"];

const calculateDiscount = ({ coupon, itemTotal, deliveryFee = 0 }) => {
  const total = round2(itemTotal);
  const fee = round2(deliveryFee);

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

  discountAmount = round2(Math.max(0, Math.min(discountAmount, total + fee)));

  return {
    valid: true,
    message: "Coupon applied successfully",
    discountAmount,
  };
};

const validateAdminCouponPayload = ({
  code,
  title,
  type,
  scope = "GLOBAL",
  value,
  maxDiscount,
  minOrder,
  restaurantId,
  cityId,
  validFrom,
  validUntil,
}) => {
  if (!code || !title || !type || value === undefined) {
    return "code, title, type and value are required";
  }

  if (!normalizeCode(code)) {
    return "Coupon code is required";
  }

  if (!String(title).trim()) {
    return "Coupon title is required";
  }

  if (!validTypes.includes(type)) {
    return "Invalid coupon type";
  }

  if (!validScopes.includes(scope)) {
    return "Invalid coupon scope";
  }

  if (toNumber(value) <= 0) {
    return "Coupon value must be greater than 0";
  }

  if (type === "PERCENT" && toNumber(value) > 100) {
    return "Percent coupon value cannot be more than 100";
  }

  if (maxDiscount !== undefined && maxDiscount !== null && maxDiscount !== "") {
    if (toNumber(maxDiscount) < 0) return "Max discount cannot be negative";
  }

  if (minOrder !== undefined && minOrder !== null && minOrder !== "") {
    if (toNumber(minOrder) < 0) return "Minimum order cannot be negative";
  }

  if (scope === "RESTAURANT" && !restaurantId) {
    return "restaurantId is required for restaurant coupon";
  }

  if (scope === "CITY" && !cityId) {
    return "cityId is required for city coupon";
  }

  if (validFrom && validUntil && new Date(validFrom) > new Date(validUntil)) {
    return "validFrom cannot be after validUntil";
  }

  return null;
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

  if (coupon.perUserUsageLimit && userUsage >= coupon.perUserUsageLimit) {
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

      const validationMessage = validateAdminCouponPayload({
        code,
        title,
        type,
        scope,
        value,
        maxDiscount,
        minOrder,
        restaurantId,
        cityId,
        validFrom,
        validUntil,
      });

      if (validationMessage) {
        return res.status(400).json({
          success: false,
          message: validationMessage,
        });
      }

      const coupon = await prisma.coupon.create({
        data: {
          code: normalizeCode(code),
          title: String(title).trim(),
          description: description || null,
          type,
          scope,
          value: round2(value),
          maxDiscount: maxDiscount ? round2(maxDiscount) : null,
          minOrder: minOrder ? round2(minOrder) : null,
          restaurantId: scope === "RESTAURANT" ? restaurantId : null,
          cityId: scope === "CITY" ? cityId : null,
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

      if (error.code === "P2002") {
        return res.status(409).json({
          success: false,
          message: "Coupon code already exists",
        });
      }

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
        count: coupons.length,
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

      const existing = await prisma.coupon.findUnique({
        where: { id },
      });

      if (!existing) {
        return res.status(404).json({
          success: false,
          message: "Coupon not found",
        });
      }

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

      const nextPayload = {
        code: code !== undefined ? code : existing.code,
        title: title !== undefined ? title : existing.title,
        type: type !== undefined ? type : existing.type,
        scope: scope !== undefined ? scope : existing.scope,
        value: value !== undefined ? value : existing.value,
        maxDiscount:
          maxDiscount !== undefined ? maxDiscount : existing.maxDiscount,
        minOrder: minOrder !== undefined ? minOrder : existing.minOrder,
        restaurantId:
          restaurantId !== undefined ? restaurantId : existing.restaurantId,
        cityId: cityId !== undefined ? cityId : existing.cityId,
        validFrom: validFrom !== undefined ? validFrom : existing.validFrom,
        validUntil: validUntil !== undefined ? validUntil : existing.validUntil,
      };

      const validationMessage = validateAdminCouponPayload(nextPayload);

      if (validationMessage) {
        return res.status(400).json({
          success: false,
          message: validationMessage,
        });
      }

      const finalScope = nextPayload.scope;

      const coupon = await prisma.coupon.update({
        where: { id },
        data: {
          ...(code !== undefined && { code: normalizeCode(code) }),
          ...(title !== undefined && { title: String(title).trim() }),
          ...(description !== undefined && { description: description || null }),
          ...(type !== undefined && { type }),
          ...(scope !== undefined && { scope }),
          ...(value !== undefined && { value: round2(value) }),
          ...(maxDiscount !== undefined && {
            maxDiscount: maxDiscount ? round2(maxDiscount) : null,
          }),
          ...(minOrder !== undefined && {
            minOrder: minOrder ? round2(minOrder) : null,
          }),
          restaurantId:
            finalScope === "RESTAURANT"
              ? restaurantId !== undefined
                ? restaurantId
                : existing.restaurantId
              : null,
          cityId:
            finalScope === "CITY"
              ? cityId !== undefined
                ? cityId
                : existing.cityId
              : null,
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

      if (error.code === "P2002") {
        return res.status(409).json({
          success: false,
          message: "Coupon code already exists",
        });
      }

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
      const coupon = await prisma.coupon.update({
        where: { id: req.params.id },
        data: { isActive: false },
      });

      return res.json({
        success: true,
        message: "Coupon disabled successfully",
        data: coupon,
        coupon,
      });
    } catch (error) {
      console.error("Delete Coupon Error:", error);

      if (error.code === "P2025") {
        return res.status(404).json({
          success: false,
          message: "Coupon not found",
        });
      }

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
    const { restaurantId, cityId, itemTotal = 0, deliveryFee = 0 } = req.query;
    const now = new Date();

    const scopeConditions = [{ scope: "GLOBAL" }, { scope: "FIRST_ORDER" }];

    if (restaurantId) {
      scopeConditions.push({
        scope: "RESTAURANT",
        restaurantId: String(restaurantId),
      });
    }

    if (cityId) {
      scopeConditions.push({
        scope: "CITY",
        cityId: String(cityId),
      });
    }

    const coupons = await prisma.coupon.findMany({
      where: {
        isActive: true,
        OR: [{ validFrom: null }, { validFrom: { lte: now } }],
        AND: [
          {
            OR: [{ validUntil: null }, { validUntil: { gte: now } }],
          },
          {
            OR: scopeConditions,
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

      const discount = calculateDiscount({
        coupon,
        itemTotal,
        deliveryFee,
      });

      if (coupon.minOrder && Number(itemTotal) < Number(coupon.minOrder)) {
        validCoupons.push({
          ...coupon,
          canApply: false,
          reason: `Add ₹${round2(Number(coupon.minOrder) - Number(itemTotal))} more to apply`,
          discountAmount: 0,
        });
      } else {
        validCoupons.push({
          ...coupon,
          canApply: discount.valid,
          reason: discount.valid ? null : discount.message,
          discountAmount: discount.discountAmount || 0,
        });
      }
    }

    return res.json({
      success: true,
      data: validCoupons,
      coupons: validCoupons,
      count: validCoupons.length,
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
      include: {
        restaurant: true,
        city: true,
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

    const finalAmount = round2(
      Number(itemTotal) + Number(deliveryFee) - discount.discountAmount
    );

    const response = {
      couponId: coupon.id,
      code: coupon.code,
      title: coupon.title,
      type: coupon.type,
      scope: coupon.scope,
      value: coupon.value,
      discountAmount: discount.discountAmount,
      finalAmount,
      coupon,
    };

    return res.json({
      success: true,
      message: discount.message,
      data: response,
      coupon: response,
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

      if (toNumber(amount) <= 0) {
        return res.status(400).json({
          success: false,
          message: "Amount must be greater than 0",
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

      const order = await prisma.order.findUnique({
        where: { id: orderId },
      });

      if (!order) {
        return res.status(404).json({
          success: false,
          message: "Order not found",
        });
      }

      const code = `RIDER${Date.now().toString().slice(-6)}`;

      const riderCoupon = await prisma.riderCoupon.create({
        data: {
          riderId,
          orderId,
          code,
          title: String(title).trim(),
          amount: round2(amount),
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