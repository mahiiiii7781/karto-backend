import express from "express";

import {
  protect,
  allowRoles,
} from "../middleware/auth.middleware.js";

import {
  createOrder,
  myOrders,
  getOrderById,
  vendorOrders,
  riderOrders,
  updateOrderStatus,
  cancelMyOrder,
  getMyOrderPaymentStatus,
} from "../controllers/order.controllers.js";

const router = express.Router();

router.use(protect);

// USER APP / CUSTOMER
router.post(
  "/",
  allowRoles("CUSTOMER", "USER"),
  createOrder
);

router.get(
  "/my",
  allowRoles("CUSTOMER", "USER"),
  myOrders
);

router.patch(
  "/:id/cancel",
  allowRoles("CUSTOMER", "USER"),
  cancelMyOrder
);

router.get(
  "/:id/payment-status",
  allowRoles("CUSTOMER", "USER"),
  getMyOrderPaymentStatus
);

// VENDOR
router.get(
  "/vendor",
  allowRoles("VENDOR", "ADMIN"),
  vendorOrders
);

// RIDER
router.get(
  "/rider",
  allowRoles("RIDER", "ADMIN"),
  riderOrders
);

// STATUS UPDATE
router.patch(
  "/:id/status",
  allowRoles(
    "VENDOR",
    "RIDER",
    "ADMIN"
  ),
  updateOrderStatus
);

// ORDER DETAIL
router.get(
  "/:id",
  allowRoles(
    "CUSTOMER",
    "USER",
    "VENDOR",
    "RIDER",
    "ADMIN"
  ),
  getOrderById
);

export default router;