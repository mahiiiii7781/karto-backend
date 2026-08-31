import prisma from "../prisma.js";
import { getIO } from "../socket.js";
import { uploadToCloudinary } from "../utils/cloudinaryUpload.js";

const amountNumber = (v) => Number(v || 0);


const boolValue = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on", "online", "available"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off", "offline", "unavailable"].includes(normalized)) {
    return false;
  }
  return fallback;
};

const cleanString = (value) =>
  value === undefined || value === null ? undefined : String(value).trim();

const safeInt = (value, fallback = 0) => {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) ? number : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const validLatitude = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= -90 && n <= 90;
};

const validLongitude = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= -180 && n <= 180;
};

const pageParams = (req, defaultLimit = 20, maxLimit = 100) => {
  const page = Math.max(1, safeInt(req.query?.page, 1));
  const limit = clamp(safeInt(req.query?.limit, defaultLimit), 1, maxLimit);
  return { page, limit, skip: (page - 1) * limit };
};

const activeDeliveryStatuses = [
  "ASSIGNED_TO_RIDER",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
];

const riderCanWork = (rider) =>
  Boolean(rider?.isActive) &&
  !rider?.deletedAt &&
  !rider?.blockedAt &&
  rider?.kycStatus !== "REJECTED";

const uploadFile = async (req, folder) => {
  if (!req.file) return undefined;
  return uploadToCloudinary(req.file, folder);
};

const getRiderCore = async (riderId) =>
  prisma.user.findFirst({
    where: { id: riderId, role: "RIDER" },
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      avatarUrl: true,
      cityId: true,
      address: true,
      vehicleNo: true,
      vehicleType: true,
      isActive: true,
      isOnline: true,
      kycStatus: true,
      kycRejectionReason: true,
      lastSeen: true,
      blockedAt: true,
      blockedReason: true,
      deletedAt: true,
      city: true,
      riderProfile: true,
    },
  });

const ensureRiderProfile = async (riderId) =>
  prisma.riderProfile.upsert({
    where: { userId: riderId },
    update: {},
    create: { userId: riderId },
  });

const syncAvailability = async (riderId, availabilityStatus) => {
  try {
    await prisma.riderProfile.upsert({
      where: { userId: riderId },
      update: { availabilityStatus },
      create: { userId: riderId, availabilityStatus },
    });
  } catch (error) {
    console.error("Rider availability sync error:", error?.message || error);
  }
};

const closeOpenAvailabilityLog = async (
  tx,
  riderId,
  { latitude, longitude } = {}
) => {
  const openLog = await tx.riderAvailabilityLog.findFirst({
    where: { riderId, offlineAt: null },
    orderBy: { onlineAt: "desc" },
  });

  if (!openLog) return null;

  return tx.riderAvailabilityLog.update({
    where: { id: openLog.id },
    data: {
      offlineAt: new Date(),
      ...(validLatitude(latitude) && { endLatitude: Number(latitude) }),
      ...(validLongitude(longitude) && { endLongitude: Number(longitude) }),
    },
  });
};

const progressRiderIncentives = async (tx, riderId) => {
  const now = new Date();
  const incentives = await tx.riderIncentive.findMany({
    where: {
      riderId,
      isCompleted: false,
      startDate: { lte: now },
      endDate: { gte: now },
    },
  });

  for (const incentive of incentives) {
    const nextCompletedOrders = incentive.completedOrders + 1;
    await tx.riderIncentive.update({
      where: { id: incentive.id },
      data: {
        completedOrders: nextCompletedOrders,
        isCompleted: nextCompletedOrders >= incentive.targetOrders,
      },
    });
  }
};

const finalizeDelivery = async ({
  riderId,
  orderId,
  requireOtpVerified = true,
}) => {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: {
        id: orderId,
        riderId,
        status: { in: ["PICKED_UP", "OUT_FOR_DELIVERY"] },
      },
      include: {
        restaurant: true,
        rider: true,
        vendor: true,
        refunds: true,
      },
    });

    if (!order) {
      const error = new Error("Order not found or already completed");
      error.statusCode = 400;
      throw error;
    }

    if (
      requireOtpVerified &&
      order.deliveryOtp &&
      !order.deliveryOtpVerified
    ) {
      const error = new Error("Verify customer delivery OTP before completing the order");
      error.statusCode = 400;
      throw error;
    }

    if (order.paymentMethod !== "COD" && order.paymentStatus !== "PAID") {
      const error = new Error("Online payment is not confirmed for this order");
      error.statusCode = 409;
      throw error;
    }

    const earningAmount = getRiderEarningAmount(order);
    const deliveredAt = new Date();

    const updatedOrder = await tx.order.update({
      where: { id: order.id },
      data: {
        status: "DELIVERED",
        deliveredAt,
        paymentStatus: order.paymentMethod === "COD" ? "PAID" : order.paymentStatus,
        history: {
          create: {
            status: "DELIVERED",
            changedBy: riderId,
            note: order.deliveryOtp
              ? "Order delivered after customer OTP verification"
              : "Order delivered successfully by rider",
          },
        },
      },
      include: orderInclude,
    });

    const earning = await tx.riderEarning.upsert({
      where: {
        riderId_orderId: {
          riderId,
          orderId: order.id,
        },
      },
      update: {},
      create: {
        riderId,
        orderId: order.id,
        amount: earningAmount,
        note: `Earning from order ${order.orderNumber}`,
      },
    });

    const earningWasAlreadyCredited = await tx.riderSettlement.findUnique({
      where: { orderId: order.id },
    });

    let wallet;
    if (!earningWasAlreadyCredited) {
      wallet = await tx.riderWallet.upsert({
        where: { riderId },
        update: {
          balance: { increment: earningAmount },
          todayEarn: { increment: earningAmount },
          totalEarn: { increment: earningAmount },
        },
        create: {
          riderId,
          balance: earningAmount,
          todayEarn: earningAmount,
          totalEarn: earningAmount,
        },
      });
    } else {
      wallet = await tx.riderWallet.upsert({
        where: { riderId },
        update: {},
        create: { riderId },
      });
    }

    const settlement = await tx.riderSettlement.upsert({
      where: { orderId: order.id },
      update: {
        riderId,
        amount: earningAmount,
      },
      create: {
        riderId,
        orderId: order.id,
        amount: earningAmount,
        status: "PENDING",
        periodStart: deliveredAt,
        periodEnd: deliveredAt,
      },
    });

    let coupon = await tx.riderCoupon.findFirst({
      where: { riderId, orderId: order.id },
    });

    if (!coupon) {
      coupon = await tx.riderCoupon.create({
        data: {
          riderId,
          orderId: order.id,
          code: couponCode(),
          title: "Delivery Earning Coupon",
          amount: earningAmount,
          message: `Congratulations! You earned ₹${earningAmount} from order ${order.orderNumber}.`,
        },
      });
    }

    await progressRiderIncentives(tx, riderId);

    await tx.riderProfile.upsert({
      where: { userId: riderId },
      update: {
        availabilityStatus: "AVAILABLE",
        totalDeliveries: { increment: 1 },
      },
      create: {
        userId: riderId,
        availabilityStatus: "AVAILABLE",
        totalDeliveries: 1,
      },
    });

    await tx.riderLocation.deleteMany({
      where: { riderId, orderId: order.id },
    });

    return {
      updatedOrder,
      earning,
      wallet,
      settlement,
      coupon,
    };
  });
};

