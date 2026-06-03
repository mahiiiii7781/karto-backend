import prisma from "../prisma.js";
import {
  emitOrderStatus,
  emitNewOrder,
  emitVendorDashboardUpdate,
} from "../config/socket.js";
import {
  sendPushToUser,
  notificationTemplates,
} from "../services/notification.service.js";

const generateOrderNumber = () => {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const random = Math.floor(1000 + Math.random() * 9000);

  return `KT${y}${m}${d}${random}`;
};

const toNumber = value => Number(value || 0);

const round2 = value =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const PLATFORM_FEE = round2(process.env.KARTO_PLATFORM_FEE || 5);
const CGST_RATE = round2(process.env.KARTO_CGST_RATE || 2.5);
const SGST_RATE = round2(process.env.KARTO_SGST_RATE || 2.5);

const normalizeCouponCode = code => String(code || "").trim().toUpperCase();

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

const calculateOrderPricing = ({ cartItems, restaurant, discount = 0 }) => {
  const itemTotal = round2(
    cartItems.reduce((sum, item) => sum + toNumber(item.totalPrice), 0)
  );

  const deliveryFee = round2(restaurant?.deliveryFee || 0);
  const platformFee = PLATFORM_FEE;

  const cgstAmount = round2((itemTotal * CGST_RATE) / 100);
  const sgstAmount = round2((itemTotal * SGST_RATE) / 100);
  const taxAmount = round2(cgstAmount + sgstAmount);

  const totalAmount = round2(
    itemTotal + deliveryFee + platformFee + taxAmount - discount
  );

  return {
    itemTotal,
    deliveryFee,
    platformFee,
    cgstRate: CGST_RATE,
    sgstRate: SGST_RATE,
    cgstAmount,
    sgstAmount,
    taxAmount,
    discount: round2(discount),
    totalAmount,
    pricingResponse: {
      cartValue: itemTotal,
      subtotal: itemTotal,
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
      totalAmount,
      grandTotal: totalAmount,
    },
  };
};

const safeNotify = async payload => {
  try {
    if (!payload?.userId) return;
    await sendPushToUser(payload);
  } catch (error) {
    console.error("Notification Error:", error.message);
  }
};

const parseTimeToMinutes = value => {
  if (!value) return null;
  const [h, m] = String(value).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};

const getDayName = date =>
  date.toLocaleDateString("en-IN", { weekday: "long" }).toLowerCase();

const isRestaurantAvailableNow = restaurant => {
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

    let isInsideTime = false;

    if (openMinutes <= closeMinutes) {
      isInsideTime =
        currentMinutes >= openMinutes && currentMinutes <= closeMinutes;
    } else {
      isInsideTime =
        currentMinutes >= openMinutes || currentMinutes <= closeMinutes;
    }

    if (!isInsideTime) {
      return {
        allowed: false,
        message: `Store accepts orders from ${restaurant.openingTime} to ${restaurant.closingTime}`,
      };
    }
  }

  return { allowed: true, message: "Store is available" };
};

export const createOrder = async (req, res) => {
  try {
    const { addressId, paymentMethod = "COD", customerNote, couponCode } = req.body;

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

    const cartItems = await prisma.cartItem.findMany({
      where: { userId: req.user.id },
      include: {
        menuItem: true,
        restaurant: true,
      },
      orderBy: { createdAt: "asc" },
    });

    if (!cartItems.length) {
      return res.status(400).json({
        success: false,
        message: "Cart is empty",
      });
    }

    const restaurantId = cartItems[0].restaurantId;

    const hasDifferentRestaurant = cartItems.some(
      item => item.restaurantId !== restaurantId
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

    const availability = isRestaurantAvailableNow(restaurant);

    if (!availability.allowed) {
      return res.status(400).json({
        success: false,
        message: availability.message,
      });
    }

    const unavailableItem = cartItems.find(item => {
      return !item.menuItem || item.menuItem.isAvailable === false;
    });

    if (unavailableItem) {
      return res.status(400).json({
        success: false,
        message: `${unavailableItem.menuItem?.name || "Item"} is currently unavailable`,
      });
    }

    const itemTotal = round2(
      cartItems.reduce((sum, item) => sum + toNumber(item.totalPrice), 0)
    );

    const deliveryFeeForCoupon = round2(restaurant.deliveryFee);

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
      discount,
    });

    const defaultPrepTime =
      Number(restaurant.defaultPrepTime) ||
      Math.max(
        ...cartItems.map(item => Number(item.menuItem?.prepTimeMin || 20)),
        20
      );

    const order = await prisma.$transaction(async tx => {
      const newOrder = await tx.order.create({
        data: {
          userId: req.user.id,
          restaurantId,
          vendorId: restaurant.vendorId,
          addressId,

          itemTotal: pricing.itemTotal,
          deliveryFee: pricing.deliveryFee,
          discount: pricing.discount,
          couponId,
          taxAmount: pricing.taxAmount,
          totalAmount: pricing.totalAmount,

          paymentMethod,
          paymentStatus: "PENDING",
          status: "PLACED",

          orderNumber: generateOrderNumber(),
          customerNote: customerNote || null,
          estimatedPreparationMinutes: defaultPrepTime,

          items: {
            create: cartItems.map(item => ({
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
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              phone: true,
              email: true,
            },
          },
          items: {
            include: {
              menuItem: true,
            },
            orderBy: { createdAt: "asc" },
          },
          restaurant: true,
          coupon: true,
          history: true,
          address: true,
        },
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

    if (order.vendorId) {
      emitNewOrder(order.vendorId, order);
      emitVendorDashboardUpdate(order.vendorId);
    }

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
        items: { orderBy: { createdAt: "asc" } },
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

    const order = await prisma.order.findFirst({
      where: {
        id,
        OR: [
          { userId: req.user.id },
          { vendorId: req.user.id },
          { riderId: req.user.id },
        ],
      },
      include: {
        restaurant: true,
        coupon: true,
        items: { orderBy: { createdAt: "asc" } },
        history: { orderBy: { createdAt: "asc" } },
        rider: {
          select: {
            id: true,
            fullName: true,
            phone: true,
          },
        },
      },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    return res.json({ success: true, order, data: order });
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
    const orders = await prisma.order.findMany({
      where: { vendorId: req.user.id },
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
        items: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ success: true, data: orders, orders });
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
    const orders = await prisma.order.findMany({
      where: { riderId: req.user.id },
      include: {
        coupon: true,
        user: {
          select: {
            id: true,
            fullName: true,
            phone: true,
          },
        },
        restaurant: true,
        items: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ success: true, data: orders, orders });
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

    const timeFieldMap = {
      ACCEPTED_BY_VENDOR: "acceptedAt",
      PREPARING: "preparingAt",
      READY_FOR_PICKUP: "readyAt",
      PICKED_UP: "pickedAt",
      DELIVERED: "deliveredAt",
      CANCELLED: "cancelledAt",
    };

    const updateData = { status };

    if (timeFieldMap[status]) {
      updateData[timeFieldMap[status]] = new Date();
    }

    const updatedOrder = await prisma.$transaction(async tx => {
      const updated = await tx.order.update({
        where: { id },
        data: updateData,
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
          const commissionAmount = round2((grossAmount * commissionPercent) / 100);
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
              amount: 30,
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

    emitOrderStatus(id, status, { order: updatedOrder });

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