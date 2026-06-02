import express from "express";
import {
  updateOnlineStatus,
  getNewOrders,
  getActiveOrders,
  getOrderDetail,
  acceptOrder,
  rejectOrder,
  markPicked,
  startDelivery,
  completeOrder,
  updateLiveLocation,
  getDailyEarnings,
  getWallet,
  getMyCoupons,
  getLeaderboard,
  getDeliveryHistory,
  getRiderAnalytics,
  getRiderProfile,
  updateRiderProfile,
  updateRiderKyc,
  getRiderIncentives,
  createSupportTicket,
  getMySupportTickets,
  addSupportMessage,
} from "../controllers/rider.controller.js";

import { protect, allowRoles } from "../middleware/auth.middleware.js";

const router = express.Router();

router.use(protect, allowRoles("RIDER"));

router.get("/profile", getRiderProfile);
router.patch("/profile", updateRiderProfile);
router.patch("/kyc", updateRiderKyc);
router.patch("/online-status", updateOnlineStatus);

router.get("/orders/new", getNewOrders);
router.get("/orders/active", getActiveOrders);
router.get("/orders/history", getDeliveryHistory);
router.get("/orders/:id", getOrderDetail);

router.patch("/orders/:id/accept", acceptOrder);
router.patch("/orders/:id/reject", rejectOrder);
router.patch("/orders/:id/picked", markPicked);
router.patch("/orders/:id/start-delivery", startDelivery);
router.patch("/orders/:id/complete", completeOrder);

router.post("/location", updateLiveLocation);

router.get("/earnings/today", getDailyEarnings);
router.get("/wallet", getWallet);
router.get("/coupons", getMyCoupons);
router.get("/leaderboard", getLeaderboard);
router.get("/analytics", getRiderAnalytics);
router.get("/incentives", getRiderIncentives);

router.post("/support/tickets", createSupportTicket);
router.get("/support/tickets", getMySupportTickets);
router.post("/support/tickets/:ticketId/messages", addSupportMessage);

export default router;