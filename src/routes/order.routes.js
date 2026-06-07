import express from "express";
import { protect, allowRoles } from "../middleware/auth.middleware.js";

import {
  createOrder,
  myOrders,
  getOrderById,
  vendorOrders,
  riderOrders,
  updateOrderStatus,
} from "../controllers/order.controllers.js";

const router = express.Router();

/* =========================
   USER ORDER FLOW
========================= */

// Create order from user cart / checkout
router.post("/", protect, createOrder);

// Logged-in user orders
router.get("/my", protect, myOrders);

/* =========================
   VENDOR ORDER FLOW
========================= */

// Vendor/Admin restaurant orders
router.get("/vendor", protect, allowRoles("VENDOR", "ADMIN"), vendorOrders);

/* =========================
   RIDER ORDER FLOW
========================= */

// Rider/Admin assigned orders
router.get("/rider", protect, allowRoles("RIDER", "ADMIN"), riderOrders);

/* =========================
   COMMON ORDER DETAILS
========================= */

// Keep this after /my, /vendor, /rider
router.get("/:id", protect, getOrderById);

/* =========================
   STATUS UPDATE FLOW
========================= */

// Vendor/Rider/Admin status updates
router.patch(
  "/:id/status",
  protect,
  allowRoles("VENDOR", "RIDER", "ADMIN"),
  updateOrderStatus
);

export default router;