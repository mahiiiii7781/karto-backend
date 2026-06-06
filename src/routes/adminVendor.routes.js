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
router.patch("/restaurants/:id/status", toggleRestaurantStatus);
router.delete("/vendors/:id", deleteVendorByAdmin);

export default router;