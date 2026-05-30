import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import prisma from "./prisma.js";

import { env } from "./config/env.js";
import { setSocketInstance } from "./config/socket.js";

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
initSocket(server);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PATCH", "DELETE"],
  },
});

setSocketInstance(io);

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("joinOrderRoom", (orderId) => {
    socket.join(`order:${orderId}`);
    console.log(`Socket ${socket.id} joined order:${orderId}`);
  });

  socket.on("leaveOrderRoom", (orderId) => {
    socket.leave(`order:${orderId}`);
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

// Test route
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Karto Backend Running",
  });
});

// ====== Frontend data routes ======

// Categories
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

// Featured Restaurants
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
// Restaurants by Category
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

// Restaurant Detail
app.get("/api/restaurants/:id", async (req, res) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: {
        id: req.params.id,
      },
      include: {
        category: true,
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

// Menu Item Detail
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
// Active Discounts
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

// ====== Other routes ======
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
app.use("/uploads", express.static("uploads"));
app.use("/api/coupons", couponRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/upload", uploadRoutes);
// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found",
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

console.log("SMTP_USER:", process.env.SMTP_USER);
console.log("SMTP_PASS EXISTS:", !!process.env.SMTP_PASS);
console.log("DATABASE_URL EXISTS:", !!process.env.DATABASE_URL);