import express from "express";
import { protect } from "../middleware/auth.middleware.js";
import {
  getCart,
  getCartTotal,
  addToCart,
  updateCartItem,
  removeCartItem,
  clearCart,
} from "../controllers/cart.controllers.js";

const router = express.Router();

router.get("/", protect, getCart);
router.get("/total", protect, getCartTotal);

router.post("/add", protect, addToCart);

router.patch("/:id", protect, updateCartItem);

router.delete("/:id", protect, removeCartItem);
router.delete("/", protect, clearCart);

export default router;