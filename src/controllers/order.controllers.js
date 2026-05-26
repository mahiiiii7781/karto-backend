import prisma from "../prisma.js";
import { emitOrderStatus } from "../config/socket.js";
const generateOrderNumber = () => {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const random = Math.floor(1000 + Math.random() * 9000);

  return `KT${y}${m}${d}${random}`;
};

export const createOrder = async (req, res) => {
  try {
   const { addressId, paymentMethod = "COD", customerNote } = req.body;

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
    });

    if (!cartItems.length) {
      return res.status(400).json({
        success: false,
        message: "Cart is empty",
      });
    }

    const restaurantId = cartItems[0].restaurantId;

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found",
      });
    }

    const totalAmount = cartItems.reduce((sum, item) => {
      return sum + Number(item.totalPrice);
    }, 0);

    const deliveryFee = Number(restaurant.deliveryFee || 0);
    const finalAmount = totalAmount + deliveryFee;

    const order = await prisma.$transaction(async tx => {
      const newOrder = await tx.order.create({
        data: {
          userId: req.user.id,
          restaurantId,
          vendorId: restaurant.vendorId,
          addressId,
          totalAmount: finalAmount,
          deliveryFee,
          paymentMethod,
          paymentStatus: paymentMethod === "COD" ? "PENDING" : "PENDING",
          status: "PLACED",
          orderNumber: generateOrderNumber(),
          customerNote,
          items: {
            create: cartItems.map(item => ({
              menuItemId: item.menuItemId,
              restaurantId: item.restaurantId,
              quantity: item.quantity,
              price: item.price,
              totalPrice: item.totalPrice,
              itemName: item.menuItem.name,
            })),
          },
          history: {
            create: {
              status: "PLACED",
              changedBy: req.user.id,
              note: "Order placed by customer",
            },
          },
        },
        include: {
          items: true,
          restaurant: true,
          history: true,
        },
      });

      await tx.cartItem.deleteMany({
        where: { userId: req.user.id },
      });

      return newOrder;
    });

    res.status(201).json({
  success: true,
  message: "Order placed successfully",
  data: order,
  order,
});
  } catch (error) {
    console.error("Create Order Error:", error);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const myOrders = async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { userId: req.user.id },
      include: {
        restaurant: true,
        items: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({
  success: true,
  data: orders,
  orders,
});
  } catch (error) {
    console.error("My Orders Error:", error);
    res.status(500).json({ success: false, message: "Something went wrong" });
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
        items: true,
        history: {
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

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    res.json({
      success: true,
      order,
    });
  } catch (error) {
    console.error("Order Detail Error:", error);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const vendorOrders = async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { vendorId: req.user.id },
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
        items: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({
  success: true,
  data: orders,
  orders,
});
  } catch (error) {
    console.error("Vendor Orders Error:", error);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const riderOrders = async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { riderId: req.user.id },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            phone: true,
          },
        },
        restaurant: true,
        items: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({
  success: true,
  data: orders,
  orders,
});
  } catch (error) {
    console.error("Rider Orders Error:", error);
    res.status(500).json({ success: false, message: "Something went wrong" });
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

    const updateData = {
      status,
    };

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
          note,
        },
      });

      return updated;
    });
emitOrderStatus(id, status, { order: updatedOrder });
    res.json({
      success: true,
      message: "Order status updated",
      order: updatedOrder,
    });
  } catch (error) {
    console.error("Update Order Status Error:", error);
    res.status(500).json({ success: false, message: "Something went wrong" });
  }
};