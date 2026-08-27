import express from "express";
import { protect, allowRoles } from "../middleware/auth.middleware.js";
import { upload } from "../middleware/upload.middleware.js";

import {
  getAdminDashboard,

  getAdminProfile,
  updateAdminProfile,

  getAllUsers,
  createRoleUser,
  updateUserRole,
  toggleUserActiveStatus,
  deleteUserByAdmin,

  createCity,
  getCities,
  updateCity,
  deleteCity,

  createVendorByAdmin,
  getAdminVendors,
  updateVendorByAdmin,
  updateVendorCommission,
  toggleRestaurantStatus,
  deleteVendorByAdmin,
  updateVendorVerificationByAdmin,
  getVendorDocumentsByAdmin,
  reviewVendorDocumentByAdmin,

  getVendorCategories,
  createVendorCategory,
  updateVendorCategory,
  deleteVendorCategory,

  getVendorSubCategories,
  createVendorSubCategory,
  updateVendorSubCategory,
  deleteVendorSubCategory,

  createRiderByAdmin,
  getAdminRiders,
  updateRiderByAdmin,
  toggleRiderActiveStatus,
  deleteRiderByAdmin,
  getRiderDocumentsByAdmin,
  reviewRiderDocumentByAdmin,
  updateRiderKycByAdmin,

  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,

  getSubCategories,
  createSubCategory,
  updateSubCategory,
  deleteSubCategory,

  getAdminMenuItems,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,

  createMenuItemAddon,
  updateMenuItemAddon,
  deleteMenuItemAddon,

  createMenuItemCustomization,
  updateMenuItemCustomization,
  deleteMenuItemCustomization,

  getAdminOrders,
  getAdminOrderById,
  updateOrderStatusByAdmin,
  updateOrderPaymentStatusByAdmin,
  assignRiderByAdmin,
  downloadOrdersCsv,

  getRiderBilling,
  downloadRiderBillingPdf,
  downloadRiderBillingCsv,

  getMonthlyBilling,
  downloadMonthlyBillingPdf,
  downloadMonthlyBillingCsv,

  getAdminPayments,

  getAdminRefunds,
  createRefundByAdmin,
  updateRefundStatusByAdmin,

  getVendorInvoices,
  generateVendorInvoice,
  getVendorInvoiceById,
  updateVendorInvoiceStatus,
  downloadVendorInvoicePdf,
  downloadVendorInvoiceCsv,

  getVendorSettlements,
  updateVendorSettlementStatus,
  getRiderSettlements,
  updateRiderSettlementStatus,

  getCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,

  getAdminNotifications,
  sendAdminNotification,

  getAdminSupportTickets,
  getAdminSupportTicketById,
  updateSupportTicketByAdmin,
  replySupportTicketByAdmin,

  getSystemSettingsByAdmin,
  upsertSystemSettingByAdmin,

  getBannersByAdmin,
  createBannerByAdmin,
  updateBannerByAdmin,
  deleteBannerByAdmin,

  getAdminAuditLogs,
  getAdminPermissions,
  setAdminPermissions,

  getServiceAreasByAdmin,
  createServiceAreaByAdmin,
  updateServiceAreaByAdmin,
  deleteServiceAreaByAdmin,
} from "../controllers/admin.controller.js";

const router = express.Router();

/* =========================================================
   ADMIN AUTH GUARD
========================================================= */
router.use(protect, allowRoles("ADMIN"));

/* =========================================================
   DASHBOARD
========================================================= */
router.get("/dashboard", getAdminDashboard);

/* =========================================================
   ADMIN PROFILE
========================================================= */
router.get("/profile", getAdminProfile);
router.patch("/profile", upload.single("image"), updateAdminProfile);

/* =========================================================
   USERS
========================================================= */
router.get("/users", getAllUsers);
router.post("/users/create-role-user", upload.single("image"), createRoleUser);
router.patch("/users/:id/role", updateUserRole);
router.patch("/users/:id/status", toggleUserActiveStatus);
router.delete("/users/:id", deleteUserByAdmin);

/* =========================================================
   CITIES
========================================================= */
router.get("/cities", getCities);
router.post("/cities", createCity);
router.patch("/cities/:id", updateCity);
router.delete("/cities/:id", deleteCity);