const todayStart = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const weekStart = () => {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

const monthStart = () => {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
};

const couponCode = () =>
  "KARTO-RIDER-" + Math.random().toString(36).substring(2, 8).toUpperCase();

const getRiderEarningAmount = (order) => amountNumber(order.deliveryFee);

const orderInclude = {
  user: {
    select: {
      id: true,
      fullName: true,
      phone: true,
      avatarUrl: true,
    },
  },
  restaurant: {
    select: {
      id: true,
      name: true,
      ownerName: true,
      ownerMobileNo: true,
      phone: true,
      email: true,
      address: true,
      latitude: true,
      longitude: true,
      imageUrl: true,
      deliveryTime: true,
    },
  },
  address: true,
  items: true,
  history: {
    orderBy: { createdAt: "desc" },
  },
};

const cleanOrder = (order) => {
  if (!order) return null;

  return {
    ...order,
    totalAmount: amountNumber(order.totalAmount),
    itemTotal: amountNumber(order.itemTotal),
    deliveryFee: amountNumber(order.deliveryFee),
    distanceKm: order.distanceKm ? amountNumber(order.distanceKm) : null,
    discount: amountNumber(order.discount),
    taxAmount: amountNumber(order.taxAmount),
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
    deliveryAddress: order.address || null,
    pickupAddress: order.restaurant?.address || null,
  };
};

const emitOrderUpdate = (orderId, event, payload) => {
  const io = getIO();
  if (!io) return;

  io.to(`order-${orderId}`).emit("order-updated", payload);
  io.emit(event, payload);
};

export const getRiderDashboard = async (req, res) => {
  try {
    const riderId = req.user.id;
    const start = todayStart();

    const [rider, profile, wallet, todayEarnings, activeOrders, deliveredCount, todayDelivered] =
      await Promise.all([
        getRiderCore(riderId),
        ensureRiderProfile(riderId),
        prisma.riderWallet.upsert({
          where: { riderId },
          update: {},
          create: { riderId },
        }),
        prisma.riderEarning.findMany({
          where: { riderId, createdAt: { gte: start } },
          orderBy: { createdAt: "desc" },
        }),
        prisma.order.findMany({
          where: { riderId, status: { in: activeDeliveryStatuses } },
          include: orderInclude,
          orderBy: { updatedAt: "desc" },
        }),
        prisma.order.count({
          where: { riderId, status: "DELIVERED" },
        }),
        prisma.order.count({
          where: {
            riderId,
            status: "DELIVERED",
            deliveredAt: { gte: start },
          },
        }),
      ]);

    if (!rider) {
      return res.status(404).json({
        success: false,
        message: "Rider account not found",
      });
    }

    const todayEarning = todayEarnings.reduce(
      (sum, item) => sum + amountNumber(item.amount),
      0
    );

    return res.json({
      success: true,
      dashboard: {
        rider: {
          ...rider,
          profile,
        },
        stats: {
          todayEarnings: todayEarning,
          totalEarnings: amountNumber(wallet.totalEarn),
          walletBalance: amountNumber(wallet.balance),
          activeOrders: activeOrders.length,
          todayOrders: todayDelivered,
          deliveredOrders: deliveredCount,
          rating: amountNumber(profile.rating),
          totalRatings: profile.totalRatings,
          totalDeliveries: profile.totalDeliveries,
        },
        canWork: riderCanWork(rider),
        activeOrder: activeOrders[0] ? cleanOrder(activeOrders[0]) : null,
      },
    });
  } catch (error) {
    console.error("Rider Dashboard Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch rider dashboard",
    });
  }
};

export const updateOnlineStatus = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { isOnline, latitude, longitude } = req.body;
    const requestedOnline = boolValue(isOnline, false);

    const rider = await getRiderCore(riderId);

    if (!rider) {
      return res.status(404).json({
        success: false,
        message: "Rider not found",
      });
    }

    if (requestedOnline && !riderCanWork(rider)) {
      return res.status(403).json({
        success: false,
        message:
          !rider.isActive
            ? "Rider account is inactive"
            : rider.kycStatus === "REJECTED"
            ? rider.kycRejectionReason || "KYC was rejected. Please update your documents."
            : rider.blockedReason || "Rider account cannot go online",
      });
    }

    const activeOrderCount = await prisma.order.count({
      where: { riderId, status: { in: activeDeliveryStatuses } },
    });

    if (!requestedOnline && activeOrderCount > 0) {
      return res.status(409).json({
        success: false,
        message: "Complete your active delivery before going offline",
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: riderId },
        data: {
          isOnline: requestedOnline,
          lastSeen: new Date(),
        },
        select: {
          id: true,
          fullName: true,
          isOnline: true,
          lastSeen: true,
        },
      });

      if (requestedOnline) {
        const openLog = await tx.riderAvailabilityLog.findFirst({
          where: { riderId, offlineAt: null },
          orderBy: { onlineAt: "desc" },
        });

        if (!openLog) {
          await tx.riderAvailabilityLog.create({
            data: {
              riderId,
              ...(validLatitude(latitude) && { startLatitude: Number(latitude) }),
              ...(validLongitude(longitude) && { startLongitude: Number(longitude) }),
            },
          });
        }
      } else {
        await closeOpenAvailabilityLog(tx, riderId, { latitude, longitude });
      }

      await tx.riderProfile.upsert({
        where: { userId: riderId },
        update: {
          availabilityStatus: requestedOnline ? "AVAILABLE" : "OFFLINE",
        },
        create: {
          userId: riderId,
          availabilityStatus: requestedOnline ? "AVAILABLE" : "OFFLINE",
        },
      });

      return updated;
    });

    getIO()?.emit("rider-online-status-changed", result);

    return res.json({
      success: true,
      message: result.isOnline ? "You are online" : "You are offline",
      rider: result,
    });
  } catch (error) {
    console.error("Rider Online Status Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update status",
    });
  }
};

