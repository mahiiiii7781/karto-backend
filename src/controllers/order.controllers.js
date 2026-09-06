import prisma from "../prisma.js";
import {
  emitOrderStatus,
  emitNewOrder,
  emitVendorDashboardUpdate,
  emitToAdmin,
  broadcastToCityRiders,
} from "../config/socket.js";

import {
  sendPushToUser,
  notificationTemplates,
} from "../services/notification.service.js";

import {
  calculateDeliveryFee,
  calculateDistanceKm,
} from "../utils/deliveryFee.js";

const generateOrderNumber = () => {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const random = Math.floor(1000 + Math.random() * 9000);
  return `KT${y}${m}${d}${random}`;
};

const generateUniqueOrderNumber = async (tx) => {
  for (let i = 0; i < 8; i++) {
    const orderNumber = generateOrderNumber();

    const exists = await tx.order.findUnique({
      where: { orderNumber },
      select: { id: true },
    });

    if (!exists) return orderNumber;
  }

  return `KT${Date.now()}`;
};

const generateDeliveryOtp = () =>
  String(Math.floor(1000 + Math.random() * 9000));

const deliveryOtpExpiry = () =>
  new Date(Date.now() + 24 * 60 * 60 * 1000);

const hideDeliveryOtp = (order) => {
  if (!order) return order;

  return {
    ...order,
    deliveryOtp: undefined,
    deliveryOtpExpiresAt: undefined,
  };
};

const hideDeliveryOtpFromList = (orders = []) => orders.map(hideDeliveryOtp);

const toNumber = (value) => Number(value || 0);

const round2 = (value) =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const PLATFORM_FEE = round2(process.env.KARTO_PLATFORM_FEE || 5);
const CGST_RATE = round2(process.env.KARTO_CGST_RATE || 2.5);
const SGST_RATE = round2(process.env.KARTO_SGST_RATE || 2.5);

const normalizeCouponCode = (code) => String(code || "").trim().toUpperCase();


const MAX_ORDER_ITEM_QUANTITY = Math.max(
  1,
  Number(process.env.KARTO_MAX_CART_ITEM_QUANTITY || 50)
);

const isPrepaidMethod = (method) =>
  ["ONLINE", "UPI", "CARD", "WALLET"].includes(
    String(method || "").toUpperCase()
  );

const getCommissionableAmount = (itemTotal, discount) =>
  round2(Math.max(toNumber(itemTotal) - toNumber(discount), 0));

const buildCommissionSnapshot = (restaurant, itemTotal, discount) => {
  const commissionableAmount = getCommissionableAmount(itemTotal, discount);
  const commissionRate = round2(restaurant?.commission || 0);
  const platformCommissionAmount = round2(
    (commissionableAmount * commissionRate) / 100
  );
  const vendorSettlementAmount = round2(
    Math.max(commissionableAmount - platformCommissionAmount, 0)
  );

  return {
    commissionableAmount,
    commissionRate,
    platformCommissionAmount,
    vendorSettlementAmount,
  };
};

const getOrderFinancials = (order) => {
  const commissionableAmount =
    order?.commissionableAmount !== null &&
    order?.commissionableAmount !== undefined
      ? round2(order.commissionableAmount)
      : getCommissionableAmount(order?.itemTotal, order?.discount);

  const commissionRate = round2(
    order?.commissionRate ??
      order?.restaurant?.commission ??
      0
  );

  const platformCommissionAmount = round2(
    order?.platformCommissionAmount !== null &&
      order?.platformCommissionAmount !== undefined
      ? order.platformCommissionAmount
      : (commissionableAmount * commissionRate) / 100
  );

  const vendorSettlementAmount = round2(
    order?.vendorSettlementAmount !== null &&
      order?.vendorSettlementAmount !== undefined
      ? order.vendorSettlementAmount
      : Math.max(commissionableAmount - platformCommissionAmount, 0)
  );

  return {
    commissionableAmount,
    commissionRate,
    platformCommissionAmount,
    vendorSettlementAmount,
  };
};

const createRefundIfRequired = async (tx, order, reason) => {
  if (
    !isPrepaidMethod(order.paymentMethod) ||
    order.paymentStatus !== "PAID"
  ) {
    return null;
  }

  const existingRefund = await tx.refund.findFirst({
    where: {
      orderId: order.id,
      status: {
        in: ["PENDING", "PROCESSING", "COMPLETED"],
      },
    },
  });

  if (existingRefund) return existingRefund;

  const transaction = await tx.paymentTransaction.findFirst({
    where: {
      orderId: order.id,
      status: "SUCCESS",
    },
    orderBy: { createdAt: "desc" },
  });

  return tx.refund.create({
    data: {
      orderId: order.id,
      paymentTransactionId: transaction?.id || null,
      amount: round2(order.totalAmount),
      reason: reason || "Order cancelled",
      status: "PENDING",
    },
  });
};

