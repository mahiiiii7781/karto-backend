import prisma from "../prisma.js";
import { getIO } from "../socket.js";

const couponCode = () =>
  "KARTO-RIDER-" + Math.random().toString(36).substring(2, 8).toUpperCase();

const todayStart = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const amountNumber = (v) => Number(v || 0);

const getRiderEarningAmount = (order) => amountNumber(order.deliveryFee);

const orderInclude = {
  user: { select: { id: true, fullName: true, phone: true, avatarUrl: true } },
  restaurant: true,
  address: true,
  items: true,
  history: { orderBy: { createdAt: "desc" } },
};

export const updateOnlineStatus = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { isOnline } = req.body;

    const rider = await prisma.user.update({
      where: { id: riderId },
      data: {
        isOnline: Boolean(isOnline),
        lastSeen: new Date(),
      },
      select: {
        id: true,
        fullName: true,
        isOnline: true,
        lastSeen: true,
      },
    });

    getIO()?.emit("rider-online-status-changed", rider);

    res.json({
      success: true,
      message: rider.isOnline ? "You are online" : "You are offline",
      rider,
    });
  } catch (error) {
    console.error("Rider Online Status Error:", error);
    res.status(500).json({ success: false, message: "Failed to update status" });
  }
};

export const getNewOrders = async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { riderId: null, status: "READY_FOR_PICKUP" },
      include: orderInclude,
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, orders });
  } catch (error) {
    console.error("Get New Orders Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
};

export const getActiveOrders = async (req, res) => {
  try {
    const riderId = req.user.id;

    const orders = await prisma.order.findMany({
      where: {
        riderId,
        status: { in: ["ASSIGNED_TO_RIDER", "PICKED_UP", "OUT_FOR_DELIVERY"] },
      },
      include: orderInclude,
      orderBy: { updatedAt: "desc" },
    });

    res.json({ success: true, orders });
  } catch (error) {
    console.error("Get Active Orders Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch active orders" });
  }
};

export const getOrderDetail = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: {
        id,
        OR: [{ riderId }, { riderId: null, status: "READY_FOR_PICKUP" }],
      },
      include: orderInclude,
    });

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    res.json({ success: true, order });
  } catch (error) {
    console.error("Get Order Detail Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch order detail" });
  }
};

export const acceptOrder = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;

    const rider = await prisma.user.findUnique({
      where: { id: riderId },
      select: { isOnline: true, kycStatus: true },
    });

    if (!rider?.isOnline) {
      return res.status(400).json({ success: false, message: "Go online first" });
    }

    if (rider.kycStatus !== "APPROVED") {
      return res.status(400).json({ success: false, message: "KYC approval required" });
    }

    const order = await prisma.order.findFirst({
      where: { id, riderId: null, status: "READY_FOR_PICKUP" },
    });

    if (!order) {
      return res.status(400).json({ success: false, message: "Order is not available" });
    }

    const updatedOrder = await prisma.order.update({
      where: { id },
      data: {
        riderId,
        status: "ASSIGNED_TO_RIDER",
        acceptedAt: new Date(),
        history: {
          create: {
            status: "ASSIGNED_TO_RIDER",
            changedBy: riderId,
            note: "Order accepted by rider",
          },
        },
      },
      include: orderInclude,
    });

    getIO()?.to(`order-${id}`).emit("order-updated", updatedOrder);
    getIO()?.to(`rider-${riderId}`).emit("order-accepted", updatedOrder);

    res.json({ success: true, message: "Order accepted", order: updatedOrder });
  } catch (error) {
    console.error("Accept Order Error:", error);
    res.status(500).json({ success: false, message: "Accept failed" });
  }
};

export const rejectOrder = async (req, res) => {
  try {
    const { id } = req.params;

    res.json({
      success: true,
      message: "Delivery request rejected",
      orderId: id,
    });
  } catch (error) {
    console.error("Reject Order Error:", error);
    res.status(500).json({ success: false, message: "Reject failed" });
  }
};

export const markPicked = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: { id, riderId, status: "ASSIGNED_TO_RIDER" },
    });

    if (!order) {
      return res.status(400).json({ success: false, message: "Order not found or already picked" });
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

    getIO()?.to(`order-${id}`).emit("order-updated", updatedOrder);
    getIO()?.to(`rider-${riderId}`).emit("order-picked", updatedOrder);

    res.json({ success: true, message: "Order picked", order: updatedOrder });
  } catch (error) {
    console.error("Picked Error:", error);
    res.status(500).json({ success: false, message: "Pick failed" });
  }
};

export const startDelivery = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: { id, riderId, status: "PICKED_UP" },
    });

    if (!order) {
      return res.status(400).json({ success: false, message: "Order not found or not picked" });
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

    getIO()?.to(`order-${id}`).emit("order-updated", updatedOrder);
    getIO()?.to(`rider-${riderId}`).emit("delivery-started", updatedOrder);

    res.json({ success: true, message: "Delivery started", order: updatedOrder });
  } catch (error) {
    console.error("Start Delivery Error:", error);
    res.status(500).json({ success: false, message: "Start delivery failed" });
  }
};

