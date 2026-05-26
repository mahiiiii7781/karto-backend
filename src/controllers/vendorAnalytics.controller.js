import prisma from "../prisma.js";

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

// 🔥 Get vendor restaurants
const getRestaurantIds = async (vendorId) => {
  const restaurants = await prisma.restaurant.findMany({
    where: { vendorId },
    select: { id: true },
  });

  return restaurants.map((r) => r.id);
};

// =====================================
// 🔥 SUMMARY API
// =====================================
export const getVendorAnalytics = async (req, res) => {
  try {
    const vendorId = req.user.id;

    const { todayStart, monthStart } = getDateRange();

    const restaurantIds = await getRestaurantIds(vendorId);

    if (!restaurantIds.length) {
      return res.json({
        success: true,
        data: {
          todayOrders: 0,
          todayRevenue: 0,
          monthlyOrders: 0,
          monthlyRevenue: 0,
          activeOrders: 0,
          completedOrders: 0,
          cancelledOrders: 0,
          averageOrderValue: 0,
        },
      });
    }

    const todayOrders = await prisma.order.findMany({
      where: {
        restaurantId: { in: restaurantIds },
        createdAt: { gte: todayStart },
      },
    });

    const monthlyOrders = await prisma.order.findMany({
      where: {
        restaurantId: { in: restaurantIds },
        createdAt: { gte: monthStart },
      },
    });

    const activeOrders = await prisma.order.count({
      where: {
        restaurantId: { in: restaurantIds },
        status: {
          in: ["PLACED", "ACCEPTED", "PREPARING", "READY"],
        },
      },
    });

    const completedOrders = await prisma.order.count({
      where: {
        restaurantId: { in: restaurantIds },
        status: "COMPLETED",
      },
    });

    const cancelledOrders = await prisma.order.count({
      where: {
        restaurantId: { in: restaurantIds },
        status: "CANCELLED",
      },
    });

    const todayRevenue = todayOrders.reduce(
      (sum, o) => sum + Number(o.totalAmount || 0),
      0
    );

    const monthlyRevenue = monthlyOrders.reduce(
      (sum, o) => sum + Number(o.totalAmount || 0),
      0
    );

    const averageOrderValue =
      monthlyOrders.length > 0
        ? monthlyRevenue / monthlyOrders.length
        : 0;

    res.json({
      success: true,
      data: {
        todayOrders: todayOrders.length,
        todayRevenue,
        monthlyOrders: monthlyOrders.length,
        monthlyRevenue,
        activeOrders,
        completedOrders,
        cancelledOrders,
        averageOrderValue,
      },
    });
  } catch (error) {
    console.error("Vendor Analytics Error:", error);
    res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};

// =====================================
// 🔥 GRAPH API
// =====================================
export const getVendorEarningsGraph = async (req, res) => {
  try {
    const vendorId = req.user.id;

    const { last7Days } = getDateRange();

    const restaurantIds = await getRestaurantIds(vendorId);

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
        .filter(
          (o) => o.createdAt.toISOString().slice(0, 10) === key
        )
        .reduce((sum, o) => sum + Number(o.totalAmount || 0), 0);

      result.push({
        date: key,
        label: date.toLocaleDateString("en-IN", {
          weekday: "short",
        }),
        earnings: total,
      });
    }

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Graph Error:", error);
    res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};