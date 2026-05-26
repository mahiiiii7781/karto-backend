import express from "express";
import {
  getNewOrders,
  acceptOrder,
  markPicked,
  completeOrder,
  getDailyEarnings,
  getWallet,
  getMyCoupons,
  getLeaderboard,
} from "../controllers/rider.controller.js";
import { protect, allowRoles } from "../middleware/auth.middleware.js";

const router = express.Router();

router.get("/orders/new", protect, allowRoles("RIDER"), getNewOrders);
router.patch("/orders/:id/accept", protect, allowRoles("RIDER"), acceptOrder);
router.patch("/orders/:id/picked", protect, allowRoles("RIDER"), markPicked);
router.patch("/orders/:id/complete", protect, allowRoles("RIDER"), completeOrder);

router.get("/earnings/today", protect, allowRoles("RIDER"), getDailyEarnings);
router.get("/wallet", protect, allowRoles("RIDER"), getWallet);
router.get("/coupons", protect, allowRoles("RIDER"), getMyCoupons);
router.get("/leaderboard", protect, allowRoles("RIDER"), getLeaderboard);

export default router;