/* =========================================================
   SERVICE AREAS
========================================================= */
router.get("/service-areas", getServiceAreasByAdmin);
router.post("/service-areas", createServiceAreaByAdmin);
router.patch("/service-areas/:id", updateServiceAreaByAdmin);
router.delete("/service-areas/:id", deleteServiceAreaByAdmin);

/* =========================================================
   BUSINESS CATEGORIES
========================================================= */
router.get("/categories", getCategories);
router.post("/categories", upload.single("image"), createCategory);
router.patch("/categories/:id", upload.single("image"), updateCategory);
router.delete("/categories/:id", deleteCategory);

/* =========================================================
   BUSINESS SUBCATEGORIES
========================================================= */
router.get("/subcategories", getSubCategories);
router.post("/subcategories", upload.single("image"), createSubCategory);
router.patch("/subcategories/:id", upload.single("image"), updateSubCategory);
router.delete("/subcategories/:id", deleteSubCategory);

/* =========================================================
   VENDORS
========================================================= */
router.get("/vendors", getAdminVendors);
router.post("/vendors", upload.single("image"), createVendorByAdmin);
router.patch("/vendors/:id", upload.single("image"), updateVendorByAdmin);
router.patch("/vendors/:id/commission", updateVendorCommission);
router.patch("/vendors/:id/status", toggleRestaurantStatus);
router.patch("/vendors/:id/verification", updateVendorVerificationByAdmin);
router.delete("/vendors/:id", deleteVendorByAdmin);

/* Backward-compatible restaurant status route */
router.patch("/restaurants/:id/status", toggleRestaurantStatus);

/* =========================================================
   VENDOR KYC / DOCUMENTS
========================================================= */
router.get("/vendor-documents", getVendorDocumentsByAdmin);
router.patch("/vendor-documents/:id/review", reviewVendorDocumentByAdmin);

/* =========================================================
   VENDOR INTERNAL CATEGORIES
========================================================= */
router.get("/vendor-categories", getVendorCategories);
router.post("/vendor-categories", upload.single("image"), createVendorCategory);
router.patch("/vendor-categories/:id", upload.single("image"), updateVendorCategory);
router.delete("/vendor-categories/:id", deleteVendorCategory);

/* =========================================================
   VENDOR INTERNAL SUBCATEGORIES
========================================================= */
router.get("/vendor-subcategories", getVendorSubCategories);
router.post("/vendor-subcategories", upload.single("image"), createVendorSubCategory);
router.patch("/vendor-subcategories/:id", upload.single("image"), updateVendorSubCategory);
router.delete("/vendor-subcategories/:id", deleteVendorSubCategory);

/* =========================================================
   RIDERS
========================================================= */
router.get("/riders", getAdminRiders);
router.post("/riders", upload.single("image"), createRiderByAdmin);
router.patch("/riders/:id", upload.single("image"), updateRiderByAdmin);
router.patch("/riders/:id/status", toggleRiderActiveStatus);
router.patch("/riders/:id/kyc", updateRiderKycByAdmin);
router.delete("/riders/:id", deleteRiderByAdmin);

/* =========================================================
   RIDER KYC / DOCUMENTS
========================================================= */
router.get("/rider-documents", getRiderDocumentsByAdmin);
router.patch("/rider-documents/:id/review", reviewRiderDocumentByAdmin);

/* =========================================================
   MENU ITEMS
========================================================= */
router.get("/menu-items", getAdminMenuItems);
router.post("/menu-items", upload.single("image"), createMenuItem);
router.patch("/menu-items/:id", upload.single("image"), updateMenuItem);
router.delete("/menu-items/:id", deleteMenuItem);

/* =========================================================
   MENU ADDONS
========================================================= */
router.post("/menu-items/:menuItemId/addons", upload.single("image"), createMenuItemAddon);
router.patch("/menu-addons/:id", upload.single("image"), updateMenuItemAddon);
router.delete("/menu-addons/:id", deleteMenuItemAddon);

/* =========================================================
   MENU CUSTOMIZATIONS
========================================================= */
router.post("/menu-items/:menuItemId/customizations", createMenuItemCustomization);
router.patch("/menu-customizations/:id", updateMenuItemCustomization);
router.delete("/menu-customizations/:id", deleteMenuItemCustomization);

