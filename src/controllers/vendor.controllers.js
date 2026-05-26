import prisma from "../prisma.js";

const ACTIVE_STATUSES = ["PLACED", "ACCEPTED", "PREPARING", "READY"];

// 🔥 Categories (USER SIDE)
export const getCategories = async (req, res) => {
  try {
    const categories = await prisma.menuItem.findMany({
      select: { category: true },
      distinct: ["category"],
    });

    res.json({
      success: true,
      data: categories.map(c => c.category),
    });
  } catch (error) {
    console.error("Categories Error:", error);
    res.status(500).json({
      success: false,
      message: "Something went wrong",
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
        menuItems: {
          where: { isAvailable: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found",
      });
    }

    res.json({
      success: true,
      data: vendor,
      vendor,
    });
  } catch (error) {
    console.error("Get Vendor By Id Error:", error);
    res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};
export const getVendors = async (req, res) => {
  try {
    const vendors = await prisma.restaurant.findMany({
      where: {
        isActive: true,
      },
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
        menuItems: {
          where: {
            isAvailable: true,
          },
          take: 5,
          orderBy: {
            createdAt: "desc",
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({
      success: true,
      data: vendors,
      vendors,
    });
  } catch (error) {
    console.error("Get Vendors Error:", error);
    res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};
export const getVendorDashboard = async (req, res) => {
  try {
    const vendorId = req.user.id;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const orders = await prisma.order.findMany({
      where: { vendorId },
      include: {
        user: { select: { id: true, fullName: true, phone: true, email: true } },
        restaurant: true,
        items: { include: { menuItem: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    const todayOrders = await prisma.order.findMany({
      where: {
        vendorId,
        createdAt: { gte: today },
      },
    });

    const activeOrders = await prisma.order.count({
      where: {
        vendorId,
        status: { in: ACTIVE_STATUSES },
      },
    });

    const todayRevenue = todayOrders.reduce(
      (sum, order) => sum + Number(order.totalAmount || 0),
      0
    );

    res.json({
      success: true,
      data: {
        todayOrders: todayOrders.length,
        todayRevenue,
        activeOrders,
        recentOrders: orders,
      },
    });
  } catch (error) {
    console.error("Vendor Dashboard Error:", error);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const getVendorOrders = async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { vendorId: req.user.id },
      include: {
        user: { select: { id: true, fullName: true, phone: true, email: true } },
        restaurant: true,
        address: true,
        items: { include: { menuItem: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, data: orders, orders });
  } catch (error) {
    console.error("Vendor Orders Error:", error);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const updateVendorOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, estimatedPreparationMinutes } = req.body;

    const allowedStatuses = ["ACCEPTED", "PREPARING", "READY", "CANCELLED"];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor order status",
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

    const data = { status };

    if (status === "ACCEPTED") {
      data.acceptedAt = new Date();
      data.estimatedPreparationMinutes =
        Number(estimatedPreparationMinutes) || 30;
    }

    if (status === "PREPARING") data.preparingAt = new Date();
    if (status === "READY") data.readyAt = new Date();
    if (status === "CANCELLED") data.cancelledAt = new Date();

    const updatedOrder = await prisma.order.update({
      where: { id },
      data,
      include: {
        user: { select: { id: true, fullName: true, phone: true, email: true } },
        restaurant: true,
        address: true,
        items: { include: { menuItem: true } },
      },
    });

    await prisma.orderStatusHistory.create({
      data: {
        orderId: id,
        status,
        note: `Vendor updated order to ${status}`,
      },
    });

    res.json({
      success: true,
      message: "Order updated successfully",
      data: updatedOrder,
      order: updatedOrder,
    });
  } catch (error) {
    console.error("Vendor Update Order Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
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

    res.json({
      success: true,
      message: "Preparation time updated",
      data: updated,
    });
  } catch (error) {
    console.error("Update Prep Time Error:", error);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const getVendorPayments = async (req, res) => {
  try {
    const vendorId = req.user.id;

    const deliveredOrders = await prisma.order.findMany({
      where: {
        vendorId,
        status: "DELIVERED",
      },
      orderBy: { createdAt: "desc" },
    });

    const grossEarnings = deliveredOrders.reduce(
      (sum, order) => sum + Number(order.totalAmount || 0),
      0
    );

    const platformFee = grossEarnings * 0.1;
    const netPayable = grossEarnings - platformFee;

    res.json({
      success: true,
      data: {
        totalDeliveredOrders: deliveredOrders.length,
        grossEarnings,
        platformFee,
        netPayable,
        settlementStatus: "PENDING",
        orders: deliveredOrders,
      },
    });
  } catch (error) {
    console.error("Vendor Payments Error:", error);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};