const ensureDeliveredSettlements = async (tx, order) => {
  if (
    order.status !== "DELIVERED" ||
    order.paymentStatus !== "PAID"
  ) {
    return;
  }

  const finance = getOrderFinancials(order);

  if (order.vendorId) {
    await tx.vendorSettlement.upsert({
      where: { orderId: order.id },
      update: {
        vendorId: order.vendorId,
        restaurantId: order.restaurantId,
        grossAmount: round2(order.totalAmount),
        commissionRate: finance.commissionRate,
        commissionAmount: finance.platformCommissionAmount,
        netAmount: finance.vendorSettlementAmount,
      },
      create: {
        vendorId: order.vendorId,
        restaurantId: order.restaurantId,
        orderId: order.id,
        grossAmount: round2(order.totalAmount),
        commissionRate: finance.commissionRate,
        commissionAmount: finance.platformCommissionAmount,
        netAmount: finance.vendorSettlementAmount,
        status: "PENDING",
        periodStart: order.deliveredAt || new Date(),
        periodEnd: order.deliveredAt || new Date(),
      },
    });
  }

  if (order.riderId) {
    await tx.riderSettlement.upsert({
      where: { orderId: order.id },
      update: {
        riderId: order.riderId,
        amount: round2(order.deliveryFee),
      },
      create: {
        riderId: order.riderId,
        orderId: order.id,
        amount: round2(order.deliveryFee),
        status: "PENDING",
        periodStart: order.deliveredAt || new Date(),
        periodEnd: order.deliveredAt || new Date(),
      },
    });
  }
};

const allowedTransitions = {
  PLACED: ["ACCEPTED_BY_VENDOR", "CANCELLED"],
  ACCEPTED_BY_VENDOR: ["PREPARING", "READY_FOR_PICKUP", "CANCELLED"],
  PREPARING: ["READY_FOR_PICKUP", "CANCELLED"],
  READY_FOR_PICKUP: ["ASSIGNED_TO_RIDER", "CANCELLED"],
  ASSIGNED_TO_RIDER: ["PICKED_UP", "CANCELLED"],
  PICKED_UP: ["OUT_FOR_DELIVERY"],
  OUT_FOR_DELIVERY: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

const calculateCouponDiscount = ({ coupon, itemTotal, deliveryFee }) => {
  let discount = 0;

  if (coupon.type === "PERCENT") {
    discount = (itemTotal * toNumber(coupon.value)) / 100;
    if (coupon.maxDiscount) {
      discount = Math.min(discount, toNumber(coupon.maxDiscount));
    }
  }

  if (coupon.type === "FLAT") {
    discount = toNumber(coupon.value);
  }

  if (coupon.type === "FREE_DELIVERY") {
    discount = toNumber(deliveryFee);
  }

  return round2(Math.max(0, Math.min(discount, itemTotal + deliveryFee)));
};

const calculateFreshCartItemPricing = (item) => {
  const basePrice = toNumber(item.menuItem?.price);

  const customizationTotal = Array.isArray(item.customizationJson)
    ? item.customizationJson.reduce(
        (sum, data) => sum + toNumber(data?.price),
        0
      )
    : 0;

  const addonTotal = Array.isArray(item.addonJson)
    ? item.addonJson.reduce((sum, data) => sum + toNumber(data?.price), 0)
    : 0;

  const unitPrice = round2(basePrice + customizationTotal + addonTotal);
  const quantity = Math.max(1, Number(item.quantity || 1));
  const totalPrice = round2(unitPrice * quantity);

  return {
    quantity,
    unitPrice,
    totalPrice,
  };
};


const calculateOrderPricing = ({
  cartItems,
  restaurant,
  address,
  discount = 0,
  freeDelivery = false,
}) => {
  const itemTotal = round2(
    cartItems.reduce(
      (sum, item) => sum + toNumber(item.totalPrice),
      0
    )
  );

  const distanceKm = calculateDistanceKm(
    restaurant?.latitude,
    restaurant?.longitude,
    address?.latitude,
    address?.longitude
  );

  // Free delivery on orders of ₹99 or above.
  // Keep the existing distance-based delivery fee calculation for lower-value carts.
  const deliveryFeeBeforeDiscount =
    itemTotal >= 99
      ? 0
      : round2(
          calculateDeliveryFee(itemTotal, distanceKm)
        );

  const itemDiscount = Math.min(
    round2(Math.max(0, discount)),
    itemTotal
  );

  const deliveryDiscount = freeDelivery
    ? deliveryFeeBeforeDiscount
    : 0;

  const deliveryFee = round2(
    Math.max(deliveryFeeBeforeDiscount - deliveryDiscount, 0)
  );

  const taxableAmount = round2(
    Math.max(itemTotal - itemDiscount, 0)
  );

  const platformFee = PLATFORM_FEE;

  const cgstAmount = round2(
    (taxableAmount * CGST_RATE) / 100
  );

  const sgstAmount = round2(
    (taxableAmount * SGST_RATE) / 100
  );

  const taxAmount = round2(
    cgstAmount + sgstAmount
  );

  const totalDiscount = round2(
    itemDiscount + deliveryDiscount
  );

  const totalAmount = round2(
    taxableAmount +
      deliveryFee +
      platformFee +
      taxAmount
  );

  return {
    itemTotal,
    distanceKm,
    deliveryFeeBeforeDiscount,
    deliveryDiscount,
    deliveryFee,
    platformFee,
    cgstRate: CGST_RATE,
    sgstRate: SGST_RATE,
    cgstAmount,
    sgstAmount,
    taxAmount,
    discount: itemDiscount,
    totalDiscount,
    taxableAmount,
    totalAmount: Math.max(0, totalAmount),

    pricingResponse: {
      cartValue: itemTotal,
      subtotal: itemTotal,
      itemTotal,
      distanceKm,
      deliveryFeeBeforeDiscount,
      deliveryDiscount,
      deliveryFee,
      platformFee,
      taxableAmount,
      tax: {
        cgstRate: CGST_RATE,
        sgstRate: SGST_RATE,
        cgst: cgstAmount,
        sgst: sgstAmount,
        total: taxAmount,
      },
      taxAmount,
      discount: itemDiscount,
      totalDiscount,
      totalAmount: Math.max(0, totalAmount),
      grandTotal: Math.max(0, totalAmount),
    },
  };
};

const safeNotify = async (payload) => {
  try {
    if (!payload?.userId) return;
    await sendPushToUser(payload);
  } catch (error) {
    console.error("Notification Error:", error.message);
  }
};

const parseTimeToMinutes = (value) => {
  if (!value) return null;
  const [h, m] = String(value).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};

const getDayName = (date) =>
  date.toLocaleDateString("en-IN", { weekday: "long" }).toLowerCase();

const isRestaurantAvailableNow = (restaurant) => {
  const now = new Date();

  if (!restaurant.isOpen) {
    return { allowed: false, message: "Store is currently closed" };
  }

  if (restaurant.isAcceptingOrders === false) {
    return {
      allowed: false,
      message: "Store is not accepting orders right now",
    };
  }

  if (restaurant.busyUntil && new Date(restaurant.busyUntil) > now) {
    const time = new Date(restaurant.busyUntil).toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
    });

    return {
      allowed: false,
      message: `Store is busy right now. Try again after ${time}`,
    };
  }

  if (
    restaurant.weeklyOffDay &&
    String(restaurant.weeklyOffDay).toLowerCase() === getDayName(now)
  ) {
    return {
      allowed: false,
      message: "Store is closed today due to weekly off",
    };
  }

  const openMinutes = parseTimeToMinutes(restaurant.openingTime);
  const closeMinutes = parseTimeToMinutes(restaurant.closingTime);

  if (openMinutes !== null && closeMinutes !== null) {
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const isInsideTime =
      openMinutes <= closeMinutes
        ? currentMinutes >= openMinutes && currentMinutes <= closeMinutes
        : currentMinutes >= openMinutes || currentMinutes <= closeMinutes;

    if (!isInsideTime) {
      return {
        allowed: false,
        message: `Store accepts orders from ${restaurant.openingTime} to ${restaurant.closingTime}`,
      };
    }
  }

  return { allowed: true, message: "Store is available" };
};