export const completeOrder = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: {
        id,
        riderId,
        status: { in: ["PICKED_UP", "OUT_FOR_DELIVERY"] },
      },
    });

    if (!order) {
      return res.status(400).json({ success: false, message: "Order not found or not picked" });
    }

    const earningAmount = getRiderEarningAmount(order);
    const code = couponCode();

    const result = await prisma.$transaction(async (tx) => {
      const updatedOrder = await tx.order.update({
        where: { id },
        data: {
          status: "DELIVERED",
          deliveredAt: new Date(),
          paymentStatus: order.paymentMethod === "COD" ? "PAID" : order.paymentStatus,
          history: {
            create: {
              status: "DELIVERED",
              changedBy: riderId,
              note: "Order delivered successfully by rider",
            },
          },
        },
        include: orderInclude,
      });

      const earning = await tx.riderEarning.create({
        data: {
          riderId,
          orderId: order.id,
          amount: earningAmount,
          note: `Earning from order ${order.orderNumber}`,
        },
      });

      const wallet = await tx.riderWallet.upsert({
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

      const coupon = await tx.riderCoupon.create({
        data: {
          riderId,
          orderId: order.id,
          code,
          title: "Delivery Earning Coupon",
          amount: earningAmount,
          message: `Congratulations! You earned ₹${earningAmount} from order ${order.orderNumber}.`,
        },
      });

      await tx.riderIncentive.updateMany({
        where: {
          riderId,
          isCompleted: false,
          startDate: { lte: new Date() },
          endDate: { gte: new Date() },
        },
        data: {
          completedOrders: { increment: 1 },
        },
      });

      return { updatedOrder, earning, wallet, coupon };
    });

    getIO()?.to(`order-${id}`).emit("order-updated", result.updatedOrder);
    getIO()?.to(`rider-${riderId}`).emit("order-completed", {
      orderId: order.id,
      earning: result.earning,
      coupon: result.coupon,
      wallet: result.wallet,
    });

    res.json({
      success: true,
      message: "Order delivered successfully",
      order: result.updatedOrder,
      earning: result.earning,
      wallet: result.wallet,
      coupon: result.coupon,
    });
  } catch (error) {
    console.error("Complete Order Error:", error);
    res.status(500).json({ success: false, message: "Complete failed" });
  }
};

export const updateLiveLocation = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { orderId, latitude, longitude } = req.body;

    if (!orderId || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        message: "orderId, latitude and longitude are required",
      });
    }

    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        riderId,
        status: { in: ["ASSIGNED_TO_RIDER", "PICKED_UP", "OUT_FOR_DELIVERY"] },
      },
    });

    if (!order) {
      return res.status(400).json({ success: false, message: "Active order not found" });
    }

    const location = await prisma.riderLocation.upsert({
      where: { riderId_orderId: { riderId, orderId } },
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

    getIO()?.to(`order-${orderId}`).emit("rider-location-updated", {
      orderId,
      riderId,
      latitude: Number(latitude),
      longitude: Number(longitude),
      updatedAt: location.updatedAt,
    });

    res.json({ success: true, message: "Location updated", location });
  } catch (error) {
    console.error("Update Live Location Error:", error);
    res.status(500).json({ success: false, message: "Location update failed" });
  }
};

export const getDailyEarnings = async (req, res) => {
  try {
    const riderId = req.user.id;

    const earnings = await prisma.riderEarning.findMany({
      where: { riderId, createdAt: { gte: todayStart() } },
      orderBy: { createdAt: "desc" },
    });

    const total = earnings.reduce((sum, x) => sum + amountNumber(x.amount), 0);

    res.json({ success: true, total, totalOrders: earnings.length, earnings });
  } catch (error) {
    console.error("Daily Earnings Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch daily earnings" });
  }
};

export const getWallet = async (req, res) => {
  try {
    const riderId = req.user.id;

    const wallet = await prisma.riderWallet.upsert({
      where: { riderId },
      update: {},
      create: { riderId },
    });

    res.json({
      success: true,
      wallet: {
        ...wallet,
        balance: amountNumber(wallet.balance),
        todayEarn: amountNumber(wallet.todayEarn),
        totalEarn: amountNumber(wallet.totalEarn),
      },
    });
  } catch (error) {
    console.error("Wallet Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch wallet" });
  }
};

