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

  getAvailableRidersForVendor,
  assignVendorOrderRider,

  getVendorMenu,
  createVendorMenuItem,
  updateVendorMenuItem,
  deleteVendorMenuItem,

  getVendorCategories,
  createVendorCategory,
  updateVendorCategory,
  deleteVendorCategory,

  updateVendorSettings,
  setVendorBusyMode,

  getVendorPayments,
  getVendorEarningsGraph,
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

/* =========================
   VENDOR ORDERS APIs
========================= */

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

/* =========================
   VENDOR RIDER APIs
========================= */

router.get(
  "/riders/available",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  getAvailableRidersForVendor
);

router.patch(
  "/orders/:id/assign-rider",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  assignVendorOrderRider
);

/* =========================
   VENDOR MENU APIs
========================= */

router.get(
  "/menu",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  getVendorMenu
);

router.post(
  "/menu",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  createVendorMenuItem
);

router.patch(
  "/menu/:id",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  updateVendorMenuItem
);

router.delete(
  "/menu/:id",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  deleteVendorMenuItem
);

/* =========================
   VENDOR INTERNAL CATEGORY APIs
========================= */

router.get(
  "/categories",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  getVendorCategories
);

router.post(
  "/categories",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  createVendorCategory
);

router.patch(
  "/categories/:id",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  updateVendorCategory
);

router.delete(
  "/categories/:id",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  deleteVendorCategory
);

/* =========================
   VENDOR SETTINGS APIs
========================= */

router.patch(
  "/settings/me",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  updateVendorSettings
);

router.patch(
  "/settings/busy-mode",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  setVendorBusyMode
);

router.patch(
  "/settings/:id",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  updateVendorSettings
);

/* =========================
   VENDOR PAYMENTS APIs
========================= */

router.get(
  "/payments/me",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  getVendorPayments
);

/* =========================
   VENDOR GRAPH APIs
========================= */

router.get(
  "/earnings/graph",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  getVendorEarningsGraph
);

/* =========================
   SINGLE VENDOR - KEEP LAST
========================= */

router.get("/:id", getVendorById);

export default router;