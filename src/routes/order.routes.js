import express from "express";
import { protect, allowRoles } from "../middleware/auth.middleware.js";
import {
  createOrder,
  myOrders,
  getOrderById,
  vendorOrders,
  riderOrders,
  updateOrderStatus,
  cancelMyOrder,
  getMyOrderPaymentStatus,
} from "../controllers/order.controllers.js";

const router = express.Router();
router.use(protect);

router.post("/", allowRoles("CUSTOMER"), createOrder);
router.get("/my", allowRoles("CUSTOMER"), myOrders);
router.get("/vendor", allowRoles("VENDOR", "ADMIN"), vendorOrders);
router.get("/rider", allowRoles("RIDER", "ADMIN"), riderOrders);

router.patch("/:id/cancel", allowRoles("CUSTOMER"), cancelMyOrder);
router.get("/:id/payment-status", allowRoles("CUSTOMER"), getMyOrderPaymentStatus);

router.patch(
  "/:id/status",
  allowRoles("VENDOR", "RIDER", "ADMIN"),
  updateOrderStatus
);

router.get("/:id", getOrderById);

export default router;
