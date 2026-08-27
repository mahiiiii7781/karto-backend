import express from "express";
import {
  register,
  login,
  getMe,
  refreshToken,
  logout,
  sendOtp,
  verifyOtp,
  adminOnlyTest,
  updateProfile,
} from "../controllers/auth.controller.js";
import { protect, allowRoles } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/register", register);
router.post("/login", login);
router.post("/send-otp", sendOtp);
router.post("/verify-otp", verifyOtp);
router.post("/refresh-token", refreshToken);

router.get("/me", protect, getMe);
router.patch("/profile", protect, updateProfile);
router.post("/logout", protect, logout);
router.get("/admin-only", protect, allowRoles("ADMIN"), adminOnlyTest);

export default router;
