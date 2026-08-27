import express from "express";
import { protect } from "../middleware/auth.middleware.js";
import {
  getCart,
  getCartTotal,
  getCartPricing,
  validateCart,
  previewCartCoupon,
  addToCart,
  replaceCartRestaurant,
  updateCartItem,
  removeCartItem,
  clearCart,
} from "../controllers/cart.controllers.js";

const router = express.Router();
router.use(protect);

router.get("/", getCart);
router.get("/total", getCartTotal);
router.get("/pricing", getCartPricing);
router.get("/validate", validateCart);
router.post("/coupon/preview", previewCartCoupon);
router.post("/add", addToCart);
router.post("/replace", replaceCartRestaurant);
router.patch("/:id", updateCartItem);
router.delete("/:id", removeCartItem);
router.delete("/", clearCart);

export default router;
