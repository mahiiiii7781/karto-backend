import express from "express";
import { protect, allowRoles } from "../middleware/auth.middleware.js";
import {
  getVendorAnalytics,
  getVendorEarningsGraph,
} from "../controllers/vendorAnalytics.controller.js";

const router = express.Router();

// 🔥 Summary stats
router.get(
  "/summary",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  getVendorAnalytics
);

// 🔥 Graph data (last 7 days)
router.get(
  "/earnings-graph",
  protect,
  allowRoles("VENDOR", "ADMIN"),
  getVendorEarningsGraph
);

export default router;