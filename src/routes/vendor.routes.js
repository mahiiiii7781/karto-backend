import express from "express";
import { protect, allowRoles } from "../middleware/auth.middleware.js";

import {
  getVendors,
  getVendorById,
  getCategories,
  getVendorDashboard,
  getVendorOrders,
  updateVendorOrderStatus,
  updatePreparationTime,
  getVendorPayments,
} from "../controllers/vendor.controllers.js";

const router = express.Router();

/* =========================
   PUBLIC USER APIs
========================= */

router.get("/", getVendors);
router.get("/categories/list", getCategories);

/* =========================
   VENDOR DASHBOARD APIs
========================= */

router.get(
  "/dashboard/me",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  getVendorDashboard
);

router.get(
  "/orders/me",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  getVendorOrders
);

router.patch(
  "/orders/:id/status",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  updateVendorOrderStatus
);

router.patch(
  "/orders/:id/preparation-time",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  updatePreparationTime
);

router.get(
  "/payments/me",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  getVendorPayments
);

/* =========================
   SINGLE VENDOR (LAST ME)
========================= */

router.get("/:id", getVendorById);

export default router;