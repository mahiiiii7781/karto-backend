import express from "express";
import { protect, allowRoles } from "../middleware/auth.middleware.js";
import {
  createOrder,
  myOrders,
  getOrderById,
  vendorOrders,
  riderOrders,
  updateOrderStatus,
} from "../controllers/order.controllers.js";

const router = express.Router();

router.post("/", protect, createOrder);
router.get("/my", protect, myOrders);
router.get("/vendor", protect, allowRoles("VENDOR", "ADMIN"), vendorOrders);
router.get("/rider", protect, allowRoles("RIDER", "ADMIN"), riderOrders);
router.get("/:id", protect, getOrderById);
router.patch("/:id/status", protect, allowRoles("VENDOR", "RIDER", "ADMIN"), updateOrderStatus);

export default router;