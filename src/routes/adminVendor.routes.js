import express from "express";
import { protect, allowRoles } from "../middleware/auth.middleware.js";
import { upload } from "../middleware/upload.middleware.js";
import {
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
} from "../controllers/adminVendor.controller.js";
import {
  getVendorDocumentsByAdmin,
  reviewVendorDocumentByAdmin,
  updateVendorVerificationByAdmin,
  getVendorSettlements,
  updateVendorSettlementStatus,
  getVendorInvoices,
  getVendorInvoiceById,
  generateVendorInvoice,
  updateVendorInvoiceStatus,
  downloadVendorInvoicePdf,
  downloadVendorInvoiceCsv,
  getAdminRefunds,
  updateRefundStatusByAdmin,
} from "../controllers/admin.controller.js";

const router = express.Router();
router.use(protect, allowRoles("ADMIN"));

router.get("/cities", getCities);
router.post("/cities", createCity);
router.patch("/cities/:id", updateCity);
router.delete("/cities/:id", deleteCity);

router.get("/vendors", getAdminVendors);
router.post("/vendors", upload.single("image"), createVendorByAdmin);
router.patch("/vendors/:id", upload.single("image"), updateVendorByAdmin);
router.patch("/vendors/:id/commission", updateVendorCommission);
router.patch("/vendors/:id/status", toggleRestaurantStatus);
router.patch("/vendors/:id/verification", updateVendorVerificationByAdmin);
router.patch("/restaurants/:id/status", toggleRestaurantStatus);
router.delete("/vendors/:id", deleteVendorByAdmin);

router.get("/vendor-documents", getVendorDocumentsByAdmin);
router.patch("/vendor-documents/:id/review", reviewVendorDocumentByAdmin);

router.get("/vendor-settlements", getVendorSettlements);
router.patch("/vendor-settlements/:id/status", updateVendorSettlementStatus);

router.get("/vendor-invoices", getVendorInvoices);
router.post("/vendor-invoices/generate", generateVendorInvoice);
router.get("/vendor-invoices/:id/pdf", downloadVendorInvoicePdf);
router.get("/vendor-invoices/:id/csv", downloadVendorInvoiceCsv);
router.patch("/vendor-invoices/:id/status", updateVendorInvoiceStatus);
router.get("/vendor-invoices/:id", getVendorInvoiceById);

router.get("/refunds", getAdminRefunds);
router.patch("/refunds/:id/status", updateRefundStatusByAdmin);

export default router;
