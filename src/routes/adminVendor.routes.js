import express from "express";
import { protect, allowRoles } from "../middleware/auth.middleware.js";
import {
  createCity,
  getCities,
  createVendorByAdmin,
  getAdminVendors,
  updateVendorCommission,
} from "../controllers/adminVendor.controller.js";

const router = express.Router();

router.post("/cities", protect, allowRoles("ADMIN"), createCity);
router.get("/cities", protect, allowRoles("ADMIN"), getCities);

router.post("/vendors", protect, allowRoles("ADMIN"), createVendorByAdmin);
router.get("/vendors", protect, allowRoles("ADMIN"), getAdminVendors);
router.patch(
  "/vendors/:id/commission",
  protect,
  allowRoles("ADMIN"),
  updateVendorCommission
);

export default router;