import express from "express";
import { protect, allowRoles } from "../middleware/auth.middleware.js";
import { upload } from "../middleware/upload.middleware.js";
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
  updateVendorProfile,
  toggleVendorAcceptingOrders,
  setVendorBusyUntil,
  getVendorTimings,
  updateVendorTimings,
  upsertVendorOperatingException,
  deleteVendorOperatingException,
  getVendorDocuments,
  upsertVendorDocument,
  deletePendingVendorDocument,
  updateVendorPayoutDetails,
  getVendorStaff,
  addVendorStaff,
  updateVendorStaff,
  removeVendorStaff,
  getVendorOrderById,
  acceptOrderByVendor,
  rejectOrderByVendor,
  markOrderPreparingByVendor,
  markOrderReadyByVendor,
  getVendorFinancialSummary,
  getVendorSettlements,
  getVendorInvoices,
  getVendorInvoiceById,
  downloadVendorInvoicePdf,
  getVendorRefunds,
  getVendorRatings,
  markVendorNotificationRead,
  markAllVendorNotificationsRead,
  createVendorSupportTicket,
  getVendorSupportTickets,
  addVendorSupportMessage,
} from "../controllers/vendor.controllers.js";

const router = express.Router();
const vendorAccess = [protect, allowRoles("VENDOR", "ADMIN")];

router.get("/", getVendors);
router.get("/categories/list", getCategories);

router.get("/dashboard/me", vendorAccess, getVendorDashboard);

router.get("/orders/me", vendorAccess, getVendorOrders);
router.get("/orders/:id/detail", vendorAccess, getVendorOrderById);
router.patch("/orders/:id/status", vendorAccess, updateVendorOrderStatus);
router.patch("/orders/:id/accept", vendorAccess, acceptOrderByVendor);
router.patch("/orders/:id/reject", vendorAccess, rejectOrderByVendor);
router.patch("/orders/:id/preparing", vendorAccess, markOrderPreparingByVendor);
router.patch("/orders/:id/ready", vendorAccess, markOrderReadyByVendor);
router.patch("/orders/:id/preparation-time", vendorAccess, updatePreparationTime);

router.get("/riders/available", vendorAccess, getAvailableRidersForVendor);
router.patch("/orders/:id/assign-rider", vendorAccess, assignVendorOrderRider);
router.patch("/orders/:id/reassign-rider", vendorAccess, assignVendorOrderRider);

router.get("/menu", vendorAccess, getVendorMenu);
router.post("/menu", vendorAccess, upload.single("image"), createVendorMenuItem);
router.patch("/menu/:id", vendorAccess, upload.single("image"), updateVendorMenuItem);
router.patch("/menu/:id/availability", vendorAccess, toggleVendorMenuItemAvailability);
router.delete("/menu/:id", vendorAccess, deleteVendorMenuItem);

router.get("/categories", vendorAccess, getVendorCategories);
router.post("/categories", vendorAccess, createVendorCategory);
router.patch("/categories/:id", vendorAccess, updateVendorCategory);
router.delete("/categories/:id", vendorAccess, deleteVendorCategory);

router.get("/profile/me", vendorAccess, getVendorProfile);
router.patch("/profile/me", vendorAccess, upload.single("image"), updateVendorProfile);
router.patch("/settings/me", vendorAccess, updateVendorSettings);
router.patch("/settings/open-close", vendorAccess, toggleVendorOpenClose);
router.patch("/settings/busy-mode", vendorAccess, setVendorBusyMode);
router.patch("/settings/:id", vendorAccess, updateVendorSettings);
router.patch("/availability", vendorAccess, toggleVendorAcceptingOrders);
router.patch("/busy-until", vendorAccess, setVendorBusyUntil);

router.get("/timings", vendorAccess, getVendorTimings);
router.put("/timings", vendorAccess, updateVendorTimings);
router.post("/timings/exceptions", vendorAccess, upsertVendorOperatingException);
router.delete("/timings/exceptions/:id", vendorAccess, deleteVendorOperatingException);

router.get("/kyc/documents", vendorAccess, getVendorDocuments);
router.post("/kyc/documents", vendorAccess, upload.single("file"), upsertVendorDocument);
router.delete("/kyc/documents/:id", vendorAccess, deletePendingVendorDocument);
router.patch("/payout-details", vendorAccess, updateVendorPayoutDetails);

router.get("/staff", vendorAccess, getVendorStaff);
router.post("/staff", vendorAccess, addVendorStaff);
router.patch("/staff/:id", vendorAccess, updateVendorStaff);
router.delete("/staff/:id", vendorAccess, removeVendorStaff);

router.get("/payments/me", vendorAccess, getVendorPayments);
router.get("/earnings/graph", vendorAccess, getVendorEarningsGraph);
router.get("/finance/summary", vendorAccess, getVendorFinancialSummary);
router.get("/settlements", vendorAccess, getVendorSettlements);
router.get("/invoices", vendorAccess, getVendorInvoices);
router.get("/invoices/:id/pdf", vendorAccess, downloadVendorInvoicePdf);
router.get("/invoices/:id", vendorAccess, getVendorInvoiceById);
router.get("/refunds", vendorAccess, getVendorRefunds);
router.get("/ratings", vendorAccess, getVendorRatings);

router.get("/notifications", vendorAccess, getVendorNotifications);
router.patch("/notifications/read-all", vendorAccess, markAllVendorNotificationsRead);
router.patch("/notifications/:id/read", vendorAccess, markVendorNotificationRead);

router.get("/support/tickets", vendorAccess, getVendorSupportTickets);
router.post("/support/tickets", vendorAccess, createVendorSupportTicket);
router.post(
  "/support/tickets/:ticketId/messages",
  vendorAccess,
  upload.single("image"),
  addVendorSupportMessage
);

router.get("/:id", getVendorById);

export default router;