export const getCurrentAssignment = async (req, res) => {
  try {
    const riderId = req.user.id;
    const rider = await getRiderCore(riderId);

    if (!rider) {
      return res.status(404).json({ success: false, message: "Rider not found" });
    }

    if (!rider.isActive || rider.deletedAt || rider.blockedAt) {
      return res.status(403).json({
        success: false,
        message: rider.blockedReason || "Rider account is inactive",
      });
    }

    const activeOrder = await prisma.order.findFirst({
      where: { riderId, status: { in: activeDeliveryStatuses } },
      include: orderInclude,
      orderBy: { updatedAt: "desc" },
    });

    if (activeOrder) {
      return res.json({
        success: true,
        hasAssignment: true,
        hasActiveOrder: true,
        activeOrder: cleanOrder(activeOrder),
        order: null,
      });
    }

    if (!rider.isOnline) {
      return res.json({
        success: true,
        hasAssignment: false,
        hasActiveOrder: false,
        message: "Go online to receive orders",
        order: null,
      });
    }

    const order = await prisma.order.findFirst({
      where: {
        riderId: null,
        status: "READY_FOR_PICKUP",
        ...(rider.cityId ? { restaurant: { cityId: rider.cityId } } : {}),
      },
      include: orderInclude,
      orderBy: [{ readyAt: "asc" }, { createdAt: "asc" }],
    });

    return res.json({
      success: true,
      hasAssignment: Boolean(order),
      hasActiveOrder: false,
      order: cleanOrder(order),
    });
  } catch (error) {
    console.error("Current Assignment Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch current assignment",
    });
  }
};

export const getNewOrders = async (req, res) => {
  try {
    const riderId = req.user.id;
    const rider = await getRiderCore(riderId);

    if (!rider) {
      return res.status(404).json({ success: false, message: "Rider not found" });
    }

    if (!riderCanWork(rider) || !rider.isOnline) {
      return res.json({
        success: true,
        orders: [],
        message: !rider.isOnline
          ? "Go online to receive orders"
          : "Rider account/KYC is not eligible for deliveries",
      });
    }

    const activeCount = await prisma.order.count({
      where: { riderId, status: { in: activeDeliveryStatuses } },
    });

    const profile = await ensureRiderProfile(riderId);
    const capacity = Math.max(1, profile.maxOrderCapacity || 3);

    if (activeCount >= capacity) {
      return res.json({
        success: true,
        orders: [],
        message: "Complete an active delivery before accepting another order",
      });
    }

    const { limit } = pageParams(req, 20, 50);

    const orders = await prisma.order.findMany({
      where: {
        riderId: null,
        status: "READY_FOR_PICKUP",
        ...(rider.cityId ? { restaurant: { cityId: rider.cityId } } : {}),
      },
      include: orderInclude,
      orderBy: [{ readyAt: "asc" }, { createdAt: "asc" }],
      take: limit,
    });

    return res.json({
      success: true,
      orders: orders.map(cleanOrder),
    });
  } catch (error) {
    console.error("Get New Orders Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
    });
  }
};

export const getActiveOrders = async (req, res) => {
  try {
    const riderId = req.user.id;

    const orders = await prisma.order.findMany({
      where: {
        riderId,
        status: {
          in: ["ASSIGNED_TO_RIDER", "PICKED_UP", "OUT_FOR_DELIVERY"],
        },
      },
      include: orderInclude,
      orderBy: { updatedAt: "desc" },
    });

    res.json({
      success: true,
      orders: orders.map(cleanOrder),
    });
  } catch (error) {
    console.error("Get Active Orders Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch active orders",
    });
  }
};

export const getOrderDetail = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: {
        id,
        OR: [
          { riderId },
          {
            riderId: null,
            status: "READY_FOR_PICKUP",
          },
        ],
      },
      include: orderInclude,
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    res.json({
      success: true,
      order: cleanOrder(order),
    });
  } catch (error) {
    console.error("Get Order Detail Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch order detail",
    });
  }
};

export const acceptOrder = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;
    const rider = await getRiderCore(riderId);

    if (!rider) {
      return res.status(404).json({ success: false, message: "Rider not found" });
    }

    if (!riderCanWork(rider)) {
      return res.status(403).json({
        success: false,
        message:
          !rider.isActive
            ? "Rider account is inactive"
            : rider.kycStatus === "REJECTED"
            ? rider.kycRejectionReason || "KYC was rejected. Please update your documents."
            : rider.blockedReason || "Rider cannot accept orders",
      });
    }

    if (!rider.isOnline) {
      return res.status(400).json({
        success: false,
        message: "Go online first",
      });
    }

    const profile = await ensureRiderProfile(riderId);
    const capacity = Math.max(1, profile.maxOrderCapacity || 3);

    const activeCount = await prisma.order.count({
      where: { riderId, status: { in: activeDeliveryStatuses } },
    });

    if (activeCount >= capacity) {
      return res.status(409).json({
        success: false,
        message: "Complete your active order first",
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const candidate = await tx.order.findFirst({
        where: {
          id,
          riderId: null,
          status: "READY_FOR_PICKUP",
          ...(rider.cityId ? { restaurant: { cityId: rider.cityId } } : {}),
        },
        select: { id: true },
      });

      if (!candidate) {
        const error = new Error("Order is no longer available");
        error.statusCode = 409;
        throw error;
      }

      const claimed = await tx.order.updateMany({
        where: {
          id,
          riderId: null,
          status: "READY_FOR_PICKUP",
        },
        data: {
          riderId,
          status: "ASSIGNED_TO_RIDER",
          acceptedAt: new Date(),
        },
      });

      if (claimed.count !== 1) {
        const error = new Error("Another rider already accepted this order");
        error.statusCode = 409;
        throw error;
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          status: "ASSIGNED_TO_RIDER",
          changedBy: riderId,
          note: "Order accepted by rider",
        },
      });

      await tx.riderProfile.upsert({
        where: { userId: riderId },
        update: { availabilityStatus: "BUSY" },
        create: { userId: riderId, availabilityStatus: "BUSY" },
      });

      return tx.order.findUnique({
        where: { id },
        include: orderInclude,
      });
    });

    const finalOrder = cleanOrder(result);

    getIO()?.to(`order-${id}`).emit("order-updated", finalOrder);
    getIO()?.to(`rider-${riderId}`).emit("order-accepted", finalOrder);
    getIO()?.emit("rider-order-accepted", finalOrder);

    return res.json({
      success: true,
      message: "Order accepted",
      order: finalOrder,
    });
  } catch (error) {
    console.error("Accept Order Error:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Accept failed",
    });
  }
};