const orderIncludeFull = {
  user: {
    select: {
      id: true,
      fullName: true,
      phone: true,
      email: true,
      avatarUrl: true,
    },
  },
  restaurant: true,
  coupon: true,
  address: true,
  rider: {
    select: {
      id: true,
      fullName: true,
      phone: true,
      vehicleNo: true,
      vehicleType: true,
      avatarUrl: true,
    },
  },
  items: {
    include: {
      menuItem: true,
    },
    orderBy: { createdAt: "asc" },
  },
  history: {
    orderBy: { createdAt: "asc" },
  },
};

const buildRiderOrderPayload = (order) => {
  if (!order) return null;

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    totalAmount: toNumber(order.totalAmount),
    itemTotal: toNumber(order.itemTotal),
    deliveryFee: toNumber(order.deliveryFee),
    distanceKm: order.distanceKm ? toNumber(order.distanceKm) : null,
    customerNote: order.customerNote,
    createdAt: order.createdAt,
    readyAt: order.readyAt,
    restaurantId: order.restaurantId,
    vendorId: order.vendorId,
    cityId: order.restaurant?.cityId || order.address?.cityId || null,
    customer: order.user
      ? {
          id: order.user.id,
          name: order.user.fullName,
          phone: order.user.phone,
          avatarUrl: order.user.avatarUrl,
        }
      : null,
    vendor: order.restaurant
      ? {
          id: order.restaurant.id,
          name: order.restaurant.name,
          ownerName: order.restaurant.ownerName,
          phone: order.restaurant.phone || order.restaurant.ownerMobileNo,
          address: order.restaurant.address,
          latitude: order.restaurant.latitude,
          longitude: order.restaurant.longitude,
          imageUrl: order.restaurant.imageUrl,
        }
      : null,
    pickupAddress: order.restaurant?.address || null,
    deliveryAddress: order.address || null,
    items: order.items || [],
  };
};

