import Razorpay from "razorpay";
import crypto from "crypto";
import prisma from "../prisma.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const toNumber = value => Number(value || 0);

export const createPaymentOrder = async (req, res) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.body;

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({
        success: false,
        message: "Payment gateway is not configured",
      });
    }

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order id is required",
      });
    }

    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    if (order.paymentMethod !== "ONLINE") {
      return res.status(400).json({
        success: false,
        message: "Online payment is not enabled for this order",
      });
    }

    if (order.paymentStatus === "PAID") {
      return res.status(400).json({
        success: false,
        message: "Order is already paid",
      });
    }

    if (order.status === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "Payment cannot be created for a cancelled order",
      });
    }

    const amountInPaise = Math.round(toNumber(order.totalAmount) * 100);

    if (!amountInPaise || amountInPaise < 100) {
      return res.status(400).json({
        success: false,
        message: "Invalid order amount",
      });
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: order.orderNumber,
      notes: {
        kartoOrderId: order.id,
        userId,
      },
    });

    return res.json({
      success: true,
      message: "Payment order created successfully",
      key: process.env.RAZORPAY_KEY_ID,
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      kartoOrderId: order.id,
      orderNumber: order.orderNumber,
    });
  } catch (error) {
    console.error("Create Payment Error:", error);
    return res.status(500).json({
      success: false,
      message: "Payment order create failed",
    });
  }
};

export const verifyPayment = async (req, res) => {
  try {
    const userId = req.user.id;

    const {
      kartoOrderId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (
      !kartoOrderId ||
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment details missing",
      });
    }

    const existingOrder = await prisma.order.findUnique({
      where: { id: kartoOrderId },
    });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    if (existingOrder.userId !== userId) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized payment",
      });
    }

    if (existingOrder.paymentStatus === "PAID") {
      return res.status(400).json({
        success: false,
        message: "Order is already paid",
      });
    }

    if (existingOrder.status === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "Payment cannot be verified for a cancelled order",
      });
    }

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      await prisma.order.update({
        where: { id: kartoOrderId },
        data: {
          paymentMethod: "ONLINE",
          paymentStatus: "FAILED",
        },
      });

      return res.status(400).json({
        success: false,
        message: "Invalid payment signature",
      });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: kartoOrderId },
      data: {
        paymentMethod: "ONLINE",
        paymentStatus: "PAID",
      },
    });

    return res.json({
      success: true,
      message: "Payment verified successfully",
      data: updatedOrder,
      order: updatedOrder,
    });
  } catch (error) {
    console.error("Verify Payment Error:", error);
    return res.status(500).json({
      success: false,
      message: "Payment verification failed",
    });
  }
};