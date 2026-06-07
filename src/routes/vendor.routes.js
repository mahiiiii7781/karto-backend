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
  toggleVendorMenuItemAvailability,
  deleteVendorMenuItem,

  getVendorCategories,
  createVendorCategory,
  updateVendorCategory,
  deleteVendorCategory,

  getVendorProfile,
  updateVendorSettings,
  toggleVendorOpenClose,
  setVendorBusyMode,

  getVendorPayments,
  getVendorEarningsGraph,
  getVendorNotifications,
} from "../controllers/vendor.controllers.js";

const router = express.Router();

const vendorAccess = [protect, allowRoles("VENDOR", "ADMIN")];

/* PUBLIC */
router.get("/", getVendors);
router.get("/categories/list", getCategories);

/* DASHBOARD */
router.get("/dashboard/me", vendorAccess, getVendorDashboard);

/* ORDERS */
router.get("/orders/me", vendorAccess, getVendorOrders);
router.patch("/orders/:id/status", vendorAccess, updateVendorOrderStatus);
router.patch(
  "/orders/:id/preparation-time",
  vendorAccess,
  updatePreparationTime
);

/* RIDERS */
router.get("/riders/available", vendorAccess, getAvailableRidersForVendor);
router.patch("/orders/:id/assign-rider", vendorAccess, assignVendorOrderRider);
router.patch("/orders/:id/reassign-rider", vendorAccess, assignVendorOrderRider);

/* MENU */
router.get("/menu", vendorAccess, getVendorMenu);
router.post("/menu", vendorAccess, createVendorMenuItem);
router.patch("/menu/:id", vendorAccess, updateVendorMenuItem);
router.patch(
  "/menu/:id/availability",
  vendorAccess,
  toggleVendorMenuItemAvailability
);
router.delete("/menu/:id", vendorAccess, deleteVendorMenuItem);

/* VENDOR CATEGORIES */
router.get("/categories", vendorAccess, getVendorCategories);
router.post("/categories", vendorAccess, createVendorCategory);
router.patch("/categories/:id", vendorAccess, updateVendorCategory);
router.delete("/categories/:id", vendorAccess, deleteVendorCategory);

/* PROFILE / SETTINGS */
router.get("/profile/me", vendorAccess, getVendorProfile);
router.patch("/settings/me", vendorAccess, updateVendorSettings);
router.patch("/settings/open-close", vendorAccess, toggleVendorOpenClose);
router.patch("/settings/busy-mode", vendorAccess, setVendorBusyMode);
router.patch("/settings/:id", vendorAccess, updateVendorSettings);

/* PAYMENTS / ANALYTICS */
router.get("/payments/me", vendorAccess, getVendorPayments);
router.get("/earnings/graph", vendorAccess, getVendorEarningsGraph);

/* NOTIFICATIONS */
router.get("/notifications", vendorAccess, getVendorNotifications);

/* KEEP LAST */
router.get("/:id", getVendorById);

export default router;