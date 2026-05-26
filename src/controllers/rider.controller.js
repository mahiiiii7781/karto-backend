import prisma from "../prisma.js";
import { getIO } from "../socket.js";

const couponCode = () =>
  "KARTO-RIDER-" + Math.random().toString(36).substring(2, 8).toUpperCase();

const todayStart = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const getRiderEarningAmount = (order) => {
  return order.deliveryFee;
};

export const getNewOrders = async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: {
        riderId: null,
        status: "READY",
      },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            phone: true,
          },
        },
        restaurant: true,
        address: true,
        items: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({ success: true, orders });
  } catch (error) {
    console.error("Get New Orders Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
};

export const acceptOrder = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { id } = req.params;

    const order = await prisma.order.findFirst({
      where: {
        id,
        riderId: null,
        status: "READY",
      },
    });

    if (!order) {
      return res.status(400).json({
        success: false,
        message: "Order is not available",
      });
    }

    const updatedOrder = await prisma.order.update({
      where: { id },
      data: {
        riderId,
        status: "ACCEPTED",
        acceptedAt: new Date(),
        history: {
          create: {
            status: "ACCEPTED",
            note: "Order accepted by rider",
          },
        },
      },
      include: {
        user: true,
        restaurant: true,
        address: true,
        items: true,
      },
    });

    res.json({
      success: true,
      message: "Order accepted",
      order: updatedOrder,
    });
  } catch (error) {
    console.error("Accept Order Error:", error);
    res.status(500).json({ success: false, message: "Accept failed" });
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
        status: "ACCEPTED",
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
            note: "Order picked by rider",
          },
        },
      },
      include: {
        user: true,
        restaurant: true,
        address: true,
        items: true,
      },
    });

    res.json({
      success: true,
      message: "Order picked",
      order: updatedOrder,
    });
  } catch (error) {
    console.error("Picked Error:", error);
    res.status(500).json({ success: false, message: "Pick failed" });
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
        status: "PICKED_UP",
      },
    });

    if (!order) {
      return res.status(400).json({
        success: false,
        message: "Order not found or not picked",
      });
    }

    const earningAmount = getRiderEarningAmount(order);
    const code = couponCode();

    const result = await prisma.$transaction(async (tx) => {
      const updatedOrder = await tx.order.update({
        where: { id },
        data: {
          status: "DELIVERED",
          deliveredAt: new Date(),
          paymentStatus:
            order.paymentMethod === "COD" ? "PAID" : order.paymentStatus,
          history: {
            create: {
              status: "DELIVERED",
              note: "Order delivered successfully by rider",
            },
          },
        },
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
        where: {
          riderId,
        },
        update: {
          balance: {
            increment: earningAmount,
          },
          todayEarn: {
            increment: earningAmount,
          },
          totalEarn: {
            increment: earningAmount,
          },
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

      return {
        updatedOrder,
        earning,
        wallet,
        coupon,
      };
    });

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

export const getDailyEarnings = async (req, res) => {
  try {
    const riderId = req.user.id;

    const earnings = await prisma.riderEarning.findMany({
      where: {
        riderId,
        createdAt: {
          gte: todayStart(),
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const total = earnings.reduce((sum, x) => sum + Number(x.amount), 0);

    res.json({
      success: true,
      total,
      totalOrders: earnings.length,
      earnings,
    });
  } catch (error) {
    console.error("Daily Earnings Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch daily earnings",
    });
  }
};

export const getWallet = async (req, res) => {
  try {
    const riderId = req.user.id;

    const wallet = await prisma.riderWallet.upsert({
      where: {
        riderId,
      },
      update: {},
      create: {
        riderId,
      },
    });

    res.json({
      success: true,
      wallet,
    });
  } catch (error) {
    console.error("Wallet Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch wallet",
    });
  }
};

export const getMyCoupons = async (req, res) => {
  try {
    const riderId = req.user.id;

    const coupons = await prisma.riderCoupon.findMany({
      where: {
        riderId,
      },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            deliveredAt: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
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
      orderBy: {
        totalEarn: "desc",
      },
      take: 10,
      include: {
        rider: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            avatarUrl: true,
          },
        },
      },
    });

    res.json({
      success: true,
      leaderboard: riders.map((x, index) => ({
        rank: index + 1,
        rider: x.rider,
        totalEarn: x.totalEarn,
        todayEarn: x.todayEarn,
        balance: x.balance,
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