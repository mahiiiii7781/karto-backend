import express from "express";

import {
  updateOnlineStatus,
  getRiderDashboard,

  getCurrentAssignment,
  getNewOrders,
  getActiveOrders,
  getOrderDetail,
  acceptOrder,
  rejectOrder,
  markPicked,
  startDelivery,
  completeOrder,
  verifyDeliveryOtp,

  updateLiveLocation,

  getDailyEarnings,
  getWallet,
  getMyCoupons,
  getLeaderboard,
  getDeliveryHistory,
  getRiderAnalytics,
  getRiderPerformance,

  getRiderProfile,
  updateRiderProfile,
  updateRiderKyc,

  getRiderDocuments,
  upsertRiderDocument,
  deletePendingRiderDocument,

  updateRiderPayoutDetails,
  getRiderSettlementHistory,
  getRiderRatings,

  getAvailabilityHistory,
  pauseAvailability,

  getRiderIncentives,

  getRiderNotifications,
  markRiderNotificationRead,
  markAllRiderNotificationsRead,

  createSupportTicket,
  getMySupportTickets,
  addSupportMessage,
} from "../controllers/rider.controller.js";

import {
  protect,
  allowRoles,
} from "../middleware/auth.middleware.js";

import { upload } from "../middleware/upload.middleware.js";

const router = express.Router();

router.use(protect, allowRoles("RIDER"));

/* =========================
   DASHBOARD
========================= */

router.get("/dashboard", getRiderDashboard);

/* =========================
   PROFILE
========================= */

router.get("/profile", getRiderProfile);

router.patch(
  "/profile",
  upload.single("image"),
  updateRiderProfile
);

/* =========================
   KYC
========================= */

/*
  Backward-compatible KYC endpoint.
  Keeps existing rider app working while document-based KYC is used
  for production verification.
*/
router.patch("/kyc", updateRiderKyc);

/* Rider KYC documents */

router.get(
  "/kyc/documents",
  getRiderDocuments
);

router.post(
  "/kyc/documents",
  upsertRiderDocument
);

router.delete(
  "/kyc/documents/:id",
  deletePendingRiderDocument
);

/* =========================
   AVAILABILITY / ONLINE
========================= */

router.patch(
  "/online-status",
  updateOnlineStatus
);

router.patch(
  "/availability",
  pauseAvailability
);

router.get(
  "/availability/history",
  getAvailabilityHistory
);

/* =========================
   ORDER ASSIGNMENT
========================= */

router.get(
  "/orders/assignment/current",
  getCurrentAssignment
);

router.get(
  "/orders/new",
  getNewOrders
);

router.get(
  "/orders/active",
  getActiveOrders
);

router.get(
  "/orders/history",
  getDeliveryHistory
);

/* =========================
   ORDER ACTIONS
========================= */

router.patch(
  "/orders/:id/accept",
  acceptOrder
);

router.patch(
  "/orders/:id/reject",
  rejectOrder
);

router.patch(
  "/orders/:id/picked",
  markPicked
);

router.patch(
  "/orders/:id/start-delivery",
  startDelivery
);

/*
  If an order has a delivery OTP, completeOrder will not allow
  delivery completion until OTP verification is done.
*/
router.patch(
  "/orders/:id/complete",
  completeOrder
);

router.post(
  "/orders/:id/verify-delivery-otp",
  verifyDeliveryOtp
);

/*
  Keep the generic order-detail route AFTER all specific
  /orders/... routes to avoid routing conflicts.
*/
router.get(
  "/orders/:id",
  getOrderDetail
);

/* =========================
   LIVE LOCATION
========================= */

router.post(
  "/location",
  updateLiveLocation
);

/* =========================
   EARNINGS / WALLET
========================= */

/*
  Supports:
  ?type=daily
  ?type=weekly
  ?type=monthly

  Existing /earnings/today URL is retained for backward compatibility.
*/
router.get(
  "/earnings/today",
  getDailyEarnings
);

router.get(
  "/earnings",
  getDailyEarnings
);

router.get(
  "/wallet",
  getWallet
);

router.get(
  "/settlements",
  getRiderSettlementHistory
);

router.patch(
  "/payout-details",
  updateRiderPayoutDetails
);

/* =========================
   PERFORMANCE / ANALYTICS
========================= */

router.get(
  "/analytics",
  getRiderAnalytics
);

router.get(
  "/performance",
  getRiderPerformance
);

router.get(
  "/leaderboard",
  getLeaderboard
);

router.get(
  "/ratings",
  getRiderRatings
);

/* =========================
   INCENTIVES / COUPONS
========================= */

router.get(
  "/incentives",
  getRiderIncentives
);

router.get(
  "/coupons",
  getMyCoupons
);

/* =========================
   NOTIFICATIONS
========================= */

router.get(
  "/notifications",
  getRiderNotifications
);

router.patch(
  "/notifications/read-all",
  markAllRiderNotificationsRead
);

router.patch(
  "/notifications/:id/read",
  markRiderNotificationRead
);

/* =========================
   SUPPORT
========================= */

router.post(
  "/support/tickets",
  createSupportTicket
);

router.get(
  "/support/tickets",
  getMySupportTickets
);

router.post(
  "/support/tickets/:ticketId/messages",
  upload.single("image"),
  addSupportMessage
);

export default router;
