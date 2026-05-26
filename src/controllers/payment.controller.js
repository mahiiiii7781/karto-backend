import Razorpay from "razorpay";
import crypto from "crypto";
import prisma from "../prisma.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* =========================
   CREATE PAYMENT ORDER
========================= */
export const createPaymentOrder = async (req, res) => {
  try {
    const userId = req.user.id;
    const { orderId } = req.body;

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

    if (order.paymentStatus === "PAID") {
      return res.status(400).json({
        success: false,
        message: "Order already paid",
      });
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(Number(order.totalAmount) * 100),
      currency: "INR",
      receipt: order.orderNumber,
      notes: {
        kartoOrderId: order.id,
        userId,
      },
    });

    return res.json({
      success: true,
      key: process.env.RAZORPAY_KEY_ID,
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      kartoOrderId: order.id,
    });
  } catch (error) {
    console.error("Create Payment Error:", error);
    return res.status(500).json({
      success: false,
      message: "Payment order create failed",
    });
  }
};

/* =========================
   VERIFY PAYMENT
========================= */
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

    /* =========================
       GET ORDER FIRST (SECURITY)
    ========================= */
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
        message: "Order already paid",
      });
    }

    /* =========================
       SIGNATURE VERIFY
    ========================= */
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment signature",
      });
    }

    /* =========================
       UPDATE ORDER
    ========================= */
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