export const rejectOrder = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: {
        id,
        riderId: null,
        status: "READY_FOR_PICKUP",
      },
      select: {
        id: true,
        orderNumber: true,
      },
    });

    if (!order) {
      return res.status(400).json({
        success: false,
        message: "Order is no longer available",
      });
    }

    getIO()?.to(`rider-${riderId}`).emit("order-rejected", {
      orderId: id,
      riderId,
    });

    res.json({
      success: true,
      message: "Delivery request rejected",
      orderId: id,
    });
  } catch (error) {
    console.error("Reject Order Error:", error);
    res.status(500).json({
      success: false,
      message: "Reject failed",
    });
  }
};

export const markPicked = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: {
        id,
        riderId,
        status: "ASSIGNED_TO_RIDER",
      },
    });

    if (!order) {
      return res.status(400).json({
        success: false,
        message: "Order not found or already picked",
      });
    }

    const updatedOrder = await prisma.order.update({
      where: { id },
      data: {
        status: "PICKED_UP",
        pickedAt: new Date(),
        history: {
          create: {
            status: "PICKED_UP",
            changedBy: riderId,
            note: "Order picked by rider",
          },
        },
      },
      include: orderInclude,
    });

    const finalOrder = cleanOrder(updatedOrder);

    emitOrderUpdate(id, "order-picked", finalOrder);
    getIO()?.to(`rider-${riderId}`).emit("order-picked", finalOrder);

    res.json({
      success: true,
      message: "Order picked",
      order: finalOrder,
    });
  } catch (error) {
    console.error("Picked Error:", error);
    res.status(500).json({
      success: false,
      message: "Pick failed",
    });
  }
};

export const startDelivery = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: {
        id,
        riderId,
        status: "PICKED_UP",
      },
    });

    if (!order) {
      return res.status(400).json({
        success: false,
        message: "Order not found or not picked",
      });
    }

    const updatedOrder = await prisma.order.update({
      where: { id },
      data: {
        status: "OUT_FOR_DELIVERY",
        history: {
          create: {
            status: "OUT_FOR_DELIVERY",
            changedBy: riderId,
            note: "Rider started delivery",
          },
        },
      },
      include: orderInclude,
    });

    const finalOrder = cleanOrder(updatedOrder);

    emitOrderUpdate(id, "delivery-started", finalOrder);
    getIO()?.to(`rider-${riderId}`).emit("delivery-started", finalOrder);

    res.json({
      success: true,
      message: "Delivery started",
      order: finalOrder,
    });
  } catch (error) {
    console.error("Start Delivery Error:", error);
    res.status(500).json({
      success: false,
      message: "Start delivery failed",
    });
  }
};

export const completeOrder = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;

    const result = await finalizeDelivery({
      riderId,
      orderId: id,
      requireOtpVerified: true,
    });

    const finalOrder = cleanOrder(result.updatedOrder);

    getIO()?.to(`order-${id}`).emit("order-updated", finalOrder);
    getIO()?.to(`rider-${riderId}`).emit("order-completed", {
      orderId: id,
      order: finalOrder,
      earning: result.earning,
      settlement: result.settlement,
      coupon: result.coupon,
      wallet: result.wallet,
    });
    getIO()?.to(`user-${result.updatedOrder.userId}`).emit("order-delivered", finalOrder);
    getIO()?.emit("order-delivered", finalOrder);

    return res.json({
      success: true,
      message: "Order delivered successfully",
      order: finalOrder,
      earning: result.earning,
      wallet: result.wallet,
      settlement: result.settlement,
      coupon: result.coupon,
    });
  } catch (error) {
    console.error("Complete Order Error:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Complete failed",
    });
  }
};

export const verifyDeliveryOtp = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;
    const otp = cleanString(req.body?.otp);

    if (!otp) {
      return res.status(400).json({
        success: false,
        message: "OTP is required",
      });
    }

    const order = await prisma.order.findFirst({
      where: {
        id,
        riderId,
        status: { in: ["PICKED_UP", "OUT_FOR_DELIVERY"] },
      },
    });

    if (!order) {
      return res.status(400).json({
        success: false,
        message: "Order not found or delivery not started",
      });
    }

    if (order.deliveryOtpVerified) {
      return res.status(409).json({
        success: false,
        message: "Delivery OTP was already verified",
      });
    }

    if (!order.deliveryOtp) {
      return res.status(400).json({
        success: false,
        message: "Delivery OTP not found",
      });
    }

    if (
      order.deliveryOtpExpiresAt &&
      new Date(order.deliveryOtpExpiresAt) < new Date()
    ) {
      return res.status(410).json({
        success: false,
        message: "Delivery OTP expired",
      });
    }

    if (String(order.deliveryOtp) !== otp) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    await prisma.order.update({
      where: { id },
      data: { deliveryOtpVerified: true },
    });

    const result = await finalizeDelivery({
      riderId,
      orderId: id,
      requireOtpVerified: false,
    });

    const finalOrder = cleanOrder(result.updatedOrder);

    getIO()?.to(`order-${id}`).emit("order-updated", finalOrder);
    getIO()?.to(`rider-${riderId}`).emit("order-completed", {
      orderId: id,
      order: finalOrder,
      earning: result.earning,
      settlement: result.settlement,
      coupon: result.coupon,
      wallet: result.wallet,
    });
    getIO()?.to(`user-${result.updatedOrder.userId}`).emit("order-delivered", finalOrder);
    getIO()?.emit("order-delivered", finalOrder);

    return res.json({
      success: true,
      message: "OTP verified and order delivered",
      order: finalOrder,
      earning: result.earning,
      wallet: result.wallet,
      settlement: result.settlement,
      coupon: result.coupon,
    });
  } catch (error) {
    console.error("Verify Delivery OTP Error:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "OTP verification failed",
    });
  }
};

export const updateLiveLocation = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { orderId, latitude, longitude } = req.body;

    if (!orderId || !validLatitude(latitude) || !validLongitude(longitude)) {
      return res.status(400).json({
        success: false,
        message: "Valid orderId, latitude and longitude are required",
      });
    }

    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        riderId,
        status: { in: activeDeliveryStatuses },
      },
      select: { id: true },
    });

    if (!order) {
      return res.status(400).json({
        success: false,
        message: "Active order not found",
      });
    }

    const location = await prisma.riderLocation.upsert({
      where: {
        riderId_orderId: {
          riderId,
          orderId,
        },
      },
      update: {
        latitude: Number(latitude),
        longitude: Number(longitude),
      },
      create: {
        riderId,
        orderId,
        latitude: Number(latitude),
        longitude: Number(longitude),
      },
    });

    await prisma.user.update({
      where: { id: riderId },
      data: { lastSeen: new Date() },
    });

    getIO()?.to(`order-${orderId}`).emit("rider-location-updated", {
      orderId,
      riderId,
      latitude: Number(latitude),
      longitude: Number(longitude),
      updatedAt: location.updatedAt,
    });

    return res.json({
      success: true,
      message: "Location updated",
      location: {
        ...location,
        latitude: amountNumber(location.latitude),
        longitude: amountNumber(location.longitude),
      },
    });
  } catch (error) {
    console.error("Update Live Location Error:", error);
    return res.status(500).json({
      success: false,
      message: "Location update failed",
    });
  }
};

export const getDailyEarnings = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { type = "daily" } = req.query;

    const start =
      type === "monthly" ? monthStart() : type === "weekly" ? weekStart() : todayStart();

    const earnings = await prisma.riderEarning.findMany({
      where: {
        riderId,
        createdAt: { gte: start },
      },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            deliveredAt: true,
            deliveryFee: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const total = earnings.reduce((sum, x) => sum + amountNumber(x.amount), 0);

    res.json({
      success: true,
      type,
      total,
      totalOrders: earnings.length,
      earnings,
    });
  } catch (error) {
    console.error("Daily Earnings Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch earnings",
    });
  }
};

export const getWallet = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { page, limit, skip } = pageParams(req, 20, 100);
    const start = todayStart();

    const [wallet, settlements, totalSettlements, todayEarnings] = await Promise.all([
      prisma.riderWallet.upsert({
        where: { riderId },
        update: {},
        create: { riderId },
      }),
      prisma.riderSettlement.findMany({
        where: { riderId },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.riderSettlement.count({ where: { riderId } }),
      prisma.riderEarning.findMany({
        where: { riderId, createdAt: { gte: start } },
      }),
    ]);

    const todayEarn = todayEarnings.reduce(
      (sum, item) => sum + amountNumber(item.amount),
      0
    );

    return res.json({
      success: true,
      wallet: {
        ...wallet,
        balance: amountNumber(wallet.balance),
        todayEarn,
        totalEarn: amountNumber(wallet.totalEarn),
      },
      settlements: settlements.map((item) => ({
        ...item,
        amount: amountNumber(item.amount),
      })),
      pagination: {
        page,
        limit,
        total: totalSettlements,
        totalPages: Math.ceil(totalSettlements / limit),
      },
    });
  } catch (error) {
    console.error("Wallet Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch wallet",
    });
  }
};

export const getMyCoupons = async (req, res) => {
  try {
    const riderId = req.user.id;

    const coupons = await prisma.riderCoupon.findMany({
      where: { riderId },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            deliveredAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      success: true,
      coupons,
    });
  } catch (error) {
    console.error("Coupons Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch coupons",
    });
  }
};

export const getLeaderboard = async (req, res) => {
  try {
    const riders = await prisma.riderWallet.findMany({
      orderBy: { totalEarn: "desc" },
      take: 20,
      include: {
        rider: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            avatarUrl: true,
            vehicleType: true,
            vehicleNo: true,
          },
        },
      },
    });

    res.json({
      success: true,
      leaderboard: riders.map((x, index) => ({
        rank: index + 1,
        rider: x.rider,
        totalEarn: amountNumber(x.totalEarn),
        todayEarn: amountNumber(x.todayEarn),
        balance: amountNumber(x.balance),
      })),
    });
  } catch (error) {
    console.error("Leaderboard Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch leaderboard",
    });
  }
};

export const getDeliveryHistory = async (req, res) => {
  try {
    const riderId = req.user.id;

    const orders = await prisma.order.findMany({
      where: {
        riderId,
        status: {
          in: ["DELIVERED", "CANCELLED"],
        },
      },
      include: orderInclude,
      orderBy: { updatedAt: "desc" },
      take: 50,
    });

    res.json({
      success: true,
      orders: orders.map(cleanOrder),
    });
  } catch (error) {
    console.error("Delivery History Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch delivery history",
    });
  }
};

export const getRiderAnalytics = async (req, res) => {
  try {
    const riderId = req.user.id;

    const [wallet, todayEarnings, activeOrders, deliveredOrders, coupons] =
      await Promise.all([
        prisma.riderWallet.upsert({
          where: { riderId },
          update: {},
          create: { riderId },
        }),
        prisma.riderEarning.findMany({
          where: {
            riderId,
            createdAt: { gte: todayStart() },
          },
        }),
        prisma.order.count({
          where: {
            riderId,
            status: {
              in: ["ASSIGNED_TO_RIDER", "PICKED_UP", "OUT_FOR_DELIVERY"],
            },
          },
        }),
        prisma.order.count({
          where: {
            riderId,
            status: "DELIVERED",
          },
        }),
        prisma.riderCoupon.count({
          where: { riderId },
        }),
      ]);

    const todayTotal = todayEarnings.reduce(
      (sum, x) => sum + amountNumber(x.amount),
      0
    );

    res.json({
      success: true,
      analytics: {
        activeOrders,
        deliveredOrders,
        todayOrders: todayEarnings.length,
        todayEarnings: todayTotal,
        walletBalance: amountNumber(wallet.balance),
        totalEarnings: amountNumber(wallet.totalEarn),
        coupons,
      },
    });
  } catch (error) {
    console.error("Rider Analytics Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch rider analytics",
    });
  }
};

export const getRiderProfile = async (req, res) => {
  try {
    const riderId = req.user.id;

    const rider = await prisma.user.findFirst({
      where: { id: riderId, role: "RIDER" },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        avatarUrl: true,
        address: true,
        vehicleNo: true,
        vehicleType: true,
        isActive: true,
        isOnline: true,
        lastSeen: true,
        kycStatus: true,
        kycRejectionReason: true,
        city: true,
        createdAt: true,
        riderProfile: true,
        riderDocuments: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!rider) {
      return res.status(404).json({
        success: false,
        message: "Rider profile not found",
      });
    }

    const profile = rider.riderProfile || (await ensureRiderProfile(riderId));

    return res.json({
      success: true,
      rider: {
        ...rider,
        riderProfile: profile,
      },
    });
  } catch (error) {
    console.error("Rider Profile Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch rider profile",
    });
  }
};

export const updateRiderProfile = async (req, res) => {
  try {
    const riderId = req.user.id;
    const {
      fullName,
      phone,
      address,
      vehicleNo,
      vehicleType,
      avatarUrl,
      emergencyContactName,
      emergencyContactPhone,
      bloodGroup,
    } = req.body;

    const uploadedAvatar = await uploadFile(req, "riders/profile");

    const result = await prisma.$transaction(async (tx) => {
      const rider = await tx.user.update({
        where: { id: riderId },
        data: {
          ...(fullName !== undefined && { fullName: cleanString(fullName) }),
          ...(phone !== undefined && { phone: cleanString(phone) || null }),
          ...(address !== undefined && { address: cleanString(address) || null }),
          ...(vehicleNo !== undefined && { vehicleNo: cleanString(vehicleNo) || null }),
          ...(vehicleType !== undefined && { vehicleType: cleanString(vehicleType) || null }),
          ...(uploadedAvatar && { avatarUrl: uploadedAvatar }),
          ...(!uploadedAvatar && avatarUrl !== undefined && { avatarUrl: avatarUrl || null }),
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          avatarUrl: true,
          address: true,
          vehicleNo: true,
          vehicleType: true,
          isOnline: true,
          kycStatus: true,
        },
      });

      const profile = await tx.riderProfile.upsert({
        where: { userId: riderId },
        update: {
          ...(emergencyContactName !== undefined && {
            emergencyContactName: cleanString(emergencyContactName) || null,
          }),
          ...(emergencyContactPhone !== undefined && {
            emergencyContactPhone: cleanString(emergencyContactPhone) || null,
          }),
          ...(bloodGroup !== undefined && { bloodGroup: cleanString(bloodGroup) || null }),
        },
        create: {
          userId: riderId,
          emergencyContactName: cleanString(emergencyContactName) || null,
          emergencyContactPhone: cleanString(emergencyContactPhone) || null,
          bloodGroup: cleanString(bloodGroup) || null,
        },
      });

      return { rider, profile };
    });

    return res.json({
      success: true,
      message: "Profile updated",
      rider: {
        ...result.rider,
        riderProfile: result.profile,
      },
    });
  } catch (error) {
    console.error("Update Rider Profile Error:", error);
    return res.status(500).json({
      success: false,
      message: error?.code === "P2002"
        ? "Phone number is already in use"
        : "Failed to update rider profile",
    });
  }
};

export const updateRiderKyc = async (req, res) => {
  try {
    const riderId = req.user.id;
    const {
      aadhaarNumber,
      drivingLicense,
      aadhaarImageUrl,
      licenseImageUrl,
    } = req.body;

    const rider = await prisma.user.update({
      where: { id: riderId },
      data: {
        ...(aadhaarNumber !== undefined && { aadhaarNumber: cleanString(aadhaarNumber) }),
        ...(drivingLicense !== undefined && { drivingLicense: cleanString(drivingLicense) }),
        ...(aadhaarImageUrl !== undefined && { aadhaarImageUrl: aadhaarImageUrl || null }),
        ...(licenseImageUrl !== undefined && { licenseImageUrl: licenseImageUrl || null }),
        kycStatus: "PENDING",
        kycReviewedAt: null,
        kycRejectionReason: null,
      },
      select: {
        id: true,
        aadhaarNumber: true,
        drivingLicense: true,
        aadhaarImageUrl: true,
        licenseImageUrl: true,
        kycStatus: true,
      },
    });

    return res.json({
      success: true,
      message: "KYC submitted for review",
      rider,
    });
  } catch (error) {
    console.error("Rider KYC Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update KYC",
    });
  }
};

export const getRiderIncentives = async (req, res) => {
  try {
    const riderId = req.user.id;

    const incentives = await prisma.riderIncentive.findMany({
      where: { riderId },
      orderBy: [{ isCompleted: "asc" }, { endDate: "asc" }],
    });

    res.json({
      success: true,
      incentives,
    });
  } catch (error) {
    console.error("Rider Incentives Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch incentives",
    });
  }
};

export const getRiderNotifications = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { page, limit, skip } = pageParams(req, 30, 100);
    const unreadOnly = boolValue(req.query?.unreadOnly, false);

    const where = {
      OR: [{ userId: riderId }, { userId: null }],
      ...(unreadOnly ? { isRead: false } : {}),
    };

    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: {
          OR: [{ userId: riderId }, { userId: null }],
          isRead: false,
        },
      }),
    ]);

    return res.json({
      success: true,
      notifications,
      unreadCount,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Rider Notifications Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch notifications",
    });
  }
};

export const createSupportTicket = async (req, res) => {
  try {
    const riderId = req.user.id;
    const subject = cleanString(req.body?.subject);
    const message = cleanString(req.body?.message);
    const orderId = cleanString(req.body?.orderId);
    const priority = String(req.body?.priority || "MEDIUM").toUpperCase();

    if (!subject) {
      return res.status(400).json({
        success: false,
        message: "Subject is required",
      });
    }

    if (!["LOW", "MEDIUM", "HIGH", "URGENT"].includes(priority)) {
      return res.status(400).json({
        success: false,
        message: "Invalid support priority",
      });
    }

    if (orderId) {
      const order = await prisma.order.findFirst({
        where: { id: orderId, riderId },
        select: { id: true },
      });

      if (!order) {
        return res.status(404).json({
          success: false,
          message: "Linked order not found",
        });
      }
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: riderId,
        subject,
        message: message || null,
        orderId: orderId || null,
        priority,
        status: "OPEN",
        lastReplyAt: message ? new Date() : null,
        tags: ["RIDER"],
      },
    });

    return res.status(201).json({
      success: true,
      message: "Support ticket created",
      ticket,
    });
  } catch (error) {
    console.error("Create Support Ticket Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create support ticket",
    });
  }
};

export const getMySupportTickets = async (req, res) => {
  try {
    const riderId = req.user.id;

    const tickets = await prisma.supportTicket.findMany({
      where: { userId: riderId },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    res.json({
      success: true,
      tickets,
    });
  } catch (error) {
    console.error("Get Support Tickets Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch support tickets",
    });
  }
};

export const addSupportMessage = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { ticketId } = req.params;
    const message = cleanString(req.body?.message);
    const imageUrl = req.body?.imageUrl || (await uploadFile(req, "support/rider"));

    if (!message && !imageUrl) {
      return res.status(400).json({
        success: false,
        message: "Message or image is required",
      });
    }

    const ticket = await prisma.supportTicket.findFirst({
      where: { id: ticketId, userId: riderId },
    });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    if (ticket.status === "CLOSED") {
      return res.status(409).json({
        success: false,
        message: "Closed tickets cannot receive new messages",
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const supportMessage = await tx.supportMessage.create({
        data: {
          ticketId,
          senderId: riderId,
          message: message || "",
          imageUrl: imageUrl || null,
        },
      });

      const updatedTicket = await tx.supportTicket.update({
        where: { id: ticketId },
        data: {
          lastReplyAt: new Date(),
          ...(ticket.status === "RESOLVED" ? { status: "OPEN", resolvedAt: null } : {}),
        },
      });

      return { supportMessage, updatedTicket };
    });

    return res.json({
      success: true,
      message: "Message added",
      supportMessage: result.supportMessage,
      ticket: result.updatedTicket,
    });
  } catch (error) {
    console.error("Add Support Message Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to add message",
    });
  }
};

/* =========================
   RIDER PRODUCTION ADDITIONS
========================= */

export const getRiderDocuments = async (req, res) => {
  try {
    const riderId = req.user.id;

    const documents = await prisma.riderDocument.findMany({
      where: { riderId },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });

    return res.json({
      success: true,
      documents,
      kycComplete: documents.some((x) => x.status === "APPROVED"),
    });
  } catch (error) {
    console.error("Get Rider Documents Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch rider documents",
    });
  }
};

export const upsertRiderDocument = async (req, res) => {
  try {
    const riderId = req.user.id;
    const type = String(req.body?.type || "").toUpperCase();
    const allowedTypes = [
      "AADHAAR",
      "PAN",
      "DRIVING_LICENSE",
      "RC",
      "INSURANCE",
      "POLLUTION_CERTIFICATE",
      "BANK_PROOF",
      "PROFILE_PHOTO",
      "OTHER",
    ];

    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid rider document type",
      });
    }

    const {
      documentNumber,
      frontImageUrl,
      backImageUrl,
      documentUrl,
      expiresAt,
    } = req.body;

    const existing = await prisma.riderDocument.findFirst({
      where: { riderId, type },
      orderBy: { createdAt: "desc" },
    });

    const data = {
      type,
      documentNumber: cleanString(documentNumber) || null,
      frontImageUrl: frontImageUrl || null,
      backImageUrl: backImageUrl || null,
      documentUrl: documentUrl || null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      status: "PENDING",
      rejectionReason: null,
      reviewedById: null,
      reviewedAt: null,
    };

    const document = existing
      ? await prisma.riderDocument.update({
          where: { id: existing.id },
          data,
        })
      : await prisma.riderDocument.create({
          data: {
            riderId,
            ...data,
          },
        });

    await prisma.user.update({
      where: { id: riderId },
      data: {
        kycStatus: "PENDING",
        kycReviewedAt: null,
        kycRejectionReason: null,
      },
    });

    return res.status(existing ? 200 : 201).json({
      success: true,
      message: "Document submitted for review",
      document,
    });
  } catch (error) {
    console.error("Upsert Rider Document Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to submit document",
    });
  }
};

export const deletePendingRiderDocument = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;

    const document = await prisma.riderDocument.findFirst({
      where: { id, riderId },
    });

    if (!document) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }

    if (!["PENDING", "REJECTED"].includes(document.status)) {
      return res.status(409).json({
        success: false,
        message: "Approved/under-review documents cannot be deleted",
      });
    }

    await prisma.riderDocument.delete({ where: { id } });

    return res.json({
      success: true,
      message: "Document deleted",
    });
  } catch (error) {
    console.error("Delete Rider Document Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete document",
    });
  }
};

export const updateRiderPayoutDetails = async (req, res) => {
  try {
    const riderId = req.user.id;
    const {
      bankAccountHolder,
      bankAccountNumber,
      bankName,
      ifscCode,
      upiId,
    } = req.body;

    const account = cleanString(bankAccountNumber);

    const profile = await prisma.riderProfile.upsert({
      where: { userId: riderId },
      update: {
        ...(bankAccountHolder !== undefined && {
          bankAccountHolder: cleanString(bankAccountHolder) || null,
        }),
        ...(account !== undefined && {
          bankAccountEncrypted: account || null,
          bankAccountLast4: account ? account.slice(-4) : null,
        }),
        ...(bankName !== undefined && { bankName: cleanString(bankName) || null }),
        ...(ifscCode !== undefined && {
          ifscCode: cleanString(ifscCode)?.toUpperCase() || null,
        }),
        ...(upiId !== undefined && { upiId: cleanString(upiId) || null }),
        payoutVerified: false,
        payoutVerifiedAt: null,
      },
      create: {
        userId: riderId,
        bankAccountHolder: cleanString(bankAccountHolder) || null,
        bankAccountEncrypted: account || null,
        bankAccountLast4: account ? account.slice(-4) : null,
        bankName: cleanString(bankName) || null,
        ifscCode: cleanString(ifscCode)?.toUpperCase() || null,
        upiId: cleanString(upiId) || null,
        payoutVerified: false,
      },
    });

    return res.json({
      success: true,
      message: "Payout details updated and sent for verification",
      payout: {
        bankAccountHolder: profile.bankAccountHolder,
        bankAccountLast4: profile.bankAccountLast4,
        bankName: profile.bankName,
        ifscCode: profile.ifscCode,
        upiId: profile.upiId,
        payoutVerified: profile.payoutVerified,
      },
    });
  } catch (error) {
    console.error("Update Rider Payout Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update payout details",
    });
  }
};