const notifyAvailableRiders = async (order) => {
  try {
    const fullOrder = await prisma.order.findUnique({
      where: { id: order.id },
      include: orderIncludeFull,
    });

    if (!fullOrder) return;

    const payload = buildRiderOrderPayload(fullOrder);
    const cityId = fullOrder.restaurant?.cityId || fullOrder.address?.cityId;

    if (cityId) {
      broadcastToCityRiders(cityId, "new-rider-order", {
        order: payload,
        assignmentType: "CITY_BROADCAST",
      });

      broadcastToCityRiders(cityId, "new-order-assignment", {
        order: payload,
        assignmentType: "CITY_BROADCAST",
      });
    } else {
      emitToAdmin("rider-assignment-city-missing", {
        orderId: fullOrder.id,
        orderNumber: fullOrder.orderNumber,
      });
    }

    emitToAdmin("new-rider-order-created", {
      order: payload,
      cityId: cityId || null,
    });

    const riders = await prisma.user.findMany({
      where: {
        role: "RIDER",
        isActive: true,
        isOnline: true,
        kycStatus: "APPROVED",
        ...(cityId ? { cityId } : {}),
      },
      select: { id: true },
      take: 50,
    });

    await Promise.all(
      riders.map((rider) =>
        safeNotify({
          userId: rider.id,
          type: "ORDER",
          title: "New delivery request",
          body: `Order ${fullOrder.orderNumber} is ready for pickup`,
          data: {
            orderId: fullOrder.id,
            orderNumber: fullOrder.orderNumber,
            status: fullOrder.status,
          },
        })
      )
    );
  } catch (error) {
    console.error("Notify Available Riders Error:", error.message);
  }
};

export const createOrder = async (req, res) => {
  try {
    const {
      addressId,
      paymentMethod = "COD",
      customerNote,
      couponCode,
    } = req.body;

    const normalizedPaymentMethod = String(paymentMethod || "COD").toUpperCase();

    if (!addressId) {
      return res.status(400).json({
        success: false,
        message: "Please select delivery address",
      });
    }

    if (
      !["COD", "ONLINE", "UPI", "CARD", "WALLET"].includes(
        normalizedPaymentMethod
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment method",
      });
    }

    const [cartItemsRaw, address] = await Promise.all([
      prisma.cartItem.findMany({
        where: { userId: req.user.id },
        include: {
          menuItem: {
            include: {
              customizations: true,
              addons: true,
            },
          },
          restaurant: true,
        },
        orderBy: { createdAt: "asc" },
      }),

      prisma.userAddress.findFirst({
        where: {
          id: addressId,
          userId: req.user.id,
        },
      }),
    ]);

    if (!cartItemsRaw.length) {
      return res.status(400).json({
        success: false,
        message: "Cart is empty",
      });
    }

    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Delivery address not found",
      });
    }

    const restaurantId = cartItemsRaw[0].restaurantId;

    if (
      cartItemsRaw.some(
        (item) => item.restaurantId !== restaurantId
      )
    ) {
      return res.status(409).json({
        success: false,
        message: "Cart contains items from multiple stores",
        code: "DIFFERENT_RESTAURANT",
      });
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        timings: true,
        operatingExceptions: true,
      },
    });

    if (!restaurant || restaurant.deletedAt) {
      return res.status(404).json({
        success: false,
        message: "Restaurant is not available",
      });
    }

    if (
      restaurant.verificationStatus &&
      restaurant.verificationStatus !== "APPROVED"
    ) {
      return res.status(409).json({
        success: false,
        message: "Restaurant is not available for ordering",
      });
    }

    const availability = isRestaurantAvailableNow(restaurant);

    if (!availability.allowed) {
      return res.status(409).json({
        success: false,
        message: availability.message,
      });
    }

    const cartItems = [];

    for (const item of cartItemsRaw) {
      if (!item.menuItem || item.menuItem.isAvailable === false) {
        return res.status(409).json({
          success: false,
          message: `${item.menuItem?.name || "Item"} is currently unavailable`,
          code: "MENU_ITEM_UNAVAILABLE",
        });
      }

      const quantity = Math.max(1, Number(item.quantity || 1));

      if (quantity > MAX_ORDER_ITEM_QUANTITY) {
        return res.status(400).json({
          success: false,
          message: `${item.menuItem.name} quantity exceeds allowed limit`,
        });
      }

      const customizationIds = Array.isArray(item.customizationJson)
        ? item.customizationJson.map((x) => x?.id).filter(Boolean)
        : [];

      const addonIds = Array.isArray(item.addonJson)
        ? item.addonJson.map((x) => x?.id).filter(Boolean)
        : [];

      const activeCustomizations = customizationIds.length
        ? await prisma.menuItemCustomization.findMany({
            where: {
              id: { in: customizationIds },
              menuItemId: item.menuItemId,
              isActive: true,
            },
          })
        : [];

      const activeAddons = addonIds.length
        ? await prisma.menuItemAddon.findMany({
            where: {
              id: { in: addonIds },
              menuItemId: item.menuItemId,
              isActive: true,
            },
          })
        : [];

      if (activeCustomizations.length !== customizationIds.length) {
        return res.status(409).json({
          success: false,
          message: `${item.menuItem.name} has an unavailable customization`,
          code: "INVALID_CUSTOMIZATION",
        });
      }

      if (activeAddons.length !== addonIds.length) {
        return res.status(409).json({
          success: false,
          message: `${item.menuItem.name} has an unavailable addon`,
          code: "INVALID_ADDON",
        });
      }

      const basePrice = toNumber(item.menuItem.price);
      const customizationTotal = activeCustomizations.reduce(
        (sum, row) => sum + toNumber(row.price),
        0
      );
      const addonTotal = activeAddons.reduce(
        (sum, row) => sum + toNumber(row.price),
        0
      );

      const unitPrice = round2(
        basePrice + customizationTotal + addonTotal
      );

      cartItems.push({
        ...item,
        quantity,
        price: unitPrice,
        totalPrice: round2(unitPrice * quantity),
        customizationJson: activeCustomizations.map((row) => ({
          id: row.id,
          title: row.title,
          price: round2(row.price),
        })),
        addonJson: activeAddons.map((row) => ({
          id: row.id,
          title: row.title,
          price: round2(row.price),
          imageUrl: row.imageUrl || null,
        })),
      });
    }

    const itemTotal = round2(
      cartItems.reduce(
        (sum, item) => sum + toNumber(item.totalPrice),
        0
      )
    );

    const minimumOrder = round2(restaurant.minimumOrder || 0);

    if (itemTotal < minimumOrder) {
      return res.status(400).json({
        success: false,
        message: `Minimum order value is ₹${minimumOrder}`,
        minimumOrder,
        shortfall: round2(minimumOrder - itemTotal),
      });
    }

    let couponId = null;
    let discount = 0;
    let freeDelivery = false;

    if (couponCode) {
      const coupon = await prisma.coupon.findUnique({
        where: {
          code: normalizeCouponCode(couponCode),
        },
      });

      if (!coupon || !coupon.isActive) {
        return res.status(400).json({
          success: false,
          message: "Invalid coupon",
        });
      }

      const now = new Date();

      if (coupon.validFrom && new Date(coupon.validFrom) > now) {
        return res.status(400).json({
          success: false,
          message: "Coupon is not active yet",
        });
      }

      if (coupon.validUntil && new Date(coupon.validUntil) < now) {
        return res.status(400).json({
          success: false,
          message: "Coupon expired",
        });
      }

      if (
        coupon.usageLimit !== null &&
        coupon.usageLimit !== undefined &&
        coupon.usedCount >= coupon.usageLimit
      ) {
        return res.status(400).json({
          success: false,
          message: "Coupon usage limit reached",
        });
      }

      if (
        coupon.scope === "RESTAURANT" &&
        coupon.restaurantId !== restaurantId
      ) {
        return res.status(400).json({
          success: false,
          message: "Coupon not valid for this restaurant",
        });
      }

      if (
        coupon.scope === "CITY" &&
        coupon.cityId !== restaurant.cityId
      ) {
        return res.status(400).json({
          success: false,
          message: "Coupon not valid in your city",
        });
      }

      if (coupon.scope === "FIRST_ORDER") {
        const orderCount = await prisma.order.count({
          where: {
            userId: req.user.id,
            status: { not: "CANCELLED" },
          },
        });

        if (orderCount > 0) {
          return res.status(400).json({
            success: false,
            message: "Coupon valid only for first order",
          });
        }
      }

      if (
        coupon.minOrder !== null &&
        coupon.minOrder !== undefined &&
        itemTotal < toNumber(coupon.minOrder)
      ) {
        return res.status(400).json({
          success: false,
          message: `Minimum order should be ₹${coupon.minOrder}`,
        });
      }

      if (
        coupon.perUserUsageLimit !== null &&
        coupon.perUserUsageLimit !== undefined
      ) {
        const userUsage = await prisma.couponRedemption.count({
          where: {
            couponId: coupon.id,
            userId: req.user.id,
          },
        });

        if (userUsage >= coupon.perUserUsageLimit) {
          return res.status(400).json({
            success: false,
            message: "You already used this coupon",
          });
        }
      }

      if (coupon.type === "PERCENT") {
        discount = (itemTotal * toNumber(coupon.value)) / 100;

        if (
          coupon.maxDiscount !== null &&
          coupon.maxDiscount !== undefined
        ) {
          discount = Math.min(
            discount,
            toNumber(coupon.maxDiscount)
          );
        }

        discount = Math.min(discount, itemTotal);
      } else if (coupon.type === "FLAT") {
        discount = Math.min(toNumber(coupon.value), itemTotal);
      } else if (coupon.type === "FREE_DELIVERY") {
        freeDelivery = true;
      }

      discount = round2(Math.max(0, discount));
      couponId = coupon.id;
    }

    const pricing = calculateOrderPricing({
      cartItems,
      restaurant,
      address,
      discount,
      freeDelivery,
    });

    const snapshot = buildCommissionSnapshot(
      restaurant,
      pricing.itemTotal,
      pricing.discount
    );

    const defaultPrepTime =
      Number(restaurant.defaultPrepTime) ||
      Math.max(
        ...cartItems.map(
          (item) => Number(item.menuItem?.prepTimeMin || 20)
        ),
        20
      );

    const order = await prisma.$transaction(async (tx) => {
      const orderNumber = await generateUniqueOrderNumber(tx);

      const newOrder = await tx.order.create({
        data: {
          userId: req.user.id,
          restaurantId,
          vendorId: restaurant.vendorId,
          addressId,

          itemTotal: pricing.itemTotal,
          deliveryFee: pricing.deliveryFee,
          distanceKm: pricing.distanceKm,
          discount: pricing.discount,
          couponId,

          taxAmount: pricing.taxAmount,
          totalAmount: pricing.totalAmount,
          platformFee: pricing.platformFee,

          cgstRate: pricing.cgstRate,
          sgstRate: pricing.sgstRate,
          cgstAmount: pricing.cgstAmount,
          sgstAmount: pricing.sgstAmount,

          commissionableAmount: snapshot.commissionableAmount,
          commissionRate: snapshot.commissionRate,
          platformCommissionAmount:
            snapshot.platformCommissionAmount,
          vendorSettlementAmount:
            snapshot.vendorSettlementAmount,

          paymentMethod: normalizedPaymentMethod,
          paymentStatus: "PENDING",

          status: "PLACED",
          orderNumber,
          customerNote: customerNote || null,
          estimatedPreparationMinutes: defaultPrepTime,

          deliveryOtp: generateDeliveryOtp(),
          deliveryOtpVerified: false,
          deliveryOtpExpiresAt: deliveryOtpExpiry(),

          items: {
            create: cartItems.map((item) => ({
              menuItemId: item.menuItemId,
              restaurantId: item.restaurantId,
              quantity: item.quantity,
              price: item.price,
              totalPrice: item.totalPrice,
              itemName: item.menuItem?.name || "Item",
              customizationJson: item.customizationJson || null,
              addonJson: item.addonJson || null,
            })),
          },

          history: {
            create: {
              status: "PLACED",
              changedBy: req.user.id,
              note: couponCode
                ? `Order placed with coupon ${normalizeCouponCode(
                    couponCode
                  )}`
                : "Order placed by customer",
            },
          },
        },
        include: orderIncludeFull,
      });

      if (couponId) {
        await tx.couponRedemption.create({
          data: {
            couponId,
            userId: req.user.id,
            orderId: newOrder.id,
            discountAmount: pricing.discount,
          },
        });

        await tx.coupon.update({
          where: { id: couponId },
          data: {
            usedCount: { increment: 1 },
          },
        });
      }

      await tx.cartItem.deleteMany({
        where: {
          userId: req.user.id,
        },
      });

      return newOrder;
    });

    const safeOrderForVendor = hideDeliveryOtp(order);

    if (order.vendorId) {
      emitNewOrder(order.vendorId, safeOrderForVendor);
      emitVendorDashboardUpdate(order.vendorId);
    }

    emitToAdmin("new-order-created", {
      order: safeOrderForVendor,
      restaurantId: order.restaurantId,
      vendorId: order.vendorId,
      cityId:
        order.restaurant?.cityId ||
        order.address?.cityId ||
        null,
    });

    emitOrderStatus(order.id, order.status, {
      order,
      message: "Order placed successfully",
    });

    const customerMsg =
      notificationTemplates.ORDER_PLACED_CUSTOMER();

    await safeNotify({
      userId: order.userId,
      type: "ORDER",
      title: customerMsg.title,
      body: customerMsg.body,
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
      },
    });

    if (order.vendorId) {
      const vendorMsg =
        notificationTemplates.ORDER_PLACED_VENDOR(
          order.restaurant?.name || "your store"
        );

      await safeNotify({
        userId: order.vendorId,
        type: "ORDER",
        title: vendorMsg.title,
        body: vendorMsg.body,
        data: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          restaurantId: order.restaurantId,
          status: order.status,
        },
      });
    }

    return res.status(201).json({
      success: true,
      message: "Order placed successfully",
      data: order,
      order,
      pricing: pricing.pricingResponse,
      paymentRequired:
        normalizedPaymentMethod !== "COD",
    });
  } catch (error) {
    console.error("Create Order Error:", error);

    if (error.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "Order conflict, please try again",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const myOrders = async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { userId: req.user.id },
      include: {
        restaurant: true,
        coupon: true,
        address: true,
        rider: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            vehicleNo: true,
            vehicleType: true,
            avatarUrl: true,
          },
        },
        items: { orderBy: { createdAt: "asc" } },
        history: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ success: true, data: orders, orders });
  } catch (error) {
    console.error("My Orders Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;

    const where = {
      id,
      ...(req.user.role === "ADMIN"
        ? {}
        : {
            OR: [
              { userId: req.user.id },
              { vendorId: req.user.id },
              { riderId: req.user.id },
            ],
          }),
    };

    const order = await prisma.order.findFirst({
      where,
      include: orderIncludeFull,
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const responseOrder =
      req.user.id === order.userId ? order : hideDeliveryOtp(order);

    return res.json({
      success: true,
      order: responseOrder,
      data: responseOrder,
    });
  } catch (error) {
    console.error("Order Detail Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const vendorOrders = async (req, res) => {
  try {
    const where =
      req.user.role === "ADMIN" ? {} : { vendorId: req.user.id };

    const orders = await prisma.order.findMany({
      where,
      include: {
        coupon: true,
        user: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
          },
        },
        restaurant: true,
        address: true,
        rider: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            vehicleNo: true,
            vehicleType: true,
            avatarUrl: true,
          },
        },
        items: { orderBy: { createdAt: "asc" } },
        history: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    });

    const safeOrders = hideDeliveryOtpFromList(orders);

    return res.json({
      success: true,
      data: safeOrders,
      orders: safeOrders,
    });
  } catch (error) {
    console.error("Vendor Orders Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const riderOrders = async (req, res) => {
  try {
    const where =
      req.user.role === "ADMIN" ? {} : { riderId: req.user.id };

    const orders = await prisma.order.findMany({
      where,
      include: orderIncludeFull,
      orderBy: { createdAt: "desc" },
    });

    const safeOrders = hideDeliveryOtpFromList(orders);

    return res.json({
      success: true,
      data: safeOrders,
      orders: safeOrders,
    });
  } catch (error) {
    console.error("Rider Orders Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body;

    const allowedStatuses = Object.keys(allowedTransitions);

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order status",
      });
    }

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        restaurant: true,
        user: true,
        rider: true,
        paymentTransactions: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    if (["DELIVERED", "CANCELLED"].includes(order.status)) {
      return res.status(409).json({
        success: false,
        message: `Order is already ${order.status.toLowerCase()}`,
      });
    }

    const nextStatuses = allowedTransitions[order.status] || [];

    if (!nextStatuses.includes(status)) {
      return res.status(409).json({
        success: false,
        message: `Order cannot move from ${order.status} to ${status}`,
      });
    }

    if (req.user.role === "CUSTOMER") {
      if (order.userId !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: "You cannot update this order",
        });
      }

      if (status !== "CANCELLED") {
        return res.status(403).json({
          success: false,
          message: "Customer can only cancel an eligible order",
        });
      }

      if (!["PLACED", "ACCEPTED_BY_VENDOR"].includes(order.status)) {
        return res.status(409).json({
          success: false,
          message: "This order can no longer be cancelled",
        });
      }
    }

    if (req.user.role === "VENDOR") {
      if (order.vendorId !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: "You cannot update this order",
        });
      }

      if (
        ![
          "ACCEPTED_BY_VENDOR",
          "PREPARING",
          "READY_FOR_PICKUP",
          "CANCELLED",
        ].includes(status)
      ) {
        return res.status(403).json({
          success: false,
          message: "Vendor cannot set this status",
        });
      }
    }

    if (req.user.role === "RIDER") {
      if (order.riderId !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: "You cannot update this order",
        });
      }

      if (!["PICKED_UP", "OUT_FOR_DELIVERY"].includes(status)) {
        return res.status(403).json({
          success: false,
          message:
            "Rider delivery completion must use the OTP-protected rider flow",
        });
      }
    }

    const timeFieldMap = {
      ACCEPTED_BY_VENDOR: "acceptedAt",
      PREPARING: "preparingAt",
      READY_FOR_PICKUP: "readyAt",
      PICKED_UP: "pickedAt",
      OUT_FOR_DELIVERY: "outForDeliveryAt",
      DELIVERED: "deliveredAt",
      CANCELLED: "cancelledAt",
    };

    const updateData = { status };

    if (timeFieldMap[status]) {
      updateData[timeFieldMap[status]] = new Date();
    }

    if (status === "CANCELLED") {
      updateData.cancelReason =
        note ||
        (req.user.role === "CUSTOMER"
          ? "Cancelled by customer"
          : "Order cancelled");
      updateData.cancelledBy = req.user.id;
    }

    if (
      status === "DELIVERED" &&
      isPrepaidMethod(order.paymentMethod) &&
      order.paymentStatus !== "PAID"
    ) {
      return res.status(409).json({
        success: false,
        message: "Payment is not confirmed for this order",
      });
    }

    const updatedOrder = await prisma.$transaction(async (tx) => {
      let finalPaymentStatus = order.paymentStatus;

      if (status === "DELIVERED" && order.paymentMethod === "COD") {
        finalPaymentStatus = "PAID";
        updateData.paymentStatus = "PAID";
      }

      const updated = await tx.order.update({
        where: { id },
        data: updateData,
        include: orderIncludeFull,
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          status,
          changedBy: req.user.id,
          note: note || null,
        },
      });

      if (status === "CANCELLED") {
        await createRefundIfRequired(tx, order, updateData.cancelReason);
      }

      if (status === "DELIVERED") {
        await ensureDeliveredSettlements(tx, {
          ...updated,
          paymentStatus: finalPaymentStatus,
          restaurant: order.restaurant,
        });
      }

      return updated;
    });

    let customerMsg = null;
    let vendorMsg = null;
    let riderMsg = null;

    if (status === "ACCEPTED_BY_VENDOR") {
      customerMsg =
        notificationTemplates.ORDER_ACCEPTED_CUSTOMER(
          order.restaurant?.name || "Store"
        );
    }

    if (status === "PREPARING") {
      customerMsg =
        notificationTemplates.ORDER_PREPARING_CUSTOMER();
    }

    if (status === "READY_FOR_PICKUP") {
      vendorMsg =
        notificationTemplates.ORDER_READY_VENDOR();
    }

    if (status === "ASSIGNED_TO_RIDER") {
      riderMsg =
        notificationTemplates.ORDER_ASSIGNED_RIDER();
    }

    if (status === "OUT_FOR_DELIVERY") {
      customerMsg =
        notificationTemplates.ORDER_OUT_FOR_DELIVERY_CUSTOMER();
    }

    if (status === "DELIVERED") {
      customerMsg =
        notificationTemplates.ORDER_DELIVERED_CUSTOMER();
    }

    if (status === "CANCELLED") {
      customerMsg =
        notificationTemplates.ORDER_CANCELLED_CUSTOMER();
    }

    if (customerMsg) {
      await safeNotify({
        userId: order.userId,
        type: "ORDER",
        title: customerMsg.title,
        body: customerMsg.body,
        data: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          status,
        },
      });
    }

    if (vendorMsg && order.vendorId) {
      await safeNotify({
        userId: order.vendorId,
        type: "ORDER",
        title: vendorMsg.title,
        body: vendorMsg.body,
        data: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          status,
        },
      });
    }

    if (riderMsg && order.riderId) {
      await safeNotify({
        userId: order.riderId,
        type: "ORDER",
        title: riderMsg.title,
        body: riderMsg.body,
        data: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          status,
        },
      });
    }

    const safeOrderForNonCustomer =
      hideDeliveryOtp(updatedOrder);

    emitOrderStatus(id, status, {
      order:
        req.user.id === updatedOrder.userId
          ? updatedOrder
          : safeOrderForNonCustomer,
    });

    if (updatedOrder.vendorId) {
      emitVendorDashboardUpdate(updatedOrder.vendorId);
    }

    emitToAdmin("order-status-updated", {
      order: safeOrderForNonCustomer,
      status,
    });

    if (status === "READY_FOR_PICKUP") {
      await notifyAvailableRiders(updatedOrder);
    }

    return res.json({
      success: true,
      message:
        status === "CANCELLED" &&
        isPrepaidMethod(order.paymentMethod) &&
        order.paymentStatus === "PAID"
          ? "Order cancelled. Refund has been requested."
          : "Order status updated",
      order:
        req.user.id === updatedOrder.userId
          ? updatedOrder
          : safeOrderForNonCustomer,
      data:
        req.user.id === updatedOrder.userId
          ? updatedOrder
          : safeOrderForNonCustomer,
    });
  } catch (error) {
    console.error("Update Order Status Error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const cancelMyOrder = async (req, res) => {
  req.body = {
    ...req.body,
    status: "CANCELLED",
    note:
      req.body?.reason ||
      req.body?.note ||
      "Cancelled by customer",
  };

  return updateOrderStatus(req, res);
};

export const getMyOrderPaymentStatus = async (req, res) => {
  try {
    const order = await prisma.order.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        paymentMethod: true,
        paymentStatus: true,
        totalAmount: true,
        refundAmount: true,
        refunds: {
          orderBy: { createdAt: "desc" },
        },
        paymentTransactions: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    return res.json({
      success: true,
      payment: {
        ...order,
        totalAmount: round2(order.totalAmount),
        refundAmount: round2(order.refundAmount),
        refunds: (order.refunds || []).map((refund) => ({
          ...refund,
          amount: round2(refund.amount),
        })),
      },
    });
  } catch (error) {
    console.error("Order Payment Status Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch payment status",
    });
  }
};
