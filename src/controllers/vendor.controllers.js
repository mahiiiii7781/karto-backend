import prisma from "../prisma.js";
import { emitOrderStatus } from "../config/socket.js";

const ACTIVE_STATUSES = [
  "PLACED",
  "ACCEPTED_BY_VENDOR",
  "PREPARING",
  "READY_FOR_PICKUP",
  "ASSIGNED_TO_RIDER",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
];

const toNumber = value => Number(value || 0);

const getDateRange = () => {
  const now = new Date();

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const last7Days = new Date(now);
  last7Days.setDate(now.getDate() - 6);
  last7Days.setHours(0, 0, 0, 0);

  return { todayStart, monthStart, last7Days };
};

const getVendorRestaurantIds = async vendorId => {
  const restaurants = await prisma.restaurant.findMany({
    where: { vendorId },
    select: { id: true },
  });

  return restaurants.map(r => r.id);
};

export const getCategories = async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { name: "asc" },
    });

    return res.json({
      success: true,
      data: categories,
      categories,
    });
  } catch (error) {
    console.error("Categories Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const getVendors = async (req, res) => {
  try {
    const { cityId, categoryId, type } = req.query;

    const where = {
      isOpen: true,
      ...(cityId && { cityId }),
      ...(categoryId && { categoryId }),
      ...(type && { type }),
    };

    const vendors = await prisma.restaurant.findMany({
      where,
      include: {
        vendor: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
          },
        },
        city: true,
        category: true,
        timings: true,
        menuItems: {
          where: {
            isAvailable: true,
          },
          take: 5,
          orderBy: [
            { isBestSeller: "desc" },
            { isPopular: "desc" },
            { createdAt: "desc" },
          ],
        },
      },
      orderBy: [
        { isFeatured: "desc" },
        { rating: "desc" },
        { createdAt: "desc" },
      ],
    });

    return res.json({
      success: true,
      data: vendors,
      vendors,
    });
  } catch (error) {
    console.error("Get Vendors Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const getVendorById = async (req, res) => {
  try {
    const { id } = req.params;

    const vendor = await prisma.restaurant.findUnique({
      where: { id },
      include: {
        vendor: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
          },
        },
        city: true,
        category: true,
        timings: true,
        ratings: {
          where: { isActive: true },
          take: 5,
          orderBy: { createdAt: "desc" },
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                avatarUrl: true,
              },
            },
          },
        },
        menuItems: {
          where: { isAvailable: true },
          include: {
            addons: {
              where: { isActive: true },
            },
            customizations: {
              where: { isActive: true },
            },
            reviews: {
              where: { isActive: true },
              take: 3,
              orderBy: { createdAt: "desc" },
              include: {
                user: {
                  select: {
                    id: true,
                    fullName: true,
                    avatarUrl: true,
                  },
                },
              },
            },
          },
          orderBy: [
            { isBestSeller: "desc" },
            { isPopular: "desc" },
            { createdAt: "desc" },
          ],
        },
      },
    });

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found",
      });
    }

    return res.json({
      success: true,
      data: vendor,
      vendor,
    });
  } catch (error) {
    console.error("Get Vendor By Id Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const getVendorDashboard = async (req, res) => {
  try {
    const vendorId = req.user.id;
    const { todayStart, monthStart } = getDateRange();

    const restaurants = await prisma.restaurant.findMany({
      where: { vendorId },
      include: {
        orders: true,
        menuItems: true,
      },
    });

    const restaurantIds = restaurants.map(r => r.id);

    const todayOrders = await prisma.order.findMany({
      where: {
        vendorId,
        createdAt: { gte: todayStart },
      },
    });

    const monthlyOrders = await prisma.order.findMany({
      where: {
        vendorId,
        createdAt: { gte: monthStart },
      },
    });

    const activeOrders = await prisma.order.count({
      where: {
        vendorId,
        status: { in: ACTIVE_STATUSES },
      },
    });

    const deliveredOrders = await prisma.order.findMany({
      where: {
        vendorId,
        status: "DELIVERED",
      },
    });

    const cancelledOrders = await prisma.order.count({
      where: {
        vendorId,
        status: "CANCELLED",
      },
    });

    const recentOrders = await prisma.order.findMany({
      where: { vendorId },
      include: {
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
        items: {
          include: {
            menuItem: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    const totalOrders = restaurants.reduce(
      (sum, r) => sum + r.orders.length,
      0
    );

    const totalMenuItems = restaurants.reduce(
      (sum, r) => sum + r.menuItems.length,
      0
    );

    const todayRevenue = todayOrders.reduce(
      (sum, order) => sum + toNumber(order.totalAmount),
      0
    );

    const monthlyRevenue = monthlyOrders.reduce(
      (sum, order) => sum + toNumber(order.totalAmount),
      0
    );

    const lifetimeRevenue = deliveredOrders.reduce(
      (sum, order) => sum + toNumber(order.totalAmount),
      0
    );

    const averageOrderValue =
      monthlyOrders.length > 0 ? monthlyRevenue / monthlyOrders.length : 0;

    return res.json({
      success: true,
      data: {
        totalRestaurants: restaurants.length,
        totalOrders,
        totalMenuItems,
        todayOrders: todayOrders.length,
        todayRevenue,
        monthlyOrders: monthlyOrders.length,
        monthlyRevenue,
        lifetimeRevenue,
        activeOrders,
        completedOrders: deliveredOrders.length,
        cancelledOrders,
        averageOrderValue,
        restaurants,
        restaurantIds,
        recentOrders,
      },
      dashboard: {
        totalRestaurants: restaurants.length,
        totalOrders,
        totalMenuItems,
        revenue: lifetimeRevenue,
        restaurants,
      },
    });
  } catch (error) {
    console.error("Vendor Dashboard Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const getVendorOrders = async (req, res) => {
  try {
    const { status } = req.query;

    const where = {
      vendorId: req.user.id,
      ...(status && { status }),
    };

    const orders = await prisma.order.findMany({
      where,
      include: {
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
        items: {
          include: {
            menuItem: true,
          },
          orderBy: { createdAt: "asc" },
        },
        rider: {
          select: {
            id: true,
            fullName: true,
            phone: true,
          },
        },
        history: {
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json({
      success: true,
      data: orders,
      orders,
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

export const updateVendorOrderStatus = async (req, res) => {
  try {
    const { orderId, id } = req.params;
    const finalOrderId = orderId || id;

    const { status, note, estimatedPreparationMinutes } = req.body;

    const allowedVendorStatuses = [
      "ACCEPTED_BY_VENDOR",
      "PREPARING",
      "READY_FOR_PICKUP",
      "CANCELLED",
    ];

    if (!allowedVendorStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor order status",
      });
    }

    const existingOrder = await prisma.order.findFirst({
      where: {
        id: finalOrderId,
        vendorId: req.user.id,
      },
      include: {
        restaurant: true,
      },
    });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found for this vendor",
      });
    }

    const updateData = { status };

    if (status === "ACCEPTED_BY_VENDOR") {
      updateData.acceptedAt = new Date();
      updateData.estimatedPreparationMinutes =
        Number(estimatedPreparationMinutes) ||
        existingOrder.estimatedPreparationMinutes ||
        30;
    }

    if (status === "PREPARING") {
      updateData.preparingAt = new Date();
    }

    if (status === "READY_FOR_PICKUP") {
      updateData.readyAt = new Date();
    }

    if (status === "CANCELLED") {
      updateData.cancelledAt = new Date();
      updateData.cancelReason = note || "Cancelled by vendor";
      updateData.cancelledBy = req.user.id;
    }

    const order = await prisma.$transaction(async tx => {
      const updated = await tx.order.update({
        where: { id: finalOrderId },
        data: updateData,
        include: {
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
          items: {
            include: {
              menuItem: true,
            },
            orderBy: { createdAt: "asc" },
          },
          rider: {
            select: {
              id: true,
              fullName: true,
              phone: true,
            },
          },
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: finalOrderId,
          status,
          changedBy: req.user.id,
          note: note || `Vendor updated order to ${status}`,
        },
      });

      return updated;
    });

    emitOrderStatus(finalOrderId, status, { order });

    return res.json({
      success: true,
      message: "Order status updated",
      data: order,
      order,
    });
  } catch (error) {
    console.error("Vendor Update Order Status Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const updatePreparationTime = async (req, res) => {
  try {
    const { id } = req.params;
    const { estimatedPreparationMinutes } = req.body;

    const minutes = Number(estimatedPreparationMinutes);

    if (!minutes || minutes < 5 || minutes > 120) {
      return res.status(400).json({
        success: false,
        message: "Preparation time must be between 5 and 120 minutes",
      });
    }

    const order = await prisma.order.findFirst({
      where: {
        id,
        vendorId: req.user.id,
      },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const updated = await prisma.order.update({
      where: { id },
      data: { estimatedPreparationMinutes: minutes },
    });

    return res.json({
      success: true,
      message: "Preparation time updated",
      data: updated,
      order: updated,
    });
  } catch (error) {
    console.error("Update Prep Time Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const getVendorPayments = async (req, res) => {
  try {
    const vendorId = req.user.id;

    const settlements = await prisma.vendorSettlement.findMany({
      where: { vendorId },
      include: {
        restaurant: true,
        order: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const pendingAmount = settlements
      .filter(s => s.status === "PENDING")
      .reduce((sum, s) => sum + toNumber(s.netAmount), 0);

    const paidAmount = settlements
      .filter(s => s.status === "PAID")
      .reduce((sum, s) => sum + toNumber(s.netAmount), 0);

    const grossEarnings = settlements.reduce(
      (sum, s) => sum + toNumber(s.grossAmount),
      0
    );

    const platformFee = settlements.reduce(
      (sum, s) => sum + toNumber(s.commissionAmount),
      0
    );

    const netPayable = settlements.reduce(
      (sum, s) => sum + toNumber(s.netAmount),
      0
    );

    return res.json({
      success: true,
      data: {
        grossEarnings,
        platformFee,
        netPayable,
        pendingAmount,
        paidAmount,
        settlements,
      },
    });
  } catch (error) {
    console.error("Vendor Payments Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const getVendorEarningsGraph = async (req, res) => {
  try {
    const vendorId = req.user.id;
    const { last7Days } = getDateRange();

    const restaurantIds = await getVendorRestaurantIds(vendorId);

    const orders = await prisma.order.findMany({
      where: {
        restaurantId: { in: restaurantIds },
        createdAt: { gte: last7Days },
        status: { not: "CANCELLED" },
      },
      select: {
        createdAt: true,
        totalAmount: true,
      },
    });

    const result = [];

    for (let i = 0; i < 7; i++) {
      const date = new Date(last7Days);
      date.setDate(last7Days.getDate() + i);

      const key = date.toISOString().slice(0, 10);

      const total = orders
        .filter(o => o.createdAt.toISOString().slice(0, 10) === key)
        .reduce((sum, o) => sum + toNumber(o.totalAmount), 0);

      result.push({
        date: key,
        label: date.toLocaleDateString("en-IN", {
          weekday: "short",
        }),
        earnings: total,
      });
    }

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Graph Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export default {
  getCategories,
  getVendors,
  getVendorById,
  getVendorDashboard,
  getVendorOrders,
  updateVendorOrderStatus,
  updatePreparationTime,
  getVendorPayments,
  getVendorEarningsGraph,
};