import express from "express";
import cors from "cors";
import http from "http";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import prisma from "./prisma.js";

import { initSocket } from "./socket.js";
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";
import authRoutes from "./routes/auth.routes.js";
import vendorRoutes from "./routes/vendor.routes.js";
import cartRoutes from "./routes/cart.routes.js";
import orderRoutes from "./routes/order.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import riderRoutes from "./routes/rider.routes.js";
import addressRoutes from "./routes/address.routes.js";
import favoriteRoutes from "./routes/favorite.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import adminVendorRoutes from "./routes/adminVendor.routes.js";
import reviewRoutes from "./routes/review.routes.js";
import recentlyViewedRoutes from "./routes/recentlyViewed.routes.js";
import couponRoutes from "./routes/coupon.routes.js";
import pushRoutes from "./routes/push.routes.js";
import uploadRoutes from "./routes/upload.routes.js";

dotenv.config();

const app = express();
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Karto API",
      version: "1.0.0",
      description: "Karto Backend API Documentation",
    },
    servers: [
      {
        url:
          process.env.NODE_ENV === "production"
            ? "https://karto-backend-kor1.onrender.com"
            : `http://localhost:${process.env.PORT || 5000}`,
      },
    ],
  },
  apis: ["./routes/*.js"],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
const server = http.createServer(app);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const allowedOrigins = [
  process.env.CLIENT_URL,
  process.env.ADMIN_URL,
  process.env.VENDOR_URL,
  process.env.MOBILE_APP_URL,
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8081",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8081",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(null, true);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use("/swagger", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
/* SOCKET */
initSocket(server);

/* HEALTH */
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Karto Backend Running",
    uptime: process.uptime(),
    timestamp: new Date(),
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Karto API healthy",
    uptime: process.uptime(),
    timestamp: new Date(),
  });
});

/* FRONTEND DATA ROUTES */
app.get("/api/categories", async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      where: {
        isActive: true,
      },
      orderBy: { name: "asc" },
    });

    res.json({
      success: true,
      data: categories,
      categories,
    });
  } catch (error) {
    console.error("Categories Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/restaurants/featured", async (req, res) => {
  try {
    const { cityId } = req.query;

    const restaurants = await prisma.restaurant.findMany({
      where: {
        isFeatured: true,
        isOpen: true,
        ...(cityId ? { cityId: String(cityId) } : {}),
      },
      include: {
        category: true,
        timings: true,
      },
      orderBy: [{ rating: "desc" }, { name: "asc" }],
    });

    res.json({
      success: true,
      data: restaurants,
      restaurants,
    });
  } catch (error) {
    console.error("Featured Restaurants Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/restaurants/category/:categoryId", async (req, res) => {
  try {
    const { cityId } = req.query;

    const restaurants = await prisma.restaurant.findMany({
      where: {
        categoryId: req.params.categoryId,
        isOpen: true,
        ...(cityId ? { cityId: String(cityId) } : {}),
      },
      include: {
        category: true,
        timings: true,
      },
      orderBy: [{ rating: "desc" }, { name: "asc" }],
    });

    res.json({
      success: true,
      data: restaurants,
      restaurants,
    });
  } catch (error) {
    console.error("Category Restaurants Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/restaurants", async (req, res) => {
  try {
    const { cityId, categoryId, q, featured } = req.query;

    const restaurants = await prisma.restaurant.findMany({
      where: {
        isOpen: true,
        ...(cityId ? { cityId: String(cityId) } : {}),
        ...(categoryId ? { categoryId: String(categoryId) } : {}),
        ...(featured !== undefined
          ? { isFeatured: String(featured) === "true" }
          : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: String(q), mode: "insensitive" } },
                { description: { contains: String(q), mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        category: true,
        timings: true,
      },
      orderBy: [{ rating: "desc" }, { name: "asc" }],
    });

    res.json({
      success: true,
      data: restaurants,
      restaurants,
    });
  } catch (error) {
    console.error("Restaurants Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/restaurants/:id", async (req, res) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.params.id },
      include: {
        category: true,
        timings: true,
        menuItems: {
          where: { isAvailable: true },
          include: {
            customizations: {
              where: { isActive: true },
              orderBy: { createdAt: "asc" },
            },
            addons: {
              where: { isActive: true },
              orderBy: { createdAt: "asc" },
            },
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

    res.json({
      success: true,
      data: restaurant,
      restaurant,
    });
  } catch (error) {
    console.error("Restaurant Detail Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/menu-items/:id", async (req, res) => {
  try {
    const menuItem = await prisma.menuItem.findUnique({
      where: { id: req.params.id },
      include: {
        restaurant: true,
        customizations: {
          where: { isActive: true },
          orderBy: { createdAt: "asc" },
        },
        addons: {
          where: { isActive: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!menuItem) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    res.json({
      success: true,
      data: menuItem,
      menuItem,
    });
  } catch (error) {
    console.error("Menu Item Detail Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/discounts/active", async (req, res) => {
  try {
    const discounts = await prisma.discount.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      success: true,
      data: discounts,
      discounts,
    });
  } catch (error) {
    console.error("Active Discounts Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* API ROUTES */
app.use("/api/auth", authRoutes);

/* Vendor single source */
app.use("/api/vendor", vendorRoutes);

/* Old compatibility route */
app.use("/api/vendors", vendorRoutes);

app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);

/* Compatibility alias for frontend old service */
app.use("/api/payment", paymentRoutes);

app.use("/api/riders", riderRoutes);

/* Compatibility alias */
app.use("/api/rider", riderRoutes);

app.use("/api/address", addressRoutes);

/* Compatibility alias */
app.use("/api/addresses", addressRoutes);

app.use("/api/favorite", favoriteRoutes);

/* Compatibility alias */
app.use("/api/favorites", favoriteRoutes);

app.use("/api/reviews", reviewRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin", adminVendorRoutes);
app.use("/api/recently-viewed", recentlyViewedRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/upload", uploadRoutes);

/* Compatibility alias */
app.use("/api/uploads", uploadRoutes);

app.use("/uploads", express.static(path.join(__dirname, "../uploads")));
app.use("/uploads", express.static("uploads"));

/* 404 */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found",
    path: req.originalUrl,
  });
});

/* ERROR HANDLER */
app.use((err, req, res, next) => {
  console.error("Server Error:", err);

  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      message: "Payload too large",
    });
  }

  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

/* SERVER */
const PORT = process.env.PORT || 5000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log("DATABASE_URL EXISTS:", !!process.env.DATABASE_URL);
  console.log("SMTP_USER EXISTS:", !!process.env.SMTP_USER);
  console.log("SMTP_PASS EXISTS:", !!process.env.SMTP_PASS);
  console.log("RESEND_API_KEY EXISTS:", !!process.env.RESEND_API_KEY);
});