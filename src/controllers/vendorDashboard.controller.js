import prisma from "../prisma.js";
import { emitOrderStatus } from "../config/socket.js";

export const getVendorDashboard = async (req, res) => {
  try {
    const restaurants = await prisma.restaurant.findMany({
      where: {
        vendorId: req.user.id,
      },
      include: {
        orders: true,
        menuItems: true,
      },
    });

    const totalOrders = restaurants.reduce(
      (sum, r) => sum + r.orders.length,
      0
    );

    const totalMenuItems = restaurants.reduce(
      (sum, r) => sum + r.menuItems.length,
      0
    );

    const revenue = restaurants.reduce((sum, restaurant) => {
      const deliveredOrders = restaurant.orders.filter(
        (order) => order.status === "DELIVERED"
      );

      const restaurantRevenue = deliveredOrders.reduce(
        (s, order) => s + Number(order.totalAmount),
        0
      );

      return sum + restaurantRevenue;
    }, 0);

    return res.json({
      success: true,
      dashboard: {
        totalRestaurants: restaurants.length,
        totalOrders,
        totalMenuItems,
        revenue,
        restaurants,
      },
    });
  } catch (error) {
    console.error("Vendor Dashboard Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};

export const getVendorOrders = async (req, res) => {
  try {
    const { status } = req.query;

    const where = {
      vendorId: req.user.id,
    };

    if (status) {
      where.status = status;
    }

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
        items: true,
        rider: {
          select: {
            id: true,
            fullName: true,
            phone: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return res.json({
      success: true,
      orders,
    });
  } catch (error) {
    console.error("Vendor Orders Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};

export const updateVendorOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, note } = req.body;

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
        id: orderId,
        vendorId: req.user.id,
      },
    });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found for this vendor",
      });
    }

    const timeFieldMap = {
      ACCEPTED_BY_VENDOR: "acceptedAt",
      PREPARING: "preparingAt",
      READY_FOR_PICKUP: "readyAt",
      CANCELLED: "cancelledAt",
    };

    const updateData = {
      status,
    };

    if (timeFieldMap[status]) {
      updateData[timeFieldMap[status]] = new Date();
    }

    const order = await prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id: orderId },
        data: updateData,
        include: {
          user: true,
          restaurant: true,
          items: true,
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          status,
          changedBy: req.user.id,
          note,
        },
      });

      return updated;
    });

    emitOrderStatus(orderId, status, { order });

    return res.json({
      success: true,
      message: "Order status updated",
      order,
    });
  } catch (error) {
    console.error("Vendor Update Order Status Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};
export default {
  getVendorDashboard,
  getVendorOrders,
  updateVendorOrderStatus,
};