export const getRiderSettlementHistory = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { page, limit, skip } = pageParams(req, 20, 100);
    const status = String(req.query?.status || "").toUpperCase();

    const where = {
      riderId,
      ...(status && status !== "ALL" ? { status } : {}),
    };

    const [settlements, total] = await Promise.all([
      prisma.riderSettlement.findMany({
        where,
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              deliveredAt: true,
              deliveryFee: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.riderSettlement.count({ where }),
    ]);

    return res.json({
      success: true,
      settlements: settlements.map((item) => ({
        ...item,
        amount: amountNumber(item.amount),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Rider Settlement History Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch settlements",
    });
  }
};

export const getRiderRatings = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { page, limit, skip } = pageParams(req, 20, 100);

    const [ratings, total, profile] = await Promise.all([
      prisma.riderRating.findMany({
        where: { riderId, isActive: true },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              avatarUrl: true,
            },
          },
          order: {
            select: {
              id: true,
              orderNumber: true,
              deliveredAt: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.riderRating.count({
        where: { riderId, isActive: true },
      }),
      ensureRiderProfile(riderId),
    ]);

    return res.json({
      success: true,
      summary: {
        rating: amountNumber(profile.rating),
        totalRatings: profile.totalRatings,
      },
      ratings,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Rider Ratings Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch ratings",
    });
  }
};

export const getAvailabilityHistory = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { page, limit, skip } = pageParams(req, 30, 100);

    const [sessions, total] = await Promise.all([
      prisma.riderAvailabilityLog.findMany({
        where: { riderId },
        orderBy: { onlineAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.riderAvailabilityLog.count({ where: { riderId } }),
    ]);

    const data = sessions.map((session) => {
      const end = session.offlineAt ? new Date(session.offlineAt) : new Date();
      const start = new Date(session.onlineAt);
      return {
        ...session,
        durationMinutes: Math.max(
          0,
          Math.round((end.getTime() - start.getTime()) / 60000)
        ),
      };
    });

    return res.json({
      success: true,
      sessions: data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Availability History Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch availability history",
    });
  }
};

export const pauseAvailability = async (req, res) => {
  try {
    const riderId = req.user.id;
    const paused = boolValue(req.body?.paused, true);

    const activeOrder = await prisma.order.findFirst({
      where: { riderId, status: { in: activeDeliveryStatuses } },
      select: { id: true },
    });

    if (paused && activeOrder) {
      return res.status(409).json({
        success: false,
        message: "Cannot pause while an order is active",
      });
    }

    const rider = await getRiderCore(riderId);
    if (!rider?.isOnline) {
      return res.status(409).json({
        success: false,
        message: "Go online before changing availability",
      });
    }

    const profile = await prisma.riderProfile.upsert({
      where: { userId: riderId },
      update: {
        availabilityStatus: paused ? "PAUSED" : "AVAILABLE",
      },
      create: {
        userId: riderId,
        availabilityStatus: paused ? "PAUSED" : "AVAILABLE",
      },
    });

    return res.json({
      success: true,
      message: paused ? "New orders paused" : "You are available for orders",
      availabilityStatus: profile.availabilityStatus,
    });
  } catch (error) {
    console.error("Pause Availability Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update availability",
    });
  }
};

export const markRiderNotificationRead = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;

    const notification = await prisma.notification.findFirst({
      where: {
        id,
        OR: [{ userId: riderId }, { userId: null }],
      },
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    const updated = notification.userId === null
      ? notification
      : await prisma.notification.update({
          where: { id },
          data: { isRead: true, readAt: new Date() },
        });

    return res.json({
      success: true,
      notification: updated,
    });
  } catch (error) {
    console.error("Mark Notification Read Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update notification",
    });
  }
};

export const markAllRiderNotificationsRead = async (req, res) => {
  try {
    const riderId = req.user.id;

    const result = await prisma.notification.updateMany({
      where: {
        userId: riderId,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return res.json({
      success: true,
      updatedCount: result.count,
    });
  } catch (error) {
    console.error("Mark All Notifications Read Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update notifications",
    });
  }
};

export const getRiderPerformance = async (req, res) => {
  try {
    const riderId = req.user.id;
    const type = String(req.query?.type || "monthly").toLowerCase();
    const start =
      type === "daily"
        ? todayStart()
        : type === "weekly"
        ? weekStart()
        : monthStart();

    const [
      deliveredOrders,
      cancelledOrders,
      earnings,
      settlements,
      profile,
    ] = await Promise.all([
      prisma.order.findMany({
        where: {
          riderId,
          status: "DELIVERED",
          deliveredAt: { gte: start },
        },
        select: {
          id: true,
          orderNumber: true,
          deliveredAt: true,
          deliveryFee: true,
          distanceKm: true,
        },
        orderBy: { deliveredAt: "desc" },
      }),
      prisma.order.count({
        where: {
          riderId,
          status: "CANCELLED",
          cancelledAt: { gte: start },
        },
      }),
      prisma.riderEarning.findMany({
        where: { riderId, createdAt: { gte: start } },
      }),
      prisma.riderSettlement.findMany({
        where: { riderId, createdAt: { gte: start } },
      }),
      ensureRiderProfile(riderId),
    ]);

    const totalEarnings = earnings.reduce(
      (sum, item) => sum + amountNumber(item.amount),
      0
    );
    const totalDistance = deliveredOrders.reduce(
      (sum, item) => sum + amountNumber(item.distanceKm),
      0
    );
    const paidSettlement = settlements
      .filter((item) => item.status === "PAID")
      .reduce((sum, item) => sum + amountNumber(item.amount), 0);
    const pendingSettlement = settlements
      .filter((item) => ["PENDING", "PROCESSING"].includes(item.status))
      .reduce((sum, item) => sum + amountNumber(item.amount), 0);

    return res.json({
      success: true,
      type,
      start,
      performance: {
        deliveredOrders: deliveredOrders.length,
        cancelledOrders,
        totalEarnings,
        averageEarningPerDelivery:
          deliveredOrders.length > 0 ? totalEarnings / deliveredOrders.length : 0,
        totalDistanceKm: totalDistance,
        averageDistanceKm:
          deliveredOrders.length > 0 ? totalDistance / deliveredOrders.length : 0,
        paidSettlement,
        pendingSettlement,
        rating: amountNumber(profile.rating),
        totalRatings: profile.totalRatings,
      },
      orders: deliveredOrders.map((order) => ({
        ...order,
        deliveryFee: amountNumber(order.deliveryFee),
        distanceKm: order.distanceKm ? amountNumber(order.distanceKm) : null,
      })),
    });
  } catch (error) {
    console.error("Rider Performance Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch rider performance",
    });
  }
};
