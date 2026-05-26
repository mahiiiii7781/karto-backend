import express from "express";
import {
  getVendorDashboard,
  getVendorOrders,
  updateVendorOrderStatus,
} from "../controllers/vendorDashboard.controller.js";
import { protect, allowRoles } from "../middleware/auth.middleware.js";

const router = express.Router();

router.get(
  "/",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  getVendorDashboard
);

router.get(
  "/orders",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  getVendorOrders
);

router.patch(
  "/orders/:orderId/status",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  updateVendorOrderStatus
);

export default router;