/* =========================================================
   ORDERS + EXPORTS
========================================================= */
router.get("/orders/export/csv", downloadOrdersCsv);
router.get("/orders", getAdminOrders);
router.get("/orders/:id", getAdminOrderById);
router.patch("/orders/:id/status", updateOrderStatusByAdmin);
router.patch("/orders/:id/payment-status", updateOrderPaymentStatusByAdmin);
router.patch("/orders/:id/assign-rider", assignRiderByAdmin);

/* =========================================================
   PLATFORM BILLING / MONTHLY REPORTS
========================================================= */
router.get("/billing/monthly/pdf", downloadMonthlyBillingPdf);
router.get("/billing/monthly/csv", downloadMonthlyBillingCsv);
router.get("/billing/monthly", getMonthlyBilling);

/* =========================================================
   RIDER BILLING / DOWNLOADS
========================================================= */
router.get("/riders/:id/billing/pdf", downloadRiderBillingPdf);
router.get("/riders/:id/billing/csv", downloadRiderBillingCsv);
router.get("/riders/:id/billing", getRiderBilling);

/* =========================================================
   PAYMENTS
========================================================= */
router.get("/payments", getAdminPayments);

/* =========================================================
   REFUNDS
========================================================= */
router.get("/refunds", getAdminRefunds);
router.post("/refunds", createRefundByAdmin);
router.patch("/refunds/:id/status", updateRefundStatusByAdmin);

/* =========================================================
   VENDOR INVOICES / PDF / CSV
========================================================= */
router.get("/vendor-invoices", getVendorInvoices);
router.post("/vendor-invoices/generate", generateVendorInvoice);
router.get("/vendor-invoices/:id/pdf", downloadVendorInvoicePdf);
router.get("/vendor-invoices/:id/csv", downloadVendorInvoiceCsv);
router.patch("/vendor-invoices/:id/status", updateVendorInvoiceStatus);
router.get("/vendor-invoices/:id", getVendorInvoiceById);

/* =========================================================
   VENDOR SETTLEMENTS
========================================================= */
router.get("/vendor-settlements", getVendorSettlements);
router.patch("/vendor-settlements/:id/status", updateVendorSettlementStatus);

/* =========================================================
   RIDER SETTLEMENTS
========================================================= */
router.get("/rider-settlements", getRiderSettlements);
router.patch("/rider-settlements/:id/status", updateRiderSettlementStatus);

/* =========================================================
   COUPONS
========================================================= */
router.get("/coupons", getCoupons);
router.post("/coupons", createCoupon);
router.patch("/coupons/:id", updateCoupon);
router.delete("/coupons/:id", deleteCoupon);

/* =========================================================
   NOTIFICATIONS
========================================================= */
router.get("/notifications", getAdminNotifications);
router.post("/notifications/send", sendAdminNotification);

/* =========================================================
   SUPPORT CENTER
========================================================= */
router.get("/support/tickets", getAdminSupportTickets);
router.get("/support/tickets/:id", getAdminSupportTicketById);
router.patch("/support/tickets/:id", updateSupportTicketByAdmin);
router.post("/support/tickets/:id/reply", upload.single("image"), replySupportTicketByAdmin);

/* =========================================================
   SYSTEM SETTINGS
========================================================= */
router.get("/settings", getSystemSettingsByAdmin);
router.put("/settings", upsertSystemSettingByAdmin);

/* =========================================================
   BANNERS
========================================================= */
router.get("/banners", getBannersByAdmin);
router.post("/banners", upload.single("image"), createBannerByAdmin);
router.patch("/banners/:id", upload.single("image"), updateBannerByAdmin);
router.delete("/banners/:id", deleteBannerByAdmin);

/* =========================================================
   ADMIN AUDIT LOGS
========================================================= */
router.get("/audit-logs", getAdminAuditLogs);

/* =========================================================
   ADMIN PERMISSIONS
========================================================= */
router.get("/admins/:id/permissions", getAdminPermissions);
router.put("/admins/:id/permissions", setAdminPermissions);

export default router;
