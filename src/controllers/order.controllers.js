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
}) => {
  const itemTotal = round2(
    cartItems.reduce((sum, item) => sum + toNumber(item.totalPrice), 0)
  );

  const distanceKm = calculateDistanceKm(
    restaurant?.latitude,
    restaurant?.longitude,
    address?.latitude,
    address?.longitude
  );

  const deliveryFee = round2(calculateDeliveryFee(itemTotal, distanceKm));
  const platformFee = PLATFORM_FEE;

  const cgstAmount = round2((itemTotal * CGST_RATE) / 100);
  const sgstAmount = round2((itemTotal * SGST_RATE) / 100);
  const taxAmount = round2(cgstAmount + sgstAmount);

  const totalAmount = round2(
    itemTotal + deliveryFee + platformFee + taxAmount - discount
  );

  return {
    itemTotal,
    distanceKm,
    deliveryFee,
    platformFee,
    cgstRate: CGST_RATE,
    sgstRate: SGST_RATE,
    cgstAmount,
    sgstAmount,
    taxAmount,
    discount: round2(discount),
    totalAmount: Math.max(0, totalAmount),
    pricingResponse: {
      cartValue: itemTotal,
      subtotal: itemTotal,
      distanceKm,
      deliveryFee,
      platformFee,
      tax: {
        cgstRate: CGST_RATE,
        sgstRate: SGST_RATE,
        cgst: cgstAmount,
        sgst: sgstAmount,
        total: taxAmount,
      },
      taxAmount,
      discount: round2(discount),
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

    if (!addressId) {
      return res.status(400).json({
        success: false,
        message: "Please select delivery address",
      });
    }

    if (!["COD", "ONLINE", "WALLET"].includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment method",
      });
    }

    const cartItemsRaw = await prisma.cartItem.findMany({
      where: { userId: req.user.id },
      include: {
        menuItem: true,
        restaurant: true,
      },
      orderBy: { createdAt: "asc" },
    });

    if (!cartItemsRaw.length) {
      return res.status(400).json({
        success: false,
        message: "Cart is empty",
      });
    }

    const restaurantId = cartItemsRaw[0].restaurantId;

    const hasDifferentRestaurant = cartItemsRaw.some(
      (item) => item.restaurantId !== restaurantId
    );

    if (hasDifferentRestaurant) {
      return res.status(400).json({
        success: false,
        message: "Cart contains items from multiple stores",
      });
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: { timings: true },
    });

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found",
      });
    }

    const address = await prisma.userAddress.findFirst({
      where: {
        id: addressId,
        userId: req.user.id,
      },
    });

    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Delivery address not found",
      });
    }

    const availability = isRestaurantAvailableNow(restaurant);

    if (!availability.allowed) {
      return res.status(400).json({
        success: false,
        message: availability.message,
      });
    }

    const unavailableItem = cartItemsRaw.find(
      (item) => !item.menuItem || item.menuItem.isAvailable === false
    );

    if (unavailableItem) {
      return res.status(400).json({
        success: false,
        message: `${
          unavailableItem.menuItem?.name || "Item"
        } is currently unavailable`,
      });
    }

    const cartItems = cartItemsRaw.map((item) => {
      const freshPricing = calculateFreshCartItemPricing(item);

      return {
        ...item,
        quantity: freshPricing.quantity,
        price: freshPricing.unitPrice,
        totalPrice: freshPricing.totalPrice,
      };
    });

    const itemTotal = round2(
      cartItems.reduce((sum, item) => sum + toNumber(item.totalPrice), 0)
    );

    const distanceKmForCoupon = calculateDistanceKm(
      restaurant?.latitude,
      restaurant?.longitude,
      address?.latitude,
      address?.longitude
    );

    const deliveryFeeForCoupon = round2(
      calculateDeliveryFee(itemTotal, distanceKmForCoupon)
    );

    let discount = 0;
    let couponId = null;

    if (couponCode) {
      const coupon = await prisma.coupon.findUnique({
        where: { code: normalizeCouponCode(couponCode) },
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

      if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
        return res.status(400).json({
          success: false,
          message: "Coupon usage limit reached",
        });
      }

      if (coupon.scope === "RESTAURANT" && coupon.restaurantId !== restaurantId) {
        return res.status(400).json({
          success: false,
          message: "Coupon not valid for this restaurant",
        });
      }

      if (coupon.scope === "CITY" && coupon.cityId !== restaurant.cityId) {
        return res.status(400).json({
          success: false,
          message: "Coupon not valid in your city",
        });
      }

      if (coupon.scope === "FIRST_ORDER") {
        const orderCount = await prisma.order.count({
          where: { userId: req.user.id },
        });

        if (orderCount > 0) {
          return res.status(400).json({
            success: false,
            message: "Coupon valid only for first order",
          });
        }
      }

      if (coupon.minOrder && itemTotal < toNumber(coupon.minOrder)) {
        return res.status(400).json({
          success: false,
          message: `Minimum order should be ₹${coupon.minOrder}`,
        });
      }

      const userUsage = await prisma.couponRedemption.count({
        where: {
          couponId: coupon.id,
          userId: req.user.id,
        },
      });

      if (coupon.perUserUsageLimit && userUsage >= coupon.perUserUsageLimit) {
        return res.status(400).json({
          success: false,
          message: "You already used this coupon",
        });
      }

      discount = calculateCouponDiscount({
        coupon,
        itemTotal,
        deliveryFee: deliveryFeeForCoupon,
      });

      couponId = coupon.id;
    }

    const pricing = calculateOrderPricing({
      cartItems,
      restaurant,
      address,
      discount,
    });

    const defaultPrepTime =
      Number(restaurant.defaultPrepTime) ||
      Math.max(
        ...cartItems.map((item) => Number(item.menuItem?.prepTimeMin || 20)),
        20
      );

    const paymentStatus = paymentMethod === "COD" ? "PENDING" : "PENDING";

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
          paymentMethod,
          paymentStatus,
          status: "PLACED",
          orderNumber,
          customerNote: customerNote || null,
          estimatedPreparationMinutes: defaultPrepTime,

          // Delivery OTP is generated when order is created.
          // It should be shown only to customer/user app.
          // Rider will enter this OTP at delivery time to complete order.
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
                ? `Order placed with coupon ${normalizeCouponCode(couponCode)}`
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
          data: { usedCount: { increment: 1 } },
        });
      }

      await tx.cartItem.deleteMany({
        where: { userId: req.user.id },
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
      cityId: order.restaurant?.cityId || order.address?.cityId || null,
    });

    emitOrderStatus(order.id, order.status, {
      order,
      message: "Order placed successfully",
    });

    const customerMsg = notificationTemplates.ORDER_PLACED_CUSTOMER();

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
      const vendorMsg = notificationTemplates.ORDER_PLACED_VENDOR(
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
    });
  } catch (error) {
    console.error("Create Order Error:", error);

    if (error.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "Order number conflict, please try again",
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

    const allowedStatuses = [
      "ACCEPTED_BY_VENDOR",
      "PREPARING",
      "READY_FOR_PICKUP",
      "ASSIGNED_TO_RIDER",
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "CANCELLED",
    ];

    const vendorAllowedStatuses = [
      "ACCEPTED_BY_VENDOR",
      "PREPARING",
      "READY_FOR_PICKUP",
      "CANCELLED",
    ];

    const riderAllowedStatuses = [
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
    ];

    const adminAllowedStatuses = allowedStatuses;

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
      },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    if (["DELIVERED", "CANCELLED"].includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: `Order is already ${order.status.toLowerCase()}`,
      });
    }

    if (req.user.role === "VENDOR") {
      if (order.vendorId !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: "You cannot update this order",
        });
      }

      if (!vendorAllowedStatuses.includes(status)) {
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

      if (!riderAllowedStatuses.includes(status)) {
        return res.status(403).json({
          success: false,
          message: "Rider cannot set this status",
        });
      }
    }

    if (req.user.role === "ADMIN") {
      if (!adminAllowedStatuses.includes(status)) {
        return res.status(403).json({
          success: false,
          message: "Admin cannot set this status",
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

    const updatedOrder = await prisma.$transaction(async (tx) => {
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

      if (status === "DELIVERED") {
        const existingVendorSettlement = await tx.vendorSettlement.findFirst({
          where: { orderId: order.id },
        });

        if (!existingVendorSettlement && order.vendorId) {
          const grossAmount = toNumber(order.totalAmount);
          const commissionPercent = toNumber(order.restaurant?.commission || 10);
          const commissionAmount = round2(
            (grossAmount * commissionPercent) / 100
          );
          const netAmount = round2(grossAmount - commissionAmount);

          await tx.vendorSettlement.create({
            data: {
              vendorId: order.vendorId,
              restaurantId: order.restaurantId,
              orderId: order.id,
              grossAmount,
              commissionAmount,
              netAmount,
              status: "PENDING",
            },
          });
        }

        const existingRiderSettlement = await tx.riderSettlement.findFirst({
          where: { orderId: order.id },
        });

        if (!existingRiderSettlement && order.riderId) {
          await tx.riderSettlement.create({
            data: {
              riderId: order.riderId,
              orderId: order.id,
              amount: toNumber(order.deliveryFee || 30),
              status: "PENDING",
            },
          });
        }
      }

      return updated;
    });

    let customerMsg = null;
    let vendorMsg = null;
    let riderMsg = null;

    if (status === "ACCEPTED_BY_VENDOR") {
      customerMsg = notificationTemplates.ORDER_ACCEPTED_CUSTOMER(
        order.restaurant?.name || "Store"
      );
    }

    if (status === "PREPARING") {
      customerMsg = notificationTemplates.ORDER_PREPARING_CUSTOMER();
    }

    if (status === "READY_FOR_PICKUP") {
      vendorMsg = notificationTemplates.ORDER_READY_VENDOR();
    }

    if (status === "ASSIGNED_TO_RIDER") {
      riderMsg = notificationTemplates.ORDER_ASSIGNED_RIDER();
    }

    if (status === "OUT_FOR_DELIVERY") {
      customerMsg = notificationTemplates.ORDER_OUT_FOR_DELIVERY_CUSTOMER();
    }

    if (status === "DELIVERED") {
      customerMsg = notificationTemplates.ORDER_DELIVERED_CUSTOMER();
    }

    if (status === "CANCELLED") {
      customerMsg = notificationTemplates.ORDER_CANCELLED_CUSTOMER();
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

    const safeOrderForNonCustomer = hideDeliveryOtp(updatedOrder);

    emitOrderStatus(id, status, {
      order:
        status === "DELIVERED" || status === "CANCELLED"
          ? safeOrderForNonCustomer
          : updatedOrder,
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
      message: "Order status updated",
      order: updatedOrder,
      data: updatedOrder,
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