export const getMyCoupons = async (req, res) => {
  try {
    const riderId = req.user.id;

    const coupons = await prisma.riderCoupon.findMany({
      where: { riderId },
      include: {
        order: { select: { id: true, orderNumber: true, deliveredAt: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, coupons });
  } catch (error) {
    console.error("Coupons Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch coupons" });
  }
};

export const getLeaderboard = async (req, res) => {
  try {
    const riders = await prisma.riderWallet.findMany({
      orderBy: { totalEarn: "desc" },
      take: 10,
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
    res.status(500).json({ success: false, message: "Failed to fetch leaderboard" });
  }
};

export const getDeliveryHistory = async (req, res) => {
  try {
    const riderId = req.user.id;

    const orders = await prisma.order.findMany({
      where: { riderId, status: { in: ["DELIVERED", "CANCELLED"] } },
      include: orderInclude,
      orderBy: { updatedAt: "desc" },
      take: 50,
    });

    res.json({ success: true, orders });
  } catch (error) {
    console.error("Delivery History Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch delivery history" });
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
          where: { riderId, createdAt: { gte: todayStart() } },
        }),
        prisma.order.count({
          where: {
            riderId,
            status: { in: ["ASSIGNED_TO_RIDER", "PICKED_UP", "OUT_FOR_DELIVERY"] },
          },
        }),
        prisma.order.count({ where: { riderId, status: "DELIVERED" } }),
        prisma.riderCoupon.count({ where: { riderId } }),
      ]);

    const todayTotal = todayEarnings.reduce((sum, x) => sum + amountNumber(x.amount), 0);

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
    res.status(500).json({ success: false, message: "Failed to fetch rider analytics" });
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
        aadhaarNumber: true,
        drivingLicense: true,
        aadhaarImageUrl: true,
        licenseImageUrl: true,
        kycStatus: true,
        city: true,
        createdAt: true,
      },
    });

    if (!rider) {
      return res.status(404).json({ success: false, message: "Rider profile not found" });
    }

    res.json({ success: true, rider });
  } catch (error) {
    console.error("Rider Profile Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch rider profile" });
  }
};

export const updateRiderProfile = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { fullName, phone, address, vehicleNo, vehicleType, avatarUrl } = req.body;

    const rider = await prisma.user.update({
      where: { id: riderId },
      data: {
        ...(fullName !== undefined && { fullName }),
        ...(phone !== undefined && { phone }),
        ...(address !== undefined && { address }),
        ...(vehicleNo !== undefined && { vehicleNo }),
        ...(vehicleType !== undefined && { vehicleType }),
        ...(avatarUrl !== undefined && { avatarUrl }),
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

    res.json({ success: true, message: "Profile updated", rider });
  } catch (error) {
    console.error("Update Rider Profile Error:", error);
    res.status(500).json({ success: false, message: "Failed to update rider profile" });
  }
};

export const updateRiderKyc = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { aadhaarNumber, drivingLicense, aadhaarImageUrl, licenseImageUrl } = req.body;

    const rider = await prisma.user.update({
      where: { id: riderId },
      data: {
        ...(aadhaarNumber !== undefined && { aadhaarNumber }),
        ...(drivingLicense !== undefined && { drivingLicense }),
        ...(aadhaarImageUrl !== undefined && { aadhaarImageUrl }),
        ...(licenseImageUrl !== undefined && { licenseImageUrl }),
        kycStatus: "PENDING",
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

    res.json({
      success: true,
      message: "KYC submitted for review",
      rider,
    });
  } catch (error) {
    console.error("Rider KYC Error:", error);
    res.status(500).json({ success: false, message: "Failed to update KYC" });
  }
};

export const getRiderIncentives = async (req, res) => {
  try {
    const riderId = req.user.id;

    const incentives = await prisma.riderIncentive.findMany({
      where: { riderId },
      orderBy: [{ isCompleted: "asc" }, { endDate: "asc" }],
    });

    res.json({ success: true, incentives });
  } catch (error) {
    console.error("Rider Incentives Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch incentives" });
  }
};

export const createSupportTicket = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { subject, message, orderId, priority } = req.body;

    if (!subject) {
      return res.status(400).json({ success: false, message: "Subject is required" });
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: riderId,
        subject,
        message,
        orderId,
        priority: priority || "MEDIUM",
      },
    });

    res.json({
      success: true,
      message: "Support ticket created",
      ticket,
    });
  } catch (error) {
    console.error("Create Support Ticket Error:", error);
    res.status(500).json({ success: false, message: "Failed to create support ticket" });
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

    res.json({ success: true, tickets });
  } catch (error) {
    console.error("Get Support Tickets Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch support tickets" });
  }
};

export const addSupportMessage = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { ticketId } = req.params;
    const { message, imageUrl } = req.body;

    if (!message && !imageUrl) {
      return res.status(400).json({ success: false, message: "Message or image is required" });
    }

    const ticket = await prisma.supportTicket.findFirst({
      where: { id: ticketId, userId: riderId },
    });

    if (!ticket) {
      return res.status(404).json({ success: false, message: "Ticket not found" });
    }

    const supportMessage = await prisma.supportMessage.create({
      data: {
        ticketId,
        senderId: riderId,
        message: message || "",
        imageUrl,
      },
    });

    await prisma.supportTicket.update({
      where: { id: ticketId },
      data: { updatedAt: new Date() },
    });

    res.json({
      success: true,
      message: "Message added",
      supportMessage,
    });
  } catch (error) {
    console.error("Add Support Message Error:", error);
    res.status(500).json({ success: false, message: "Failed to add message" });
  }
};