import express from "express";
import cors from "cors";
import http from "http";
import prisma from "./prisma.js";

import { initSocket } from "./socket.js";

import authRoutes from "./routes/auth.routes.js";
import vendorRoutes from "./routes/vendor.routes.js";
import cartRoutes from "./routes/cart.routes.js";
import orderRoutes from "./routes/order.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import riderRoutes from "./routes/rider.routes.js";
import addressRoutes from "./routes/address.routes.js";
import vendorDashboardRoutes from "./routes/vendorDashboard.routes.js";
import favoriteRoutes from "./routes/favorite.routes.js";
import vendorAnalyticsRoutes from "./routes/vendorAnalytics.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import adminVendorRoutes from "./routes/adminVendor.routes.js";
import reviewRoutes from "./routes/review.routes.js";
import recentlyViewedRoutes from "./routes/recentlyViewed.routes.js";
import couponRoutes from "./routes/coupon.routes.js";
import pushRoutes from "./routes/push.routes.js";
import uploadRoutes from "./routes/upload.routes.js";

const app = express();

app.use(cors());
app.use(express.json());

const server = http.createServer(app);

/* =========================
   SOCKET.IO - SINGLE INSTANCE
========================= */

initSocket(server);

/* =========================
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Karto Backend Running",
  });
});

/* =========================
   FRONTEND DATA ROUTES
========================= */

app.get("/api/categories", async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { name: "asc" },
    });

    res.json({ success: true, data: categories });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/restaurants/featured", async (req, res) => {
  try {
    const restaurants = await prisma.restaurant.findMany({
      where: {
        isFeatured: true,
        isOpen: true,
      },
      include: {
        category: true,
      },
      orderBy: {
        rating: "desc",
      },
    });

    res.json({ success: true, data: restaurants });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/restaurants/category/:categoryId", async (req, res) => {
  try {
    const restaurants = await prisma.restaurant.findMany({
      where: {
        categoryId: req.params.categoryId,
        isOpen: true,
      },
      include: {
        category: true,
      },
      orderBy: {
        rating: "desc",
      },
    });

    res.json({ success: true, data: restaurants });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/restaurants/:id", async (req, res) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: {
        id: req.params.id,
      },
      include: {
        category: true,
        timings: true,
        menuItems: {
          where: {
            isAvailable: true,
          },
          orderBy: [{ isPopular: "desc" }, { name: "asc" }],
        },
      },
    });

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found",
      });
    }

    res.json({ success: true, data: restaurant });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/menu-items/:id", async (req, res) => {
  try {
    const menuItem = await prisma.menuItem.findUnique({
      where: {
        id: req.params.id,
      },
    });

    if (!menuItem) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    res.json({ success: true, data: menuItem });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/discounts/active", async (req, res) => {
  try {
    const discounts = await prisma.discount.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({ success: true, data: discounts });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/* =========================
   API ROUTES
========================= */

app.use("/api/auth", authRoutes);
app.use("/api/vendors", vendorRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/riders", riderRoutes);
app.use("/api/vendor-dashboard", vendorDashboardRoutes);
app.use("/api/address", addressRoutes);
app.use("/api/favorite", favoriteRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/vendor-analytics", vendorAnalyticsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin", adminVendorRoutes);
app.use("/api/recently-viewed", recentlyViewedRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/upload", uploadRoutes);

app.use("/uploads", express.static("uploads"));

/* =========================
   404
========================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found",
  });
});

/* =========================
   SERVER
========================= */

const PORT = process.env.PORT || 5000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

console.log("SMTP_USER:", process.env.SMTP_USER);
console.log("SMTP_PASS EXISTS:", !!process.env.SMTP_PASS);
console.log("DATABASE_URL EXISTS:", !!process.env.DATABASE_URL);