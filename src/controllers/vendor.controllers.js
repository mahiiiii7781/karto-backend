// src/controllers/vendor.controllers.js

import prisma from "../prisma.js";
import PDFDocument from "pdfkit";
import { uploadToCloudinary } from "../utils/cloudinaryUpload.js";
import {
  emitOrderStatus,
  emitVendorDashboardRefresh,
  emitVendorRiderAssigned,
} from "../config/socket.js";

const ACTIVE_STATUSES = [
  "PLACED",
  "ACCEPTED_BY_VENDOR",
  "PREPARING",
  "READY_FOR_PICKUP",
  "ASSIGNED_TO_RIDER",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
];

const FINAL_REVENUE_STATUSES = ["DELIVERED"];

const VENDOR_ALLOWED_STATUSES = [
  "ACCEPTED_BY_VENDOR",
  "PREPARING",
  "READY_FOR_PICKUP",
  "CANCELLED",
];

const toNumber = (value) => Number(value || 0);

const normalizeBool = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return Boolean(value);
};

const getDateRange = () => {
  const now = new Date();

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const last7Days = new Date(now);
  last7Days.setDate(now.getDate() - 6);
  last7Days.setHours(0, 0, 0, 0);

  return { todayStart, monthStart, last7Days };
};

const getVendorRestaurantIds = async (userId) => {
  const [ownedRestaurants, memberships] = await Promise.all([
    prisma.restaurant.findMany({
      where: {
        vendorId: userId,
        deletedAt: null,
      },
      select: { id: true },
    }),
    prisma.restaurantMember.findMany({
      where: {
        userId,
        isActive: true,
        restaurant: {
          deletedAt: null,
        },
      },
      select: {
        restaurantId: true,
      },
    }),
  ]);

  return Array.from(
    new Set([
      ...ownedRestaurants.map((restaurant) => restaurant.id),
      ...memberships.map((membership) => membership.restaurantId),
    ])
  );
};

const getPrimaryRestaurant = async (userId, requestedRestaurantId = null) => {
  const restaurantIds = await getVendorRestaurantIds(userId);

  if (!restaurantIds.length) {
    return null;
  }

  const finalRestaurantId =
    requestedRestaurantId &&
    restaurantIds.includes(String(requestedRestaurantId))
      ? String(requestedRestaurantId)
      : restaurantIds[0];

  return prisma.restaurant.findFirst({
    where: {
      id: finalRestaurantId,
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
  });
};

const dayNameToNumber = (value) => {
  const map = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };

  if (!value || String(value).toLowerCase() === "none") return null;
  return map[String(value).toLowerCase()] ?? null;
};

const orderInclude = {
  user: {
    select: {
      id: true,
      fullName: true,
      phone: true,
      email: true,
      avatarUrl: true,
    },
  },
  restaurant: true,
  address: true,
  items: {
    include: { menuItem: true },
    orderBy: { createdAt: "asc" },
  },
  rider: {
    select: {
      id: true,
      fullName: true,
      phone: true,
      email: true,
      avatarUrl: true,
    },
  },
  history: {
    orderBy: { createdAt: "asc" },
  },
};



const roundMoney = (value) =>
  Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;

const cleanOptional = (value) =>
  value === undefined || value === null ? undefined : String(value).trim();

const safeInt = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const pageParams = (req, defaultLimit = 20, maxLimit = 100) => {
  const page = Math.max(1, safeInt(req.query?.page, 1));
  const limit = clamp(safeInt(req.query?.limit, defaultLimit), 1, maxLimit);

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
};

const safeDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getFinanceDateRange = ({ from, to, type = "monthly" } = {}) => {
  const now = new Date();
  let start = safeDate(from);
  let end = safeDate(to);

  if (!start) {
    start = new Date(now);

    if (type === "daily") {
      start.setHours(0, 0, 0, 0);
    } else if (type === "weekly") {
      const day = start.getDay();
      const diff = day === 0 ? 6 : day - 1;
      start.setDate(start.getDate() - diff);
      start.setHours(0, 0, 0, 0);
    } else {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    }
  } else {
    start.setHours(0, 0, 0, 0);
  }

  if (!end) end = new Date(now);
  end.setHours(23, 59, 59, 999);

  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }

  return { start, end };
};

const validLatitude = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= -90 && number <= 90;
};

const validLongitude = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= -180 && number <= 180;
};

const uploadFile = async (req, folder) => {
  if (!req.file) return undefined;
  return uploadToCloudinary(req.file, folder);
};

const isRecognizedOrder = (order) =>
  order?.status === "DELIVERED" &&
  order?.paymentStatus === "PAID";

const isPrepaidMethod = (method) =>
  ["ONLINE", "UPI", "CARD", "WALLET"].includes(
    String(method || "").toUpperCase()
  );

const getCommissionableAmount = (order) => {
  if (
    order?.commissionableAmount !== null &&
    order?.commissionableAmount !== undefined
  ) {
    return roundMoney(order.commissionableAmount);
  }

  const itemTotal = toNumber(order?.itemTotal);
  const discount = toNumber(order?.discount);

  if (itemTotal > 0) {
    return roundMoney(Math.max(itemTotal - discount, 0));
  }

  const total = toNumber(order?.totalAmount);
  const deliveryFee = toNumber(order?.deliveryFee);
  const platformFee = toNumber(order?.platformFee);
  const taxAmount = toNumber(order?.taxAmount);

  return roundMoney(
    Math.max(total - deliveryFee - platformFee - taxAmount, 0)
  );
};

const getOrderFinancials = (order) => {
  const totalAmount = roundMoney(order?.totalAmount);
  const commissionableAmount = getCommissionableAmount(order);

  const commissionRate = roundMoney(
    order?.commissionRate ??
      order?.restaurant?.commission ??
      0
  );

  const platformCommission = roundMoney(
    order?.platformCommissionAmount !== null &&
      order?.platformCommissionAmount !== undefined
      ? order.platformCommissionAmount
      : (commissionableAmount * commissionRate) / 100
  );

  const vendorPayable = roundMoney(
    order?.vendorSettlementAmount !== null &&
      order?.vendorSettlementAmount !== undefined
      ? order.vendorSettlementAmount
      : Math.max(commissionableAmount - platformCommission, 0)
  );

  const hasSnapshot =
    order?.commissionableAmount !== null &&
    order?.commissionableAmount !== undefined &&
    order?.commissionRate !== null &&
    order?.commissionRate !== undefined &&
    order?.platformCommissionAmount !== null &&
    order?.platformCommissionAmount !== undefined &&
    order?.vendorSettlementAmount !== null &&
    order?.vendorSettlementAmount !== undefined;

  return {
    totalAmount,
    commissionableAmount,
    commissionRate,
    platformCommission,
    vendorPayable,
    hasSnapshot,
    legacyCommissionFallback: !hasSnapshot,
  };
};

const ensureOrderSnapshot = async (tx, order) => {
  const financials = getOrderFinancials(order);

  if (financials.hasSnapshot) {
    return { order, financials };
  }

  const updatedOrder = await tx.order.update({
    where: { id: order.id },
    data: {
      commissionableAmount: financials.commissionableAmount,
      commissionRate: financials.commissionRate,
      platformCommissionAmount: financials.platformCommission,
      vendorSettlementAmount: financials.vendorPayable,
    },
    include: { restaurant: true },
  });

  return {
    order: updatedOrder,
    financials: getOrderFinancials(updatedOrder),
  };
};

const cleanOrder = (order) => {
  if (!order) return null;

  return {
    ...order,
    totalAmount: roundMoney(order.totalAmount),
    itemTotal: roundMoney(order.itemTotal),
    deliveryFee: roundMoney(order.deliveryFee),
    discount: roundMoney(order.discount),
    taxAmount: roundMoney(order.taxAmount),
    cgstAmount: roundMoney(order.cgstAmount),
    sgstAmount: roundMoney(order.sgstAmount),
    platformFee: roundMoney(order.platformFee),
    refundAmount: roundMoney(order.refundAmount),
    commissionableAmount:
      order.commissionableAmount === null ||
      order.commissionableAmount === undefined
        ? null
        : roundMoney(order.commissionableAmount),
    commissionRate:
      order.commissionRate === null ||
      order.commissionRate === undefined
        ? null
        : roundMoney(order.commissionRate),
    platformCommissionAmount:
      order.platformCommissionAmount === null ||
      order.platformCommissionAmount === undefined
        ? null
        : roundMoney(order.platformCommissionAmount),
    vendorSettlementAmount:
      order.vendorSettlementAmount === null ||
      order.vendorSettlementAmount === undefined
        ? null
        : roundMoney(order.vendorSettlementAmount),
  };
};

const vendorOrderInclude = {
  ...orderInclude,
  refunds: {
    orderBy: { createdAt: "desc" },
  },
  paymentTransactions: {
    orderBy: { createdAt: "desc" },
  },
};

const getRequestedRestaurantId = (req) =>
  req.params?.restaurantId ||
  req.query?.restaurantId ||
  req.body?.restaurantId ||
  req.body?.restaurant_id ||
  null;

const resolveVendorAccess = async (userId, requestedRestaurantId = null) => {
  const ownerWhere = {
    vendorId: userId,
    deletedAt: null,
    ...(requestedRestaurantId ? { id: String(requestedRestaurantId) } : {}),
  };

  const ownedRestaurant = await prisma.restaurant.findFirst({
    where: ownerWhere,
    include: {
      city: true,
      category: true,
      payoutAccount: true,
    },
    orderBy: { createdAt: "asc" },
  });

  if (ownedRestaurant) {
    return {
      restaurant: ownedRestaurant,
      memberRole: "OWNER",
      permissions: null,
      isOwner: true,
    };
  }

  const membership = await prisma.restaurantMember.findFirst({
    where: {
      userId,
      isActive: true,
      ...(requestedRestaurantId
        ? { restaurantId: String(requestedRestaurantId) }
        : {}),
      restaurant: { deletedAt: null },
    },
    include: {
      restaurant: {
        include: {
          city: true,
          category: true,
          payoutAccount: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  if (!membership) return null;

  return {
    restaurant: membership.restaurant,
    memberRole: membership.role,
    permissions: membership.permissions,
    isOwner: membership.role === "OWNER",
  };
};

const requireVendorAccess = async (req, res) => {
  const requestedRestaurantId = getRequestedRestaurantId(req);

  const access = await resolveVendorAccess(
    req.user.id,
    requestedRestaurantId
  );

  if (!access) {
    res.status(404).json({
      success: false,
      message: requestedRestaurantId
        ? "Restaurant access not found for this vendor"
        : "Vendor restaurant access not found",
    });
    return null;
  }

  return access;
};

const setupPdfResponse = (res, filename, title) => {
  const doc = new PDFDocument({
    size: "A4",
    margin: 42,
    bufferPages: true,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  doc.pipe(res);

  doc.fontSize(20).text("KARTO", { align: "center" });
  doc.fontSize(13).text(title, { align: "center" });
  doc.moveDown(0.5);
  doc
    .fontSize(8)
    .fillColor("#666666")
    .text(`Generated: ${new Date().toLocaleString("en-IN")}`, {
      align: "center",
    });

  doc.fillColor("#000000").moveDown();

  return doc;
};

const pdfKeyValue = (doc, key, value) => {
  doc
    .fontSize(9)
    .font("Helvetica-Bold")
    .text(`${key}: `, { continued: true });

  doc.font("Helvetica").text(String(value ?? "-"));
};

const formatPdfMoney = (value) =>
  `INR ${roundMoney(value).toFixed(2)}`;



const pickFirstDefined = (...values) => {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
};

const normalizeNullableString = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
};

const menuItemInclude = {
  category: true,
  subCategory: true,
  vendorCategory: true,
  vendorSubCategory: true,
  restaurant: true,
};

const emitVendorRefreshSafe = (vendorId, payload = {}) => {
  try {
    if (emitVendorDashboardRefresh) {
      emitVendorDashboardRefresh(vendorId, payload);
    }
  } catch (error) {
    console.warn("Vendor dashboard refresh emit skipped:", error.message);
  }
};

/* =========================
   PUBLIC APIs
========================= */

export const getCategories = async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { name: "asc" },
    });

    return res.json({
      success: true,
      data: categories,
      categories,
    });
  } catch (error) {
    console.error("Categories Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const getVendors = async (req, res) => {
  try {
    const { cityId, categoryId, type, search } = req.query;

    const where = {
      isOpen: true,
      isAcceptingOrders: true,
      ...(cityId && { cityId }),
      ...(categoryId && { categoryId }),
      ...(type && { type }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
          { address: { contains: search, mode: "insensitive" } },
        ],
      }),
    };

    const vendors = await prisma.restaurant.findMany({
      where,
      include: {
        vendor: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
          },
        },
        city: true,
        category: true,
        timings: true,
        menuItems: {
          where: { isAvailable: true },
          take: 5,
          orderBy: [
            { isBestSeller: "desc" },
            { isPopular: "desc" },
            { createdAt: "desc" },
          ],
        },
      },
      orderBy: [
        { isFeatured: "desc" },
        { rating: "desc" },
        { createdAt: "desc" },
      ],
    });

    return res.json({
      success: true,
      data: vendors,
      vendors,
    });
  } catch (error) {
    console.error("Get Vendors Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const getVendorById = async (req, res) => {
  try {
    const { id } = req.params;

    const vendor = await prisma.restaurant.findUnique({
      where: { id },
      include: {
        vendor: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
          },
        },
        city: true,
        category: true,
        timings: true,

        // Restaurant-owned menu categories and nested subcategories.
        // These ids are used by the customer Restaurant Detail sidebar.
        vendorCategories: {
          where: { isActive: true },
          include: {
            subCategories: {
              where: { isActive: true },
              orderBy: { createdAt: "asc" },
            },
          },
          orderBy: { createdAt: "asc" },
        },

        ratings: {
          where: { isActive: true },
          take: 5,
          orderBy: { createdAt: "desc" },
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                avatarUrl: true,
              },
            },
          },
        },

        menuItems: {
          where: { isAvailable: true },
          include: {
            // Keep both vendor-owned and global relations in the API response.
            // Customer menu filtering uses the vendor-owned relations.
            vendorCategory: true,
            vendorSubCategory: true,
            category: true,
            subCategory: true,

            addons: { where: { isActive: true } },
            customizations: { where: { isActive: true } },
            reviews: {
              where: { isActive: true },
              take: 3,
              orderBy: { createdAt: "desc" },
              include: {
                user: {
                  select: {
                    id: true,
                    fullName: true,
                    avatarUrl: true,
                  },
                },
              },
            },
          },
          orderBy: [
            { isBestSeller: "desc" },
            { isPopular: "desc" },
            { createdAt: "desc" },
          ],
        },
      },
    });

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found",
      });
    }

    return res.json({
      success: true,
      data: vendor,
      vendor,
      restaurant: vendor,
    });
  } catch (error) {
    console.error("Get Vendor By Id Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

/* =========================
   DASHBOARD
========================= */

export const getVendorDashboard = async (req, res) => {
  try {
    const vendorId = req.user.id;
    const { todayStart, monthStart } = getDateRange();

    const accessibleRestaurantIds =
      await getVendorRestaurantIds(vendorId);

    const restaurants = await prisma.restaurant.findMany({
      where: {
        id: {
          in: accessibleRestaurantIds,
        },
        deletedAt: null,
      },
      include: {
        orders: {
          include: {
            restaurant: true,
          },
        },
        menuItems: {
          select: {
            id: true,
            isAvailable: true,
          },
        },
        timings: true,
        payoutAccount: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const restaurantIds = restaurants.map((restaurant) => restaurant.id);

    if (!restaurantIds.length) {
      return res.json({
        success: true,
        data: {
          totalRestaurants: 0,
          totalOrders: 0,
          totalMenuItems: 0,
          todayOrders: 0,
          todayRevenue: 0,
          monthlyOrders: 0,
          monthlyRevenue: 0,
          lifetimeRevenue: 0,
          revenue: 0,
          platformCommission: 0,
          vendorPayable: 0,
          activeOrders: 0,
          pendingOrders: 0,
          completedOrders: 0,
          cancelledOrders: 0,
          averageOrderValue: 0,
          restaurants: [],
          restaurantIds: [],
          recentOrders: [],
        },
        dashboard: {
          totalRestaurants: 0,
          totalOrders: 0,
          totalMenuItems: 0,
          revenue: 0,
          restaurants: [],
        },
      });
    }

    const [
      todayOrders,
      monthlyOrders,
      activeOrders,
      pendingOrders,
      deliveredPaidOrders,
      cancelledOrders,
      recentOrders,
      pendingSettlement,
      recentInvoices,
    ] = await Promise.all([
      prisma.order.findMany({
        where: {
          restaurantId: { in: restaurantIds },
          createdAt: { gte: todayStart },
        },
        include: { restaurant: true },
      }),

      prisma.order.findMany({
        where: {
          restaurantId: { in: restaurantIds },
          createdAt: { gte: monthStart },
        },
        include: { restaurant: true },
      }),

      prisma.order.count({
        where: {
          restaurantId: { in: restaurantIds },
          status: { in: ACTIVE_STATUSES },
        },
      }),

      prisma.order.count({
        where: {
          restaurantId: { in: restaurantIds },
          status: "PLACED",
        },
      }),

      prisma.order.findMany({
        where: {
          restaurantId: { in: restaurantIds },
          status: "DELIVERED",
          paymentStatus: "PAID",
        },
        include: { restaurant: true },
      }),

      prisma.order.count({
        where: {
          restaurantId: { in: restaurantIds },
          status: "CANCELLED",
        },
      }),

      prisma.order.findMany({
        where: {
          restaurantId: { in: restaurantIds },
        },
        include: vendorOrderInclude,
        orderBy: { createdAt: "desc" },
        take: 10,
      }),

      prisma.vendorSettlement.aggregate({
        where: {
          restaurantId: { in: restaurantIds },
          status: { in: ["PENDING", "PROCESSING"] },
        },
        _sum: { netAmount: true },
        _count: { _all: true },
      }),

      prisma.vendorInvoice.findMany({
        where: {
          restaurantId: { in: restaurantIds },
        },
        include: {
          restaurant: {
            select: { id: true, name: true },
          },
        },
        orderBy: { generatedAt: "desc" },
        take: 5,
      }),
    ]);

    const summarizeRecognized = (orders) => {
      let recognizedRevenue = 0;
      let platformCommission = 0;
      let vendorPayable = 0;
      let recognizedOrders = 0;

      for (const order of orders) {
        if (!isRecognizedOrder(order)) continue;

        const financials = getOrderFinancials(order);
        recognizedOrders += 1;
        recognizedRevenue += financials.totalAmount;
        platformCommission += financials.platformCommission;
        vendorPayable += financials.vendorPayable;
      }

      return {
        recognizedOrders,
        recognizedRevenue: roundMoney(recognizedRevenue),
        platformCommission: roundMoney(platformCommission),
        vendorPayable: roundMoney(vendorPayable),
      };
    };

    const todaySummary = summarizeRecognized(todayOrders);
    const monthlySummary = summarizeRecognized(monthlyOrders);
    const lifetimeSummary = summarizeRecognized(deliveredPaidOrders);

    const totalOrders = restaurants.reduce(
      (sum, restaurant) => sum + (restaurant.orders?.length || 0),
      0
    );

    const totalMenuItems = restaurants.reduce(
      (sum, restaurant) => sum + (restaurant.menuItems?.length || 0),
      0
    );

    const availableMenuItems = restaurants.reduce(
      (sum, restaurant) =>
        sum +
        (restaurant.menuItems || []).filter((item) => item.isAvailable).length,
      0
    );

    const averageOrderValue =
      monthlySummary.recognizedOrders > 0
        ? monthlySummary.recognizedRevenue /
          monthlySummary.recognizedOrders
        : 0;

    const data = {
      totalRestaurants: restaurants.length,
      totalOrders,
      totalMenuItems,
      availableMenuItems,

      todayOrders: todayOrders.length,
      todayDeliveredPaidOrders: todaySummary.recognizedOrders,
      todayRevenue: todaySummary.recognizedRevenue,
      todayPlatformCommission: todaySummary.platformCommission,
      todayVendorPayable: todaySummary.vendorPayable,

      monthlyOrders: monthlyOrders.length,
      monthlyDeliveredPaidOrders: monthlySummary.recognizedOrders,
      monthlyRevenue: monthlySummary.recognizedRevenue,
      monthlyPlatformCommission: monthlySummary.platformCommission,
      monthlyVendorPayable: monthlySummary.vendorPayable,

      lifetimeRevenue: lifetimeSummary.recognizedRevenue,
      revenue: lifetimeSummary.recognizedRevenue,
      platformCommission: lifetimeSummary.platformCommission,
      vendorPayable: lifetimeSummary.vendorPayable,

      activeOrders,
      pendingOrders,
      completedOrders: deliveredPaidOrders.length,
      cancelledOrders,
      averageOrderValue: roundMoney(averageOrderValue),

      pendingSettlement: {
        amount: roundMoney(pendingSettlement._sum.netAmount),
        count: pendingSettlement._count._all,
      },

      restaurants,
      restaurantIds,
      recentOrders: recentOrders.map(cleanOrder),
      recentInvoices: recentInvoices.map((invoice) => ({
        ...invoice,
        grossAmount: roundMoney(invoice.grossAmount),
        commissionAmount: roundMoney(invoice.commissionAmount),
        adjustmentAmount: roundMoney(invoice.adjustmentAmount),
        netPayable: roundMoney(invoice.netPayable),
      })),
    };

    return res.json({
      success: true,
      data,
      dashboard: {
        ...data,
      },
    });
  } catch (error) {
    console.error("Vendor Dashboard Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch vendor dashboard",
      error: error.message,
    });
  }
};

export const getVendorOrders = async (req, res) => {
  try {
    const {
      status,
      search,
      paymentStatus,
      paymentMethod,
      restaurantId,
      from,
      to,
    } = req.query;

    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    if (!restaurantIds.length) {
      return res.json({
        success: true,
        data: [],
        orders: [],
        pagination: {
          page: 1,
          limit: 25,
          total: 0,
          totalPages: 0,
        },
      });
    }

    const { page, limit, skip } = pageParams(req, 25, 100);

    const selectedRestaurantIds =
      restaurantId && restaurantIds.includes(String(restaurantId))
        ? [String(restaurantId)]
        : restaurantIds;

    const fromDate = safeDate(from);
    const toDate = safeDate(to);

    if (toDate) toDate.setHours(23, 59, 59, 999);

    const where = {
      restaurantId: { in: selectedRestaurantIds },
      ...(status && status !== "ALL" ? { status } : {}),
      ...(paymentStatus && paymentStatus !== "ALL"
        ? { paymentStatus }
        : {}),
      ...(paymentMethod && paymentMethod !== "ALL"
        ? { paymentMethod }
        : {}),
      ...(fromDate || toDate
        ? {
            createdAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              {
                id: {
                  contains: String(search),
                  mode: "insensitive",
                },
              },
              {
                orderNumber: {
                  contains: String(search),
                  mode: "insensitive",
                },
              },
              {
                user: {
                  fullName: {
                    contains: String(search),
                    mode: "insensitive",
                  },
                },
              },
              {
                user: {
                  phone: {
                    contains: String(search),
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: vendorOrderInclude,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),

      prisma.order.count({ where }),
    ]);

    const data = orders.map((order) => ({
      ...cleanOrder(order),
      financials: getOrderFinancials(order),
    }));

    return res.json({
      success: true,
      data,
      orders: data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Vendor Orders Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch vendor orders",
      error: error.message,
    });
  }
};

export const updateVendorOrderStatus = async (req, res) => {
  try {
    const finalOrderId = req.params.orderId || req.params.id;
    const { status, note, estimatedPreparationMinutes } = req.body;

    if (!VENDOR_ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vendor order status",
      });
    }

    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const existingOrder = await prisma.order.findFirst({
      where: {
        id: finalOrderId,
        restaurantId: { in: restaurantIds },
      },
      include: {
        restaurant: true,
        paymentTransactions: {
          where: { status: "SUCCESS" },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found for this vendor",
      });
    }

    const allowedTransitions = {
      PLACED: ["ACCEPTED_BY_VENDOR", "CANCELLED"],
      ACCEPTED_BY_VENDOR: ["PREPARING", "READY_FOR_PICKUP", "CANCELLED"],
      PREPARING: ["READY_FOR_PICKUP", "CANCELLED"],
      READY_FOR_PICKUP: [],
      ASSIGNED_TO_RIDER: [],
      PICKED_UP: [],
      OUT_FOR_DELIVERY: [],
      DELIVERED: [],
      CANCELLED: [],
    };

    const allowedNext = allowedTransitions[existingOrder.status] || [];

    if (!allowedNext.includes(status)) {
      return res.status(409).json({
        success: false,
        message: `Order cannot move from ${existingOrder.status} to ${status}`,
      });
    }

    const order = await prisma.$transaction(async (tx) => {
      if (status === "ACCEPTED_BY_VENDOR") {
        await ensureOrderSnapshot(tx, existingOrder);
      }

      const updateData = { status };

      if (status === "ACCEPTED_BY_VENDOR") {
        updateData.acceptedAt = new Date();
        updateData.vendorId =
          existingOrder.restaurant?.vendorId || existingOrder.vendorId;

        updateData.estimatedPreparationMinutes = Math.max(
          5,
          Math.min(
            120,
            Number(estimatedPreparationMinutes) ||
              existingOrder.estimatedPreparationMinutes ||
              existingOrder.restaurant?.defaultPrepTime ||
              30
          )
        );
      }

      if (status === "PREPARING") {
        updateData.preparingAt = new Date();
      }

      if (status === "READY_FOR_PICKUP") {
        updateData.readyAt = new Date();
      }

      if (status === "CANCELLED") {
        updateData.cancelledAt = new Date();
        updateData.cancelReason = note || "Cancelled by vendor";
        updateData.cancelledBy = req.user.id;
      }

      const updated = await tx.order.update({
        where: { id: finalOrderId },
        data: updateData,
        include: vendorOrderInclude,
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: finalOrderId,
          status,
          changedBy: req.user.id,
          note: note || `Vendor updated order to ${status}`,
        },
      });

      if (
        status === "CANCELLED" &&
        isPrepaidMethod(existingOrder.paymentMethod) &&
        existingOrder.paymentStatus === "PAID"
      ) {
        const existingRefund = await tx.refund.findFirst({
          where: {
            orderId: existingOrder.id,
            status: {
              in: ["PENDING", "PROCESSING", "COMPLETED"],
            },
          },
        });

        if (!existingRefund) {
          await tx.refund.create({
            data: {
              orderId: existingOrder.id,
              paymentTransactionId:
                existingOrder.paymentTransactions?.[0]?.id || null,
              amount: roundMoney(existingOrder.totalAmount),
              reason: note || "Cancelled by vendor",
              status: "PENDING",
            },
          });
        }
      }

      return updated;
    });

    emitOrderStatus(finalOrderId, status, { order });
    emitVendorRefreshSafe(req.user.id, {
      reason: "ORDER_STATUS_UPDATED",
      order,
    });

    if (status === "READY_FOR_PICKUP") {
      try {
        emitOrderStatus(finalOrderId, "READY_FOR_PICKUP", {
          order,
          broadcastToRiders: true,
        });
      } catch {}
    }

    return res.json({
      success: true,
      message:
        status === "CANCELLED" &&
        isPrepaidMethod(order.paymentMethod) &&
        order.paymentStatus === "PAID"
          ? "Order cancelled and refund request created"
          : "Order status updated",
      data: cleanOrder(order),
      order: cleanOrder(order),
    });
  } catch (error) {
    console.error("Vendor Update Order Status Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update order status",
      error: error.message,
    });
  }
};

export const updatePreparationTime = async (req, res) => {
  try {
    const { id } = req.params;
    const { estimatedPreparationMinutes } = req.body;

    const minutes = Number(estimatedPreparationMinutes);

    if (!minutes || minutes < 5 || minutes > 120) {
      return res.status(400).json({
        success: false,
        message: "Preparation time must be between 5 and 120 minutes",
      });
    }

    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const order = await prisma.order.findFirst({
      where: {
        id,
        restaurantId: { in: restaurantIds },
      },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const updated = await prisma.order.update({
      where: { id },
      data: { estimatedPreparationMinutes: minutes },
      include: orderInclude,
    });

    emitVendorRefreshSafe(req.user.id, {
      reason: "PREPARATION_TIME_UPDATED",
      order: updated,
    });

    return res.json({
      success: true,
      message: "Preparation time updated",
      data: updated,
      order: updated,
    });
  } catch (error) {
    console.error("Update Prep Time Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

/* =========================
   RIDERS
========================= */

export const getAvailableRidersForVendor = async (req, res) => {
  try {
    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const requestedRestaurantId = String(
      req.query?.restaurantId || restaurantIds[0] || ""
    );

    if (!requestedRestaurantId || !restaurantIds.includes(requestedRestaurantId)) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found for this vendor",
      });
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: requestedRestaurantId },
      select: {
        id: true,
        cityId: true,
        latitude: true,
        longitude: true,
      },
    });

    const riders = await prisma.user.findMany({
      where: {
        role: "RIDER",
        isActive: true,
        isOnline: true,
        kycStatus: "APPROVED",
        deletedAt: null,
        blockedAt: null,
        ...(restaurant?.cityId ? { cityId: restaurant.cityId } : {}),
        riderProfile: {
          is: {
            availabilityStatus: "AVAILABLE",
          },
        },
      },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        avatarUrl: true,
        vehicleNo: true,
        vehicleType: true,
        lastSeen: true,
        riderProfile: {
          select: {
            availabilityStatus: true,
            maxOrderCapacity: true,
            rating: true,
            totalRatings: true,
          },
        },
        riderLocations: {
          orderBy: { updatedAt: "desc" },
          take: 1,
        },
        _count: {
          select: {
            riderOrders: {
              where: {
                status: {
                  in: ["ASSIGNED_TO_RIDER", "PICKED_UP", "OUT_FOR_DELIVERY"],
                },
              },
            },
          },
        },
      },
      orderBy: { lastSeen: "desc" },
    });

    const mappedRiders = riders
      .filter((rider) => {
        const capacity = Math.max(
          1,
          rider.riderProfile?.maxOrderCapacity || 1
        );
        return rider._count.riderOrders < capacity;
      })
      .map((rider) => {
        const latestLocation = rider.riderLocations?.[0] || null;

        return {
          id: rider.id,
          fullName: rider.fullName,
          phone: rider.phone,
          email: rider.email,
          avatarUrl: rider.avatarUrl,
          vehicleNo: rider.vehicleNo,
          vehicleType: rider.vehicleType,
          isAvailable: true,
          currentStatus: rider.riderProfile?.availabilityStatus || "AVAILABLE",
          rating: toNumber(rider.riderProfile?.rating),
          totalRatings: rider.riderProfile?.totalRatings || 0,
          activeOrders: rider._count.riderOrders,
          maxOrderCapacity: rider.riderProfile?.maxOrderCapacity || 1,
          latitude: latestLocation
            ? toNumber(latestLocation.latitude)
            : null,
          longitude: latestLocation
            ? toNumber(latestLocation.longitude)
            : null,
          distanceKm: null,
          distanceText: "Live location available after active delivery starts",
          lastSeen: rider.lastSeen,
        };
      });

    return res.json({
      success: true,
      data: mappedRiders,
      riders: mappedRiders,
    });
  } catch (error) {
    console.error("Get Available Riders Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch available riders",
      error: error.message,
    });
  }
};

export const assignVendorOrderRider = async (req, res) => {
  try {
    const { id } = req.params;
    const { riderId } = req.body;

    if (!riderId) {
      return res.status(400).json({
        success: false,
        message: "Rider id is required",
      });
    }

    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const existingOrder = await prisma.order.findFirst({
      where: {
        id,
        restaurantId: { in: restaurantIds },
      },
      include: {
        restaurant: true,
        rider: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
          },
        },
      },
    });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found for this vendor",
      });
    }

    if (
      existingOrder.status !== "READY_FOR_PICKUP" &&
      existingOrder.status !== "ASSIGNED_TO_RIDER"
    ) {
      return res.status(409).json({
        success: false,
        message: "Rider can be assigned only after order is ready",
      });
    }

    const rider = await prisma.user.findFirst({
      where: {
        id: riderId,
        role: "RIDER",
        isActive: true,
        isOnline: true,
        kycStatus: "APPROVED",
        deletedAt: null,
        blockedAt: null,
        ...(existingOrder.restaurant?.cityId
          ? { cityId: existingOrder.restaurant.cityId }
          : {}),
      },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        avatarUrl: true,
        riderProfile: true,
      },
    });

    if (!rider) {
      return res.status(404).json({
        success: false,
        message: "Eligible online rider not found",
      });
    }

    const activeCount = await prisma.order.count({
      where: {
        riderId,
        id: { not: id },
        status: {
          in: ["ASSIGNED_TO_RIDER", "PICKED_UP", "OUT_FOR_DELIVERY"],
        },
      },
    });

    const capacity = Math.max(
      1,
      rider.riderProfile?.maxOrderCapacity || 1
    );

    if (
      rider.riderProfile?.availabilityStatus !== "AVAILABLE" ||
      activeCount >= capacity
    ) {
      return res.status(409).json({
        success: false,
        message: "Rider is currently unavailable or at delivery capacity",
      });
    }

    const order = await prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id },
        data: {
          riderId,
          status: "ASSIGNED_TO_RIDER",
        },
        include: orderInclude,
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          status: "ASSIGNED_TO_RIDER",
          changedBy: req.user.id,
          note: existingOrder.riderId
            ? `Rider reassigned to ${rider.fullName || rider.phone || rider.id}`
            : `Rider assigned to ${rider.fullName || rider.phone || rider.id}`,
        },
      });

      await tx.riderProfile.upsert({
        where: { userId: riderId },
        update: { availabilityStatus: "BUSY" },
        create: {
          userId: riderId,
          availabilityStatus: "BUSY",
        },
      });

      if (
        existingOrder.riderId &&
        existingOrder.riderId !== riderId
      ) {
        const oldActiveOrders = await tx.order.count({
          where: {
            riderId: existingOrder.riderId,
            id: { not: id },
            status: {
              in: ["ASSIGNED_TO_RIDER", "PICKED_UP", "OUT_FOR_DELIVERY"],
            },
          },
        });

        if (oldActiveOrders === 0) {
          await tx.riderProfile.upsert({
            where: { userId: existingOrder.riderId },
            update: { availabilityStatus: "AVAILABLE" },
            create: {
              userId: existingOrder.riderId,
              availabilityStatus: "AVAILABLE",
            },
          });
        }
      }

      return updated;
    });

    emitOrderStatus(id, "ASSIGNED_TO_RIDER", {
      order,
      rider,
      assignedBy: req.user.id,
    });

    try {
      if (emitVendorRiderAssigned) {
        emitVendorRiderAssigned(req.user.id, {
          order,
          rider,
        });
      }
    } catch (error) {
      console.warn(
        "Vendor rider assigned socket skipped:",
        error.message
      );
    }

    emitVendorRefreshSafe(req.user.id, {
      reason: existingOrder.riderId
        ? "RIDER_REASSIGNED"
        : "RIDER_ASSIGNED",
      order,
      rider,
    });

    return res.json({
      success: true,
      message: existingOrder.riderId
        ? "Rider reassigned successfully"
        : "Rider assigned successfully",
      data: cleanOrder(order),
      order: cleanOrder(order),
    });
  } catch (error) {
    console.error("Assign Vendor Order Rider Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to assign rider",
      error: error.message,
    });
  }
};

export const getVendorMenu = async (req, res) => {
  try {
    const { search, categoryId, category_id, vendorCategoryId, vendor_category_id, restaurantId, restaurant_id, available } = req.query;

    const restaurantIds = await getVendorRestaurantIds(req.user.id);
    const finalRestaurantId = restaurantId || restaurant_id;
    const finalCategoryId = categoryId || category_id || vendorCategoryId || vendor_category_id;

    const where = {
      restaurantId: finalRestaurantId && restaurantIds.includes(String(finalRestaurantId))
        ? String(finalRestaurantId)
        : { in: restaurantIds },
      ...(finalCategoryId && {
        OR: [
          { vendorCategoryId: String(finalCategoryId) },
          { categoryId: String(finalCategoryId) },
        ],
      }),
      ...(available !== undefined && {
        isAvailable: normalizeBool(available),
      }),
      ...(search && {
        OR: [
          { name: { contains: String(search), mode: "insensitive" } },
          { description: { contains: String(search), mode: "insensitive" } },
        ],
      }),
    };

    const items = await prisma.menuItem.findMany({
      where,
      include: menuItemInclude,
      orderBy: [
        { isBestSeller: "desc" },
        { isPopular: "desc" },
        { createdAt: "desc" },
      ],
    });

    return res.json({
      success: true,
      data: items,
      items,
      menuItems: items,
    });
  } catch (error) {
    console.error("Get Vendor Menu Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const createVendorMenuItem = async (req, res) => {
  try {
    const requestedRestaurantId = req.body.restaurantId || req.body.restaurant_id;

    const restaurant = requestedRestaurantId
      ? await prisma.restaurant.findFirst({
          where: {
            id: String(requestedRestaurantId),
            vendorId: req.user.id,
          },
        })
      : await getPrimaryRestaurant(req.user.id);

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "No restaurant found for this vendor",
      });
    }

    const {
      name,
      description,
      price,
      isVeg,
      is_veg,
      isVegetarian,
      is_vegetarian,
      isPopular,
      is_popular,
      isBestSeller,
      is_best_seller,
      isAvailable,
      is_available,
      prepTimeMin,
      prep_time_min,
      categoryId,
      category_id,
      subCategoryId,
      sub_category_id,
      vendorCategoryId,
      vendor_category_id,
      vendorSubCategoryId,
      vendor_sub_category_id,
      imageUrl,
      image_url,
    } = req.body;

    if (!name || price === undefined || price === null || Number(price) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Name and valid price are required",
      });
    }

    const finalVendorCategoryId = pickFirstDefined(vendorCategoryId, vendor_category_id, categoryId, category_id);
    const finalGlobalCategoryId = pickFirstDefined(categoryId, category_id);
    const finalSubCategoryId = pickFirstDefined(subCategoryId, sub_category_id);
    const finalVendorSubCategoryId = pickFirstDefined(vendorSubCategoryId, vendor_sub_category_id);
    const finalImageUrl = pickFirstDefined(imageUrl, image_url, req.file?.path, null);
    const veg = pickFirstDefined(isVeg, is_veg, isVegetarian, is_vegetarian, true);
    const popular = pickFirstDefined(isPopular, is_popular, false);
    const bestSeller = pickFirstDefined(isBestSeller, is_best_seller, false);
    const available = pickFirstDefined(isAvailable, is_available, true);
    const prep = pickFirstDefined(prepTimeMin, prep_time_min, 20);

    if (finalVendorCategoryId) {
      const category = await prisma.vendorCategory.findFirst({
        where: {
          id: String(finalVendorCategoryId),
          restaurantId: restaurant.id,
        },
        select: { id: true },
      });

      if (!category) {
        return res.status(400).json({
          success: false,
          message: "Selected category does not belong to this restaurant",
        });
      }
    }

    const item = await prisma.menuItem.create({
      data: {
        restaurantId: restaurant.id,
        name: String(name).trim(),
        description: normalizeNullableString(description),
        price: Number(price),
        imageUrl: finalImageUrl,
        isVeg: normalizeBool(veg, true),
        isVegetarian: normalizeBool(veg, true),
        isPopular: normalizeBool(popular),
        isBestSeller: normalizeBool(bestSeller),
        isAvailable: normalizeBool(available, true),
        prepTimeMin: Number(prep) || 20,
        categoryId: finalGlobalCategoryId && !finalVendorCategoryId ? String(finalGlobalCategoryId) : null,
        subCategoryId: finalSubCategoryId ? String(finalSubCategoryId) : null,
        vendorCategoryId: finalVendorCategoryId ? String(finalVendorCategoryId) : null,
        vendorSubCategoryId: finalVendorSubCategoryId ? String(finalVendorSubCategoryId) : null,
      },
      include: menuItemInclude,
    });

    emitVendorRefreshSafe(req.user.id, {
      reason: "MENU_ITEM_CREATED",
      item,
    });

    return res.status(201).json({
      success: true,
      message: "Menu item created",
      data: item,
      item,
      menuItem: item,
    });
  } catch (error) {
    console.error("Create Vendor Menu Item Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const updateVendorMenuItem = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const existing = await prisma.menuItem.findFirst({
      where: {
        id,
        restaurantId: { in: restaurantIds },
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    const body = req.body || {};
    const data = {};

    if (body.name !== undefined) data.name = String(body.name).trim();
    if (body.description !== undefined) data.description = normalizeNullableString(body.description);
    if (body.price !== undefined) data.price = Number(body.price);

    const image = pickFirstDefined(body.imageUrl, body.image_url, req.file?.path);
    if (image !== undefined) data.imageUrl = image;

    const prep = pickFirstDefined(body.prepTimeMin, body.prep_time_min);
    if (prep !== undefined) data.prepTimeMin = Number(prep) || 20;

    const veg = pickFirstDefined(body.isVeg, body.is_veg, body.isVegetarian, body.is_vegetarian);
    if (veg !== undefined) {
      data.isVeg = normalizeBool(veg, true);
      data.isVegetarian = normalizeBool(veg, true);
    }

    const popular = pickFirstDefined(body.isPopular, body.is_popular);
    if (popular !== undefined) data.isPopular = normalizeBool(popular);

    const bestSeller = pickFirstDefined(body.isBestSeller, body.is_best_seller);
    if (bestSeller !== undefined) data.isBestSeller = normalizeBool(bestSeller);

    const available = pickFirstDefined(body.isAvailable, body.is_available);
    if (available !== undefined) data.isAvailable = normalizeBool(available, true);

    const requestedRestaurantId = body.restaurantId || body.restaurant_id;
    if (requestedRestaurantId !== undefined && String(requestedRestaurantId) !== existing.restaurantId) {
      if (!restaurantIds.includes(String(requestedRestaurantId))) {
        return res.status(400).json({
          success: false,
          message: "Selected restaurant does not belong to this vendor",
        });
      }
      data.restaurantId = String(requestedRestaurantId);
    }

    const finalRestaurantId = data.restaurantId || existing.restaurantId;
    const finalVendorCategoryId = pickFirstDefined(body.vendorCategoryId, body.vendor_category_id, body.categoryId, body.category_id);
    if (finalVendorCategoryId !== undefined) {
      if (finalVendorCategoryId) {
        const category = await prisma.vendorCategory.findFirst({
          where: {
            id: String(finalVendorCategoryId),
            restaurantId: finalRestaurantId,
          },
          select: { id: true },
        });

        if (!category) {
          return res.status(400).json({
            success: false,
            message: "Selected category does not belong to this restaurant",
          });
        }
        data.vendorCategoryId = String(finalVendorCategoryId);
        data.categoryId = null;
      } else {
        data.vendorCategoryId = null;
      }
    }

    const vendorSubCategoryId = pickFirstDefined(body.vendorSubCategoryId, body.vendor_sub_category_id);
    if (vendorSubCategoryId !== undefined) {
      data.vendorSubCategoryId = vendorSubCategoryId ? String(vendorSubCategoryId) : null;
    }

    const subCategoryId = pickFirstDefined(body.subCategoryId, body.sub_category_id);
    if (subCategoryId !== undefined) {
      data.subCategoryId = subCategoryId ? String(subCategoryId) : null;
    }

    const updated = await prisma.menuItem.update({
      where: { id },
      data,
      include: menuItemInclude,
    });

    emitVendorRefreshSafe(req.user.id, {
      reason: "MENU_ITEM_UPDATED",
      item: updated,
    });

    return res.json({
      success: true,
      message: "Menu item updated",
      data: updated,
      item: updated,
      menuItem: updated,
    });
  } catch (error) {
    console.error("Update Vendor Menu Item Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const toggleVendorMenuItemAvailability = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const existing = await prisma.menuItem.findFirst({
      where: {
        id,
        restaurantId: { in: restaurantIds },
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    const updated = await prisma.menuItem.update({
      where: { id },
      data: {
        isAvailable:
          req.body.isAvailable !== undefined
            ? normalizeBool(req.body.isAvailable)
            : !existing.isAvailable,
      },
      include: {
        category: true,
        subCategory: true,
        vendorCategory: true,
        vendorSubCategory: true,
      },
    });

    emitVendorRefreshSafe(req.user.id, {
      reason: "MENU_ITEM_AVAILABILITY_UPDATED",
      item: updated,
    });

    return res.json({
      success: true,
      message: "Menu item availability updated",
      data: updated,
      item: updated,
    });
  } catch (error) {
    console.error("Toggle Menu Item Availability Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const deleteVendorMenuItem = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const existing = await prisma.menuItem.findFirst({
      where: {
        id,
        restaurantId: { in: restaurantIds },
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    const linkedOrderItems = await prisma.orderItem.count({
      where: { menuItemId: id },
    });

    if (linkedOrderItems > 0) {
      const updated = await prisma.menuItem.update({
        where: { id },
        data: { isAvailable: false },
        include: menuItemInclude,
      });

      emitVendorRefreshSafe(req.user.id, {
        reason: "MENU_ITEM_DISABLED",
        item: updated,
      });

      return res.json({
        success: true,
        message:
          "Item has order history, so it was disabled instead of permanently deleted",
        data: updated,
        item: updated,
        menuItem: updated,
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.menuItemAddon.deleteMany({
        where: { menuItemId: id },
      });

      await tx.menuItemCustomization.deleteMany({
        where: { menuItemId: id },
      });

      await tx.menuItem.delete({
        where: { id },
      });
    });

    emitVendorRefreshSafe(req.user.id, {
      reason: "MENU_ITEM_DELETED",
      itemId: id,
    });

    return res.json({
      success: true,
      message: "Menu item deleted",
    });
  } catch (error) {
    console.error("Delete Vendor Menu Item Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to delete menu item",
      error: error.message,
    });
  }
};

export const getVendorCategories = async (req, res) => {
  try {
    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const categories = await prisma.vendorCategory.findMany({
      where: {
        restaurantId: { in: restaurantIds },
      },
      include: {
        subCategories: true,
        menuItems: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json({
      success: true,
      data: categories,
      categories,
      vendorCategories: categories,
    });
  } catch (error) {
    console.error("Get Vendor Categories Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const createVendorCategory = async (req, res) => {
  try {
    const restaurant = await getPrimaryRestaurant(req.user.id);

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "No restaurant found for this vendor",
      });
    }

    const { name, description, imageUrl, isActive } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Category name is required",
      });
    }

    const category = await prisma.vendorCategory.create({
      data: {
        restaurantId: restaurant.id,
        name: String(name).trim(),
        description: description || null,
        imageUrl: imageUrl || req.file?.path || null,
        isActive: normalizeBool(isActive, true),
      },
      include: {
        subCategories: true,
        menuItems: true,
      },
    });

    emitVendorRefreshSafe(req.user.id, {
      reason: "VENDOR_CATEGORY_CREATED",
      category,
    });

    return res.status(201).json({
      success: true,
      message: "Category created",
      data: category,
      category,
    });
  } catch (error) {
    console.error("Create Vendor Category Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const updateVendorCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const existing = await prisma.vendorCategory.findFirst({
      where: {
        id,
        restaurantId: { in: restaurantIds },
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    const { name, description, imageUrl, isActive } = req.body;

    const category = await prisma.vendorCategory.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(description !== undefined && { description }),
        ...(imageUrl !== undefined && { imageUrl }),
        ...(req.file?.path && { imageUrl: req.file.path }),
        ...(isActive !== undefined && { isActive: normalizeBool(isActive) }),
      },
      include: {
        subCategories: true,
        menuItems: true,
      },
    });

    emitVendorRefreshSafe(req.user.id, {
      reason: "VENDOR_CATEGORY_UPDATED",
      category,
    });

    return res.json({
      success: true,
      message: "Category updated",
      data: category,
      category,
    });
  } catch (error) {
    console.error("Update Vendor Category Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const deleteVendorCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const existing = await prisma.vendorCategory.findFirst({
      where: {
        id,
        restaurantId: { in: restaurantIds },
      },
      include: {
        menuItems: true,
        subCategories: true,
      },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    if (existing.menuItems.length > 0 || existing.subCategories.length > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot delete category with menu items or subcategories. Pause it instead.",
      });
    }

    await prisma.vendorCategory.delete({
      where: { id },
    });

    emitVendorRefreshSafe(req.user.id, {
      reason: "VENDOR_CATEGORY_DELETED",
      categoryId: id,
    });

    return res.json({
      success: true,
      message: "Category deleted",
    });
  } catch (error) {
    console.error("Delete Vendor Category Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

/* =========================
   PROFILE / SETTINGS
========================= */

export const getVendorProfile = async (req, res) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const finalRestaurant = await prisma.restaurant.findUnique({
      where: { id: access.restaurant.id },
      include: {
        vendor: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
          },
        },
        city: true,
        category: true,
        timings: true,
        vendorCategories: true,
      },
    });

    return res.json({
      success: true,
      data: finalRestaurant,
      restaurant: finalRestaurant,
      profile: finalRestaurant,
    });
  } catch (error) {
    console.error("Get Vendor Profile Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const updateVendorSettings = async (req, res) => {
  try {
    const { id } = req.params;

    const requestedRestaurantId =
      id && id !== "me"
        ? String(id)
        : getRequestedRestaurantId(req);

    const access = await resolveVendorAccess(
      req.user.id,
      requestedRestaurantId
    );

    if (!access) {
      return res.status(404).json({
        success: false,
        message: requestedRestaurantId
          ? "Restaurant access not found for this vendor"
          : "Vendor restaurant access not found",
      });
    }

    if (!["OWNER", "MANAGER"].includes(access.memberRole)) {
      return res.status(403).json({
        success: false,
        message: "Only owner or manager can update restaurant settings",
      });
    }

    const restaurant = access.restaurant;

    const body = req.body || {};
    const data = {};

    if (body.name !== undefined) data.name = String(body.name).trim();
    if (body.phone !== undefined) data.phone = String(body.phone).trim();
    if (body.email !== undefined) data.email = String(body.email).trim();
    if (body.address !== undefined) data.address = String(body.address).trim();
    if (body.deliveryTime !== undefined || body.delivery_time !== undefined) {
      data.deliveryTime = String(body.deliveryTime ?? body.delivery_time);
    }
    if (body.minimumOrder !== undefined || body.minimum_order !== undefined) {
      data.minimumOrder = Number(body.minimumOrder ?? body.minimum_order);
    }
    if (body.isOpen !== undefined || body.is_open !== undefined) {
      data.isOpen = normalizeBool(body.isOpen ?? body.is_open);
    }
    if (body.isAcceptingOrders !== undefined || body.is_accepting_orders !== undefined) {
      data.isAcceptingOrders = normalizeBool(body.isAcceptingOrders ?? body.is_accepting_orders);
    }
    if (body.defaultPrepTime !== undefined || body.default_prep_time !== undefined) {
      data.defaultPrepTime = Number(body.defaultPrepTime ?? body.default_prep_time) || 30;
    }
    if (body.openingTime !== undefined || body.opening_time !== undefined) {
      data.openingTime = String(body.openingTime ?? body.opening_time);
    }
    if (body.closingTime !== undefined || body.closing_time !== undefined) {
      data.closingTime = String(body.closingTime ?? body.closing_time);
    }
    if (body.weeklyOffDay !== undefined || body.weekly_off_day !== undefined) {
      data.weeklyOffDay = String(body.weeklyOffDay ?? body.weekly_off_day);
    }

    const image = pickFirstDefined(body.imageUrl, body.image_url, body.logoUrl, body.logo_url, req.file?.path);
    if (image !== undefined) data.imageUrl = image;

    const banner = pickFirstDefined(body.bannerUrl, body.banner_url, body.coverUrl, body.cover_url);
    if (banner !== undefined) data.bannerUrl = banner;

    const updated = await prisma.restaurant.update({
      where: { id: restaurant.id },
      data,
      include: {
        vendor: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
          },
        },
        city: true,
        category: true,
        timings: true,
        vendorCategories: true,
      },
    });

    const openingTime = data.openingTime;
    const closingTime = data.closingTime;
    const weeklyOffDay = data.weeklyOffDay;

    if (openingTime && closingTime) {
      const weeklyOff = dayNameToNumber(weeklyOffDay);

      for (let day = 0; day <= 6; day++) {
        await prisma.restaurantTiming.upsert({
          where: {
            restaurantId_dayOfWeek: {
              restaurantId: restaurant.id,
              dayOfWeek: day,
            },
          },
          update: {
            openTime: String(openingTime),
            closeTime: String(closingTime),
            isClosed: weeklyOff === day,
          },
          create: {
            restaurantId: restaurant.id,
            dayOfWeek: day,
            openTime: String(openingTime),
            closeTime: String(closingTime),
            isClosed: weeklyOff === day,
          },
        });
      }
    }

    const finalRestaurant = await prisma.restaurant.findUnique({
      where: { id: restaurant.id },
      include: {
        vendor: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
          },
        },
        city: true,
        category: true,
        timings: true,
        vendorCategories: true,
      },
    });

    emitVendorRefreshSafe(req.user.id, {
      reason: "VENDOR_SETTINGS_UPDATED",
      restaurant: finalRestaurant || updated,
    });

    return res.json({
      success: true,
      message: "Vendor settings updated",
      data: finalRestaurant || updated,
      restaurant: finalRestaurant || updated,
      profile: finalRestaurant || updated,
    });
  } catch (error) {
    console.error("Update Vendor Settings Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const toggleVendorOpenClose = async (req, res) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    if (!["OWNER", "MANAGER"].includes(access.memberRole)) {
      return res.status(403).json({
        success: false,
        message: "Only owner or manager can change store availability",
      });
    }

    const restaurant = access.restaurant;

    const nextOpen =
      req.body.isOpen !== undefined
        ? normalizeBool(req.body.isOpen)
        : !restaurant.isOpen;

    const updated = await prisma.restaurant.update({
      where: { id: restaurant.id },
      data: {
        isOpen: nextOpen,
        isAcceptingOrders:
          req.body.isAcceptingOrders !== undefined
            ? normalizeBool(req.body.isAcceptingOrders)
            : nextOpen,
      },
      include: { timings: true },
    });

    emitVendorRefreshSafe(req.user.id, {
      reason: "VENDOR_OPEN_CLOSE_UPDATED",
      restaurant: updated,
    });

    return res.json({
      success: true,
      message: nextOpen ? "Restaurant opened" : "Restaurant closed",
      data: updated,
      restaurant: updated,
    });
  } catch (error) {
    console.error("Toggle Vendor Open Close Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

export const setVendorBusyMode = async (req, res) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    if (!["OWNER", "MANAGER"].includes(access.memberRole)) {
      return res.status(403).json({
        success: false,
        message: "Only owner or manager can change busy mode",
      });
    }

    const restaurant = access.restaurant;

    const rawMinutes =
      req.body?.minutes === undefined ||
      req.body?.minutes === null ||
      req.body?.minutes === ""
        ? 30
        : Number(req.body.minutes);

    if (!Number.isFinite(rawMinutes)) {
      return res.status(400).json({
        success: false,
        message: "Busy time must be a valid number",
      });
    }

    if (rawMinutes === 0) {
      const updated = await prisma.restaurant.update({
        where: { id: restaurant.id },
        data: {
          busyUntil: null,
          isOpen: true,
          isAcceptingOrders: true,
        },
        include: { timings: true },
      });

      emitVendorRefreshSafe(req.user.id, {
        reason: "VENDOR_BUSY_MODE_CLEARED",
        restaurant: updated,
        busyUntil: null,
        busyMinutes: 0,
      });

      return res.json({
        success: true,
        message: "Busy mode cleared",
        data: {
          restaurant: updated,
          busyUntil: null,
          busyMinutes: 0,
        },
        restaurant: updated,
      });
    }

    if (rawMinutes < 5 || rawMinutes > 180) {
      return res.status(400).json({
        success: false,
        message: "Busy time must be 0 or between 5 and 180 minutes",
      });
    }

    const minutes = Math.round(rawMinutes);
    const busyUntil = new Date(
      Date.now() + minutes * 60 * 1000
    );

    const updated = await prisma.restaurant.update({
      where: { id: restaurant.id },
      data: {
        isOpen: false,
        isAcceptingOrders: false,
        busyUntil,
      },
      include: { timings: true },
    });

    emitVendorRefreshSafe(req.user.id, {
      reason: "VENDOR_BUSY_MODE_ENABLED",
      restaurant: updated,
      busyUntil,
      busyMinutes: minutes,
    });

    return res.json({
      success: true,
      message: `Busy mode enabled for ${minutes} minutes`,
      data: {
        restaurant: updated,
        busyUntil,
        busyMinutes: minutes,
      },
      restaurant: updated,
    });
  } catch (error) {
    console.error("Vendor Busy Mode Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update busy mode",
      error: error.message,
    });
  }
};

/* =========================
   PAYMENTS / ANALYTICS
========================= */

export const getVendorPayments = async (req, res) => {
  try {
    const vendorId = req.user.id;
    const restaurantIds = await getVendorRestaurantIds(vendorId);
    const { page, limit, skip } = pageParams(req, 25, 100);

    const status = String(req.query?.status || "").toUpperCase();

    const where = {
      restaurantId: { in: restaurantIds },
      ...(status && status !== "ALL" ? { status } : {}),
    };

    const [settlements, total, aggregate, invoices] = await Promise.all([
      prisma.vendorSettlement.findMany({
        where,
        include: {
          restaurant: true,
          order: {
            select: {
              id: true,
              orderNumber: true,
              status: true,
              paymentMethod: true,
              paymentStatus: true,
              deliveredAt: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),

      prisma.vendorSettlement.count({ where }),

      prisma.vendorSettlement.aggregate({
        where: {
          restaurantId: { in: restaurantIds },
        },
        _sum: {
          grossAmount: true,
          commissionAmount: true,
          netAmount: true,
        },
      }),

      prisma.vendorInvoice.findMany({
        where: {
          restaurantId: { in: restaurantIds },
        },
        include: {
          restaurant: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: { generatedAt: "desc" },
        take: 10,
      }),
    ]);

    const pendingAmount = settlements
      .filter((settlement) =>
        ["PENDING", "PROCESSING"].includes(settlement.status)
      )
      .reduce((sum, settlement) => sum + toNumber(settlement.netAmount), 0);

    const paidAmount = settlements
      .filter((settlement) => settlement.status === "PAID")
      .reduce((sum, settlement) => sum + toNumber(settlement.netAmount), 0);

    return res.json({
      success: true,
      data: {
        grossEarnings: roundMoney(aggregate._sum.grossAmount),
        platformFee: roundMoney(aggregate._sum.commissionAmount),
        netPayable: roundMoney(aggregate._sum.netAmount),
        pendingAmount: roundMoney(pendingAmount),
        paidAmount: roundMoney(paidAmount),
        settlements: settlements.map((settlement) => ({
          ...settlement,
          grossAmount: roundMoney(settlement.grossAmount),
          commissionRate:
            settlement.commissionRate === null
              ? null
              : roundMoney(settlement.commissionRate),
          commissionAmount: roundMoney(settlement.commissionAmount),
          netAmount: roundMoney(settlement.netAmount),
        })),
        invoices: invoices.map((invoice) => ({
          ...invoice,
          grossAmount: roundMoney(invoice.grossAmount),
          commissionAmount: roundMoney(invoice.commissionAmount),
          adjustmentAmount: roundMoney(invoice.adjustmentAmount),
          netPayable: roundMoney(invoice.netPayable),
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error("Vendor Payments Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch vendor payments",
      error: error.message,
    });
  }
};

export const getVendorEarningsGraph = async (req, res) => {
  try {
    const vendorId = req.user.id;
    const { last7Days } = getDateRange();

    const restaurantIds = await getVendorRestaurantIds(vendorId);

    const orders = await prisma.order.findMany({
      where: {
        restaurantId: { in: restaurantIds },
        deliveredAt: { gte: last7Days },
        status: "DELIVERED",
        paymentStatus: "PAID",
      },
      include: {
        restaurant: true,
      },
      orderBy: { deliveredAt: "asc" },
    });

    const result = [];

    for (let i = 0; i < 7; i++) {
      const date = new Date(last7Days);
      date.setDate(last7Days.getDate() + i);

      const key = date.toISOString().slice(0, 10);

      const dayOrders = orders.filter((order) => {
        const orderDate = order.deliveredAt || order.createdAt;
        return orderDate.toISOString().slice(0, 10) === key;
      });

      let grossRevenue = 0;
      let platformCommission = 0;
      let vendorEarnings = 0;

      for (const order of dayOrders) {
        const financials = getOrderFinancials(order);

        grossRevenue += financials.totalAmount;
        platformCommission += financials.platformCommission;
        vendorEarnings += financials.vendorPayable;
      }

      result.push({
        date: key,
        label: date.toLocaleDateString("en-IN", {
          weekday: "short",
        }),
        orders: dayOrders.length,
        grossRevenue: roundMoney(grossRevenue),
        platformCommission: roundMoney(platformCommission),
        earnings: roundMoney(vendorEarnings),
        revenue: roundMoney(vendorEarnings),
      });
    }

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Graph Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch earnings graph",
      error: error.message,
    });
  }
};

export const getVendorNotifications = async (req, res) => {
  try {
    const restaurantIds = await getVendorRestaurantIds(req.user.id);
    const { page, limit, skip } = pageParams(req, 30, 100);
    const unreadOnly = normalizeBool(req.query?.unreadOnly, false);

    const notificationWhere = {
      OR: [{ userId: req.user.id }, { userId: null }],
      ...(unreadOnly ? { isRead: false } : {}),
    };

    const [notifications, total, unreadCount, recentOrders] =
      await Promise.all([
        prisma.notification.findMany({
          where: notificationWhere,
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
        }),

        prisma.notification.count({
          where: notificationWhere,
        }),

        prisma.notification.count({
          where: {
            userId: req.user.id,
            isRead: false,
          },
        }),

        prisma.order.findMany({
          where: {
            restaurantId: { in: restaurantIds },
            status: {
              in: [
                "PLACED",
                "ACCEPTED_BY_VENDOR",
                "PREPARING",
                "READY_FOR_PICKUP",
                "ASSIGNED_TO_RIDER",
              ],
            },
          },
          include: orderInclude,
          orderBy: { createdAt: "desc" },
          take: 10,
        }),
      ]);

    const orderActivity = recentOrders.map((order) => ({
      id: `order-${order.id}`,
      type: "ORDER",
      title:
        order.status === "PLACED"
          ? "New order received"
          : `Order ${order.status.replaceAll("_", " ").toLowerCase()}`,
      message: `Order from ${
        order.user?.fullName || "Customer"
      } • ₹${toNumber(order.totalAmount).toFixed(2)}`,
      orderId: order.id,
      order: cleanOrder(order),
      isRead: false,
      createdAt: order.createdAt,
      transient: true,
    }));

    return res.json({
      success: true,
      data: notifications,
      notifications,
      orderActivity,
      unreadCount,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Vendor Notifications Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch notifications",
      error: error.message,
    });
  }
};



/* =========================================================
   PRODUCTION VENDOR MODULES
========================================================= */

export const updateVendorProfile = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    if (
      !["OWNER", "MANAGER"].includes(
        access.memberRole
      )
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Only owner or manager can update restaurant profile",
      });
    }

    const {
      name,
      address,
      phone,
      email,
      ownerName,
      ownerMobileNo,
      type,
      categoryId,
      deliveryFee,
      minimumOrder,
      deliveryTime,
      defaultPrepTime,
      openingTime,
      closingTime,
      weeklyOffDay,
      isPureVeg,
      latitude,
      longitude,
      gstNumber,
      fssaiNumber,
      imageUrl,
      bannerUrl,
    } = req.body;

    if (categoryId) {
      const category =
        await prisma.category.findUnique({
          where: {
            id: categoryId,
          },
        });

      if (!category) {
        return res.status(404).json({
          success: false,
          message:
            "Business category not found",
        });
      }
    }

    if (
      latitude !== undefined &&
      !validLatitude(latitude)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid latitude",
      });
    }

    if (
      longitude !== undefined &&
      !validLongitude(longitude)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid longitude",
      });
    }

    const uploadedImage = await uploadFile(
      req,
      "vendor/profile"
    );

    const updateData = {
      ...(name !== undefined && {
        name: cleanOptional(name),
      }),
      ...(address !== undefined && {
        address: cleanOptional(address),
      }),
      ...(phone !== undefined && {
        phone: cleanOptional(phone),
      }),
      ...(email !== undefined && {
        email: normalizeEmail(email),
      }),
      ...(ownerName !== undefined && {
        ownerName: cleanOptional(ownerName),
      }),
      ...(ownerMobileNo !== undefined && {
        ownerMobileNo:
          cleanOptional(ownerMobileNo),
      }),
      ...(type !== undefined && {
        type: cleanOptional(type),
      }),
      ...(categoryId !== undefined && {
        categoryId: categoryId || null,
      }),
      ...(deliveryFee !== undefined && {
        deliveryFee:
          Number(deliveryFee || 0),
      }),
      ...(minimumOrder !== undefined && {
        minimumOrder:
          Number(minimumOrder || 0),
      }),
      ...(deliveryTime !== undefined && {
        deliveryTime:
          cleanOptional(deliveryTime),
      }),
      ...(defaultPrepTime !== undefined && {
        defaultPrepTime: Math.max(
          1,
          safeInt(defaultPrepTime, 30)
        ),
      }),
      ...(openingTime !== undefined && {
        openingTime:
          cleanOptional(openingTime) || null,
      }),
      ...(closingTime !== undefined && {
        closingTime:
          cleanOptional(closingTime) || null,
      }),
      ...(weeklyOffDay !== undefined && {
        weeklyOffDay:
          cleanOptional(weeklyOffDay) || null,
      }),
      ...(isPureVeg !== undefined && {
        isPureVeg: boolValue(isPureVeg),
      }),
      ...(latitude !== undefined && {
        latitude: Number(latitude),
      }),
      ...(longitude !== undefined && {
        longitude: Number(longitude),
      }),
      ...(gstNumber !== undefined && {
        gstNumber:
          cleanOptional(gstNumber) || null,
      }),
      ...(fssaiNumber !== undefined && {
        fssaiNumber:
          cleanOptional(fssaiNumber) || null,
      }),
      ...(uploadedImage && {
        imageUrl: uploadedImage,
      }),
      ...(!uploadedImage &&
        imageUrl !== undefined && {
          imageUrl: imageUrl || null,
        }),
      ...(bannerUrl !== undefined && {
        bannerUrl: bannerUrl || null,
      }),
    };

    const restaurant =
      await prisma.restaurant.update({
        where: {
          id: access.restaurant.id,
        },
        data: updateData,
        include: {
          city: true,
          category: true,
          payoutAccount: true,
        },
      });

    return res.json({
      success: true,
      message:
        "Vendor profile updated successfully",
      vendor: restaurant,
    });
  } catch (error) {
    console.error(
      "Update Vendor Profile Error:",
      error
    );

    return res.status(
      error?.code === "P2002" ? 409 : 500
    ).json({
      success: false,
      message:
        error?.code === "P2002"
          ? "Email or phone is already in use"
          : "Failed to update vendor profile",
    });
  }
};

export const toggleVendorAcceptingOrders = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const {
      isOpen,
      isAcceptingOrders,
    } = req.body;

    const updateData = {};

    if (isOpen !== undefined) {
      updateData.isOpen =
        boolValue(isOpen);
    }

    if (isAcceptingOrders !== undefined) {
      updateData.isAcceptingOrders =
        boolValue(isAcceptingOrders);
    }

    if (!Object.keys(updateData).length) {
      return res.status(400).json({
        success: false,
        message:
          "isOpen or isAcceptingOrders is required",
      });
    }

    const vendor =
      await prisma.restaurant.update({
        where: {
          id: access.restaurant.id,
        },
        data: updateData,
      });

    getIO()?.emit(
      "vendor-availability-changed",
      {
        restaurantId: vendor.id,
        isOpen: vendor.isOpen,
        isAcceptingOrders:
          vendor.isAcceptingOrders,
      }
    );

    return res.json({
      success: true,
      message:
        vendor.isOpen &&
        vendor.isAcceptingOrders
          ? "Restaurant is accepting orders"
          : "Restaurant availability updated",
      vendor,
    });
  } catch (error) {
    console.error(
      "Vendor Availability Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update restaurant availability",
    });
  }
};

export const setVendorBusyUntil = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const busyUntil =
      req.body?.busyUntil === null ||
      req.body?.busyUntil === ""
        ? null
        : safeDate(req.body?.busyUntil);

    if (
      req.body?.busyUntil &&
      !busyUntil
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid busyUntil date",
      });
    }

    const vendor =
      await prisma.restaurant.update({
        where: {
          id: access.restaurant.id,
        },
        data: {
          busyUntil,
        },
      });

    return res.json({
      success: true,
      message: busyUntil
        ? "Restaurant marked busy"
        : "Busy status cleared",
      busyUntil: vendor.busyUntil,
    });
  } catch (error) {
    console.error(
      "Set Vendor Busy Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update busy status",
    });
  }
};

/* =========================
   VENDOR TIMINGS
========================= */

export const getVendorTimings = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const [timings, exceptions] =
      await Promise.all([
        prisma.restaurantTiming.findMany({
          where: {
            restaurantId:
              access.restaurant.id,
          },
          orderBy: {
            dayOfWeek: "asc",
          },
        }),

        prisma.vendorOperatingException.findMany({
          where: {
            restaurantId:
              access.restaurant.id,
            date: {
              gte: new Date(
                new Date().setHours(
                  0,
                  0,
                  0,
                  0
                )
              ),
            },
          },
          orderBy: {
            date: "asc",
          },
          take: 90,
        }),
      ]);

    return res.json({
      success: true,
      timings,
      exceptions,
    });
  } catch (error) {
    console.error(
      "Get Vendor Timings Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch operating hours",
    });
  }
};

export const updateVendorTimings = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const timings = Array.isArray(
      req.body?.timings
    )
      ? req.body.timings
      : [];

    if (!timings.length) {
      return res.status(400).json({
        success: false,
        message:
          "timings array is required",
      });
    }

    for (const timing of timings) {
      const day = safeInt(
        timing.dayOfWeek,
        -1
      );

      if (day < 0 || day > 6) {
        return res.status(400).json({
          success: false,
          message:
            "dayOfWeek must be between 0 and 6",
        });
      }

      if (
        !boolValue(
          timing.isClosed,
          false
        ) &&
        (!timing.openTime ||
          !timing.closeTime)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "openTime and closeTime are required for open days",
        });
      }
    }

    const result =
      await prisma.$transaction(
        async (tx) => {
          const updated = [];

          for (const timing of timings) {
            const item =
              await tx.restaurantTiming.upsert({
                where: {
                  restaurantId_dayOfWeek: {
                    restaurantId:
                      access.restaurant.id,
                    dayOfWeek:
                      safeInt(
                        timing.dayOfWeek
                      ),
                  },
                },
                update: {
                  openTime:
                    cleanOptional(
                      timing.openTime
                    ) || "00:00",
                  closeTime:
                    cleanOptional(
                      timing.closeTime
                    ) || "00:00",
                  isClosed:
                    boolValue(
                      timing.isClosed,
                      false
                    ),
                },
                create: {
                  restaurantId:
                    access.restaurant.id,
                  dayOfWeek:
                    safeInt(
                      timing.dayOfWeek
                    ),
                  openTime:
                    cleanOptional(
                      timing.openTime
                    ) || "00:00",
                  closeTime:
                    cleanOptional(
                      timing.closeTime
                    ) || "00:00",
                  isClosed:
                    boolValue(
                      timing.isClosed,
                      false
                    ),
                },
              });

            updated.push(item);
          }

          return updated;
        }
      );

    return res.json({
      success: true,
      message:
        "Operating hours updated",
      timings: result,
    });
  } catch (error) {
    console.error(
      "Update Vendor Timings Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update operating hours",
    });
  }
};

export const upsertVendorOperatingException = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const date = safeDate(
      req.body?.date
    );

    if (!date) {
      return res.status(400).json({
        success: false,
        message: "Valid date is required",
      });
    }

    date.setHours(0, 0, 0, 0);

    const isClosed = boolValue(
      req.body?.isClosed,
      true
    );

    if (
      !isClosed &&
      (!req.body?.openTime ||
        !req.body?.closeTime)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "openTime and closeTime are required when restaurant is open",
      });
    }

    const exception =
      await prisma.vendorOperatingException.upsert({
        where: {
          restaurantId_date: {
            restaurantId:
              access.restaurant.id,
            date,
          },
        },
        update: {
          isClosed,
          openTime:
            cleanOptional(
              req.body?.openTime
            ) || null,
          closeTime:
            cleanOptional(
              req.body?.closeTime
            ) || null,
          reason:
            cleanOptional(
              req.body?.reason
            ) || null,
        },
        create: {
          restaurantId:
            access.restaurant.id,
          date,
          isClosed,
          openTime:
            cleanOptional(
              req.body?.openTime
            ) || null,
          closeTime:
            cleanOptional(
              req.body?.closeTime
            ) || null,
          reason:
            cleanOptional(
              req.body?.reason
            ) || null,
        },
      });

    return res.json({
      success: true,
      message:
        "Special operating day saved",
      exception,
    });
  } catch (error) {
    console.error(
      "Vendor Operating Exception Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to save special operating day",
    });
  }
};

export const deleteVendorOperatingException = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const exception =
      await prisma.vendorOperatingException.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
      });

    if (!exception) {
      return res.status(404).json({
        success: false,
        message:
          "Operating exception not found",
      });
    }

    await prisma.vendorOperatingException.delete({
      where: {
        id: exception.id,
      },
    });

    return res.json({
      success: true,
      message:
        "Special operating day deleted",
    });
  } catch (error) {
    console.error(
      "Delete Operating Exception Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to delete operating exception",
    });
  }
};

/* =========================
   VENDOR KYC DOCUMENTS
========================= */

export const getVendorDocuments = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const documents =
      await prisma.vendorDocument.findMany({
        where: {
          restaurantId:
            access.restaurant.id,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

    return res.json({
      success: true,
      documents,
      verificationStatus:
        access.restaurant
          .verificationStatus,
    });
  } catch (error) {
    console.error(
      "Vendor Documents Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch vendor documents",
    });
  }
};

export const upsertVendorDocument = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const type = String(
      req.body?.type || ""
    ).toUpperCase();

    const allowedTypes = [
      "FSSAI",
      "GST",
      "PAN",
      "BANK_PROOF",
      "SHOP_LICENSE",
      "OWNER_ID",
      "OTHER",
    ];

    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid vendor document type",
      });
    }

    const uploadedUrl =
      await uploadFile(
        req,
        "vendor/documents"
      );

    const existing =
      await prisma.vendorDocument.findFirst({
        where: {
          restaurantId:
            access.restaurant.id,
          type,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

    const data = {
      type,
      documentNumber:
        cleanOptional(
          req.body?.documentNumber
        ) || null,
      documentUrl:
        uploadedUrl ||
        req.body?.documentUrl ||
        null,
      frontImageUrl:
        req.body?.frontImageUrl || null,
      backImageUrl:
        req.body?.backImageUrl || null,
      expiresAt: req.body?.expiresAt
        ? safeDate(req.body.expiresAt)
        : null,
      status: "PENDING",
      rejectionReason: null,
      reviewedById: null,
      reviewedAt: null,
    };

    const document = existing
      ? await prisma.vendorDocument.update({
          where: {
            id: existing.id,
          },
          data,
        })
      : await prisma.vendorDocument.create({
          data: {
            restaurantId:
              access.restaurant.id,
            ...data,
          },
        });

    await prisma.restaurant.update({
      where: {
        id: access.restaurant.id,
      },
      data: {
        verificationStatus:
          "PENDING",
        isVerified: false,
        verifiedAt: null,
        verificationNote: null,
      },
    });

    return res
      .status(existing ? 200 : 201)
      .json({
        success: true,
        message:
          "Document submitted for review",
        document,
      });
  } catch (error) {
    console.error(
      "Submit Vendor Document Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to submit vendor document",
    });
  }
};

export const deletePendingVendorDocument = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const document =
      await prisma.vendorDocument.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
      });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: "Document not found",
      });
    }

    if (
      !["PENDING", "REJECTED"].includes(
        document.status
      )
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Approved/under-review document cannot be deleted",
      });
    }

    await prisma.vendorDocument.delete({
      where: {
        id: document.id,
      },
    });

    return res.json({
      success: true,
      message: "Document deleted",
    });
  } catch (error) {
    console.error(
      "Delete Vendor Document Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to delete vendor document",
    });
  }
};

/* =========================
   VENDOR PAYOUT ACCOUNT
========================= */

export const updateVendorPayoutDetails = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    if (!access.isOwner) {
      return res.status(403).json({
        success: false,
        message:
          "Only restaurant owner can change payout details",
      });
    }

    const accountNumber =
      cleanOptional(
        req.body?.accountNumber
      );

    const account =
      await prisma.vendorPayoutAccount.upsert({
        where: {
          restaurantId:
            access.restaurant.id,
        },
        update: {
          ...(req.body
            ?.accountHolder !==
            undefined && {
            accountHolder:
              cleanOptional(
                req.body.accountHolder
              ) || null,
          }),
          ...(accountNumber !==
            undefined && {
            accountNumberEncrypted:
              accountNumber || null,
            accountLast4:
              accountNumber
                ? accountNumber.slice(
                    -4
                  )
                : null,
          }),
          ...(req.body?.bankName !==
            undefined && {
            bankName:
              cleanOptional(
                req.body.bankName
              ) || null,
          }),
          ...(req.body?.ifscCode !==
            undefined && {
            ifscCode:
              cleanOptional(
                req.body.ifscCode
              )?.toUpperCase() ||
              null,
          }),
          ...(req.body?.upiId !==
            undefined && {
            upiId:
              cleanOptional(
                req.body.upiId
              ) || null,
          }),
          isVerified: false,
          verifiedAt: null,
        },
        create: {
          restaurantId:
            access.restaurant.id,
          accountHolder:
            cleanOptional(
              req.body?.accountHolder
            ) || null,
          accountNumberEncrypted:
            accountNumber || null,
          accountLast4:
            accountNumber
              ? accountNumber.slice(-4)
              : null,
          bankName:
            cleanOptional(
              req.body?.bankName
            ) || null,
          ifscCode:
            cleanOptional(
              req.body?.ifscCode
            )?.toUpperCase() || null,
          upiId:
            cleanOptional(
              req.body?.upiId
            ) || null,
          isVerified: false,
        },
      });

    return res.json({
      success: true,
      message:
        "Payout account updated and sent for verification",
      payout: {
        accountHolder:
          account.accountHolder,
        accountLast4:
          account.accountLast4,
        bankName: account.bankName,
        ifscCode: account.ifscCode,
        upiId: account.upiId,
        isVerified:
          account.isVerified,
        verifiedAt:
          account.verifiedAt,
      },
    });
  } catch (error) {
    console.error(
      "Update Vendor Payout Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update payout details",
    });
  }
};

/* =========================
   VENDOR STAFF
========================= */

export const getVendorStaff = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const members =
      await prisma.restaurantMember.findMany({
        where: {
          restaurantId:
            access.restaurant.id,
        },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true,
              avatarUrl: true,
              isActive: true,
              lastSeen: true,
            },
          },
        },
        orderBy: [
          {
            isActive: "desc",
          },
          {
            createdAt: "asc",
          },
        ],
      });

    return res.json({
      success: true,
      members,
    });
  } catch (error) {
    console.error(
      "Vendor Staff Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch vendor staff",
    });
  }
};

export const addVendorStaff = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    if (
      !["OWNER", "MANAGER"].includes(
        access.memberRole
      )
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Only owner or manager can add staff",
      });
    }

    const {
      fullName,
      email,
      phone,
      password,
      role = "STAFF",
      permissions,
    } = req.body;

    if (
      !trimValue(fullName) ||
      !normalizeEmail(email) ||
      !trimValue(password)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "fullName, email and password are required",
      });
    }

    const finalRole = String(
      role
    ).toUpperCase();

    if (
      ![
        "OWNER",
        "MANAGER",
        "STAFF",
        "ACCOUNTANT",
      ].includes(finalRole)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid restaurant member role",
      });
    }

    if (
      finalRole === "OWNER" &&
      !access.isOwner
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Only owner can add another owner",
      });
    }

    const finalEmail =
      normalizeEmail(email);
    const finalPhone =
      cleanOptional(phone);

    const duplicate =
      await prisma.user.findFirst({
        where: {
          OR: [
            {
              email: finalEmail,
            },
            ...(finalPhone
              ? [
                  {
                    phone: finalPhone,
                  },
                ]
              : []),
          ],
        },
      });

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message:
          "Email or phone already belongs to another account",
      });
    }

    const hashedPassword =
      await bcrypt.hash(
        trimValue(password),
        10
      );

    const result =
      await prisma.$transaction(
        async (tx) => {
          const user =
            await tx.user.create({
              data: {
                fullName:
                  trimValue(fullName),
                email: finalEmail,
                phone:
                  finalPhone || null,
                password:
                  hashedPassword,
                role: "VENDOR",
                isActive: true,
                cityId:
                  access.restaurant
                    .cityId,
              },
            });

          const member =
            await tx.restaurantMember.create({
              data: {
                restaurantId:
                  access.restaurant.id,
                userId: user.id,
                role: finalRole,
                permissions:
                  permissions ?? null,
                joinedAt: new Date(),
                isActive: true,
              },
              include: {
                user: true,
              },
            });

          return {
            user,
            member,
          };
        }
      );

    return res.status(201).json({
      success: true,
      message:
        "Vendor staff member created",
      member: result.member,
    });
  } catch (error) {
    console.error(
      "Add Vendor Staff Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to add vendor staff",
    });
  }
};

export const updateVendorStaff = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    if (
      !["OWNER", "MANAGER"].includes(
        access.memberRole
      )
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Only owner or manager can update staff",
      });
    }

    const member =
      await prisma.restaurantMember.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
        include: {
          user: true,
        },
      });

    if (!member) {
      return res.status(404).json({
        success: false,
        message:
          "Staff member not found",
      });
    }

    if (
      member.role === "OWNER" &&
      !access.isOwner
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Only owner can modify owner access",
      });
    }

    const role =
      req.body?.role !== undefined
        ? String(
            req.body.role
          ).toUpperCase()
        : undefined;

    if (
      role !== undefined &&
      ![
        "OWNER",
        "MANAGER",
        "STAFF",
        "ACCOUNTANT",
      ].includes(role)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid restaurant member role",
      });
    }

    const result =
      await prisma.$transaction(
        async (tx) => {
          if (
            req.body?.fullName !==
              undefined ||
            req.body?.phone !==
              undefined ||
            req.body?.isActive !==
              undefined
          ) {
            await tx.user.update({
              where: {
                id: member.userId,
              },
              data: {
                ...(req.body
                  ?.fullName !==
                  undefined && {
                  fullName:
                    cleanOptional(
                      req.body.fullName
                    ),
                }),
                ...(req.body?.phone !==
                  undefined && {
                  phone:
                    cleanOptional(
                      req.body.phone
                    ) || null,
                }),
                ...(req.body?.isActive !==
                  undefined && {
                  isActive:
                    boolValue(
                      req.body.isActive
                    ),
                }),
              },
            });
          }

          return tx.restaurantMember.update({
            where: {
              id: member.id,
            },
            data: {
              ...(role !==
                undefined && {
                role,
              }),
              ...(req.body
                ?.permissions !==
                undefined && {
                permissions:
                  req.body.permissions,
              }),
              ...(req.body?.isActive !==
                undefined && {
                isActive:
                  boolValue(
                    req.body.isActive
                  ),
              }),
            },
            include: {
              user: true,
            },
          });
        }
      );

    return res.json({
      success: true,
      message:
        "Vendor staff updated",
      member: result,
    });
  } catch (error) {
    console.error(
      "Update Vendor Staff Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update vendor staff",
    });
  }
};

export const removeVendorStaff = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    if (
      !["OWNER", "MANAGER"].includes(
        access.memberRole
      )
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Only owner or manager can remove staff",
      });
    }

    const member =
      await prisma.restaurantMember.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
      });

    if (!member) {
      return res.status(404).json({
        success: false,
        message:
          "Staff member not found",
      });
    }

    if (member.role === "OWNER") {
      return res.status(409).json({
        success: false,
        message:
          "Restaurant owner cannot be removed",
      });
    }

    await prisma.$transaction(
      async (tx) => {
        await tx.restaurantMember.update({
          where: {
            id: member.id,
          },
          data: {
            isActive: false,
          },
        });

        await tx.user.update({
          where: {
            id: member.userId,
          },
          data: {
            isActive: false,
          },
        });
      }
    );

    return res.json({
      success: true,
      message:
        "Vendor staff access removed",
    });
  } catch (error) {
    console.error(
      "Remove Vendor Staff Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to remove vendor staff",
    });
  }
};

/* =========================
   VENDOR ORDERS
========================= */

export const getVendorOrderById = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const order =
      await prisma.order.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
        include:
          vendorOrderInclude,
      });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    return res.json({
      success: true,
      order: cleanOrder(order),
      financials:
        getOrderFinancials({
          ...order,
          restaurant:
            access.restaurant,
        }),
    });
  } catch (error) {
    console.error(
      "Get Vendor Order Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch order",
    });
  }
};

export const acceptOrderByVendor = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const restaurant =
      access.restaurant;

    if (
      !restaurant.isOpen ||
      !restaurant.isAcceptingOrders
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Restaurant is not accepting orders",
      });
    }

    const prepMinutes = Math.max(
      1,
      safeInt(
        req.body
          ?.estimatedPreparationMinutes,
        restaurant.defaultPrepTime ||
          30
      )
    );

    const result =
      await prisma.$transaction(
        async (tx) => {
          const order =
            await tx.order.findFirst({
              where: {
                id: req.params.id,
                restaurantId:
                  restaurant.id,
                status: "PLACED",
              },
              include: {
                restaurant: true,
              },
            });

          if (!order) {
            const error =
              new Error(
                "Order is not available for acceptance"
              );

            error.statusCode = 409;
            throw error;
          }

          const snapshot =
            await ensureOrderSnapshot(
              tx,
              order
            );

          return tx.order.update({
            where: {
              id: order.id,
            },
            data: {
              vendorId:
                restaurant.vendorId ||
                order.vendorId,
              status:
                "ACCEPTED_BY_VENDOR",
              acceptedAt:
                new Date(),
              estimatedPreparationMinutes:
                prepMinutes,
              history: {
                create: {
                  status:
                    "ACCEPTED_BY_VENDOR",
                  changedBy:
                    req.user.id,
                  note:
                    "Order accepted by vendor",
                },
              },
            },
            include:
              vendorOrderInclude,
          });
        }
      );

    const finalOrder =
      cleanOrder(result);

    emitVendorOrder(
      restaurant.id,
      result.id,
      "vendor-order-accepted",
      finalOrder
    );

    getIO()
      ?.to(
        `user-${result.userId}`
      )
      .emit(
        "order-updated",
        finalOrder
      );

    return res.json({
      success: true,
      message: "Order accepted",
      order: finalOrder,
    });
  } catch (error) {
    console.error(
      "Vendor Accept Order Error:",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        success: false,
        message:
          error.message ||
          "Failed to accept order",
      });
  }
};

export const rejectOrderByVendor = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const reason =
      cleanOptional(
        req.body?.reason
      ) ||
      "Rejected by restaurant";

    const result =
      await prisma.$transaction(
        async (tx) => {
          const order =
            await tx.order.findFirst({
              where: {
                id: req.params.id,
                restaurantId:
                  access.restaurant.id,
                status: {
                  in: [
                    "PLACED",
                    "ACCEPTED_BY_VENDOR",
                    "PREPARING",
                  ],
                },
              },
              include: {
                paymentTransactions: {
                  where: {
                    status: "SUCCESS",
                  },
                  orderBy: {
                    createdAt: "desc",
                  },
                  take: 1,
                },
              },
            });

          if (!order) {
            const error =
              new Error(
                "Order cannot be rejected in its current state"
              );

            error.statusCode = 409;
            throw error;
          }

          const cancelled =
            await tx.order.update({
              where: {
                id: order.id,
              },
              data: {
                status: "CANCELLED",
                cancelledAt:
                  new Date(),
                cancelledBy:
                  req.user.id,
                cancelReason: reason,
                history: {
                  create: {
                    status:
                      "CANCELLED",
                    changedBy:
                      req.user.id,
                    note: reason,
                  },
                },
              },
              include:
                vendorOrderInclude,
            });

          if (
            isPrepaidMethod(
              order.paymentMethod
            ) &&
            order.paymentStatus ===
              "PAID"
          ) {
            const existingRefund =
              await tx.refund.findFirst({
                where: {
                  orderId:
                    order.id,
                  status: {
                    in: [
                      "PENDING",
                      "PROCESSING",
                      "COMPLETED",
                    ],
                  },
                },
              });

            if (!existingRefund) {
              await tx.refund.create({
                data: {
                  orderId:
                    order.id,
                  paymentTransactionId:
                    order
                      .paymentTransactions?.[0]
                      ?.id || null,
                  amount:
                    roundMoney(
                      order.totalAmount
                    ),
                  reason,
                  status:
                    "PENDING",
                },
              });
            }
          }

          return cancelled;
        }
      );

    const finalOrder =
      cleanOrder(result);

    emitVendorOrder(
      access.restaurant.id,
      result.id,
      "vendor-order-cancelled",
      finalOrder
    );

    getIO()
      ?.to(
        `user-${result.userId}`
      )
      .emit(
        "order-updated",
        finalOrder
      );

    return res.json({
      success: true,
      message:
        isPrepaidMethod(
          result.paymentMethod
        ) &&
        result.paymentStatus ===
          "PAID"
          ? "Order cancelled. Refund has been requested."
          : "Order cancelled",
      order: finalOrder,
    });
  } catch (error) {
    console.error(
      "Vendor Reject Order Error:",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        success: false,
        message:
          error.message ||
          "Failed to reject order",
      });
  }
};

export const markOrderPreparingByVendor = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const order =
      await prisma.order.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
          status:
            "ACCEPTED_BY_VENDOR",
        },
      });

    if (!order) {
      return res.status(409).json({
        success: false,
        message:
          "Order must be accepted before preparation",
      });
    }

    const updated =
      await prisma.order.update({
        where: {
          id: order.id,
        },
        data: {
          status: "PREPARING",
          preparingAt:
            new Date(),
          history: {
            create: {
              status:
                "PREPARING",
              changedBy:
                req.user.id,
              note:
                "Restaurant started preparing order",
            },
          },
        },
        include:
          vendorOrderInclude,
      });

    const finalOrder =
      cleanOrder(updated);

    emitVendorOrder(
      access.restaurant.id,
      updated.id,
      "vendor-order-preparing",
      finalOrder
    );

    return res.json({
      success: true,
      message:
        "Order preparation started",
      order: finalOrder,
    });
  } catch (error) {
    console.error(
      "Vendor Preparing Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to start preparation",
    });
  }
};

export const markOrderReadyByVendor = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const order =
      await prisma.order.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
          status: {
            in: [
              "ACCEPTED_BY_VENDOR",
              "PREPARING",
            ],
          },
        },
      });

    if (!order) {
      return res.status(409).json({
        success: false,
        message:
          "Order is not in a valid state to mark ready",
      });
    }

    const updated =
      await prisma.order.update({
        where: {
          id: order.id,
        },
        data: {
          status:
            "READY_FOR_PICKUP",
          readyAt: new Date(),
          history: {
            create: {
              status:
                "READY_FOR_PICKUP",
              changedBy:
                req.user.id,
              note:
                "Order ready for rider pickup",
            },
          },
        },
        include:
          vendorOrderInclude,
      });

    const finalOrder =
      cleanOrder(updated);

    emitVendorOrder(
      access.restaurant.id,
      updated.id,
      "vendor-order-ready",
      finalOrder
    );

    getIO()?.emit(
      "new-rider-order",
      finalOrder
    );

    return res.json({
      success: true,
      message:
        "Order is ready for pickup",
      order: finalOrder,
    });
  } catch (error) {
    console.error(
      "Vendor Ready Order Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to mark order ready",
    });
  }
};

/* =========================
   VENDOR MENU
========================= */

export const getVendorFinancialSummary = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const type = String(
      req.query?.type || "monthly"
    ).toLowerCase();

    const { start, end } =
      getFinanceDateRange({
        from: req.query?.from,
        to: req.query?.to,
        type,
      });

    const orders =
      await prisma.order.findMany({
        where: {
          restaurantId:
            access.restaurant.id,
          createdAt: {
            gte: start,
            lte: end,
          },
        },
        include: {
          restaurant: true,
          refunds: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

    const summary = {
      totalOrders: orders.length,
      deliveredOrders: 0,
      cancelledOrders: 0,
      activeOrders: 0,
      paidOrders: 0,
      codOrders: 0,
      prepaidOrders: 0,
      recognizedRevenue: 0,
      commissionableAmount: 0,
      platformCommission: 0,
      vendorPayable: 0,
      refundPending: 0,
      refundedAmount: 0,
      legacySnapshotOrders: 0,
    };

    for (const order of orders) {
      if (order.status === "DELIVERED") {
        summary.deliveredOrders += 1;
      } else if (
        order.status === "CANCELLED"
      ) {
        summary.cancelledOrders += 1;
      } else {
        summary.activeOrders += 1;
      }

      if (
        order.paymentStatus === "PAID"
      ) {
        summary.paidOrders += 1;
      }

      if (
        order.paymentMethod === "COD"
      ) {
        summary.codOrders += 1;
      } else {
        summary.prepaidOrders += 1;
      }

      if (isRecognizedOrder(order)) {
        const finance =
          getOrderFinancials(order);

        summary.recognizedRevenue +=
          finance.totalAmount;

        summary.commissionableAmount +=
          finance.commissionableAmount;

        summary.platformCommission +=
          finance.platformCommission;

        summary.vendorPayable +=
          finance.vendorPayable;

        if (
          finance
            .legacyCommissionFallback
        ) {
          summary.legacySnapshotOrders +=
            1;
        }
      }

      for (const refund of
        order.refunds || []) {
        if (
          ["PENDING", "PROCESSING"].includes(
            refund.status
          )
        ) {
          summary.refundPending +=
            toNumber(refund.amount);
        }

        if (
          refund.status ===
          "COMPLETED"
        ) {
          summary.refundedAmount +=
            toNumber(refund.amount);
        }
      }
    }

    Object.keys(summary).forEach(
      (key) => {
        if (
          [
            "recognizedRevenue",
            "commissionableAmount",
            "platformCommission",
            "vendorPayable",
            "refundPending",
            "refundedAmount",
          ].includes(key)
        ) {
          summary[key] =
            roundMoney(
              summary[key]
            );
        }
      }
    );

    return res.json({
      success: true,
      period: {
        type,
        start,
        end,
      },
      summary,
      orders:
        orders.map((order) => ({
          ...cleanOrder(order),
          financials:
            getOrderFinancials(
              order
            ),
        })),
    });
  } catch (error) {
    console.error(
      "Vendor Financial Summary Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch vendor finance summary",
    });
  }
};

export const getVendorSettlements = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const { page, limit, skip } =
      pageParams(req, 25, 100);

    const status = String(
      req.query?.status || ""
    ).toUpperCase();

    const where = {
      restaurantId:
        access.restaurant.id,
      ...(status &&
      status !== "ALL"
        ? {
            status,
          }
        : {}),
    };

    const [settlements, total] =
      await Promise.all([
        prisma.vendorSettlement.findMany({
          where,
          include: {
            order: {
              select: {
                id: true,
                orderNumber: true,
                deliveredAt: true,
                paymentMethod: true,
                paymentStatus: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          skip,
          take: limit,
        }),

        prisma.vendorSettlement.count({
          where,
        }),
      ]);

    return res.json({
      success: true,
      settlements:
        settlements.map((item) => ({
          ...item,
          grossAmount:
            roundMoney(
              item.grossAmount
            ),
          commissionRate:
            item.commissionRate ===
              null
              ? null
              : roundMoney(
                  item.commissionRate
                ),
          commissionAmount:
            roundMoney(
              item.commissionAmount
            ),
          netAmount:
            roundMoney(
              item.netAmount
            ),
        })),
      pagination: {
        page,
        limit,
        total,
        totalPages:
          Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error(
      "Vendor Settlements Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch settlements",
    });
  }
};

export const getVendorInvoices = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const { page, limit, skip } =
      pageParams(req, 20, 100);

    const status = String(
      req.query?.status || ""
    ).toUpperCase();

    const where = {
      restaurantId:
        access.restaurant.id,
      ...(status &&
      status !== "ALL"
        ? {
            status,
          }
        : {}),
    };

    const [invoices, total] =
      await Promise.all([
        prisma.vendorInvoice.findMany({
          where,
          include: {
            _count: {
              select: {
                items: true,
              },
            },
          },
          orderBy: {
            generatedAt: "desc",
          },
          skip,
          take: limit,
        }),

        prisma.vendorInvoice.count({
          where,
        }),
      ]);

    return res.json({
      success: true,
      invoices:
        invoices.map((invoice) => ({
          ...invoice,
          grossAmount:
            roundMoney(
              invoice.grossAmount
            ),
          commissionAmount:
            roundMoney(
              invoice.commissionAmount
            ),
          taxAmount:
            roundMoney(
              invoice.taxAmount
            ),
          adjustmentAmount:
            roundMoney(
              invoice.adjustmentAmount
            ),
          netPayable:
            roundMoney(
              invoice.netPayable
            ),
        })),
      pagination: {
        page,
        limit,
        total,
        totalPages:
          Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error(
      "Vendor Invoices Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch invoices",
    });
  }
};

export const getVendorInvoiceById = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const invoice =
      await prisma.vendorInvoice.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
        include: {
          items: {
            include: {
              order: {
                select: {
                  id: true,
                  orderNumber: true,
                  status: true,
                  paymentMethod: true,
                  paymentStatus: true,
                  deliveredAt: true,
                },
              },
            },
            orderBy: {
              deliveredAt: "asc",
            },
          },
          restaurant: true,
        },
      });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message:
          "Invoice not found",
      });
    }

    return res.json({
      success: true,
      invoice,
    });
  } catch (error) {
    console.error(
      "Vendor Invoice Detail Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch invoice",
    });
  }
};

export const downloadVendorInvoicePdf = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const invoice =
      await prisma.vendorInvoice.findFirst({
        where: {
          id: req.params.id,
          restaurantId:
            access.restaurant.id,
        },
        include: {
          restaurant: true,
          items: {
            orderBy: {
              deliveredAt: "asc",
            },
          },
        },
      });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message:
          "Invoice not found",
      });
    }

    const doc =
      setupPdfResponse(
        res,
        `${invoice.invoiceNumber}.pdf`,
        "Vendor Settlement Invoice"
      );

    pdfKeyValue(
      doc,
      "Invoice",
      invoice.invoiceNumber
    );

    pdfKeyValue(
      doc,
      "Restaurant",
      invoice.restaurant.name
    );

    pdfKeyValue(
      doc,
      "Period",
      `${new Date(
        invoice.periodStart
      ).toLocaleDateString(
        "en-IN"
      )} - ${new Date(
        invoice.periodEnd
      ).toLocaleDateString(
        "en-IN"
      )}`
    );

    pdfKeyValue(
      doc,
      "Status",
      invoice.status
    );

    pdfKeyValue(
      doc,
      "Orders",
      invoice.totalOrders
    );

    pdfKeyValue(
      doc,
      "Gross",
      formatPdfMoney(
        invoice.grossAmount
      )
    );

    pdfKeyValue(
      doc,
      "Commission",
      formatPdfMoney(
        invoice.commissionAmount
      )
    );

    pdfKeyValue(
      doc,
      "Adjustment",
      formatPdfMoney(
        invoice.adjustmentAmount
      )
    );

    pdfKeyValue(
      doc,
      "Net Payable",
      formatPdfMoney(
        invoice.netPayable
      )
    );

    doc.moveDown();

    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Order Breakdown");

    doc.moveDown(0.5);

    for (const item of invoice.items) {
      doc
        .font("Helvetica")
        .fontSize(8)
        .text(
          `${item.orderNumber} | ${item.paymentMethod}/${item.paymentStatus} | Gross ${formatPdfMoney(
            item.grossAmount
          )} | Commission ${roundMoney(
            item.commissionRate
          )}% = ${formatPdfMoney(
            item.commissionAmount
          )} | Vendor ${formatPdfMoney(
            item.vendorPayable
          )}`
        );

      doc.moveDown(0.25);
    }

    doc.end();
  } catch (error) {
    console.error(
      "Vendor Invoice PDF Error:",
      error
    );

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message:
          "Failed to download invoice",
      });
    }
  }
};

export const getVendorRefunds = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const { page, limit, skip } =
      pageParams(req, 20, 100);

    const status = String(
      req.query?.status || ""
    ).toUpperCase();

    const where = {
      order: {
        restaurantId:
          access.restaurant.id,
      },
      ...(status &&
      status !== "ALL"
        ? {
            status,
          }
        : {}),
    };

    const [refunds, total] =
      await Promise.all([
        prisma.refund.findMany({
          where,
          include: {
            order: {
              select: {
                id: true,
                orderNumber: true,
                totalAmount: true,
                paymentMethod: true,
                paymentStatus: true,
                status: true,
                cancelledAt: true,
                cancelReason: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          skip,
          take: limit,
        }),

        prisma.refund.count({
          where,
        }),
      ]);

    return res.json({
      success: true,
      refunds:
        refunds.map((refund) => ({
          ...refund,
          amount:
            roundMoney(
              refund.amount
            ),
        })),
      pagination: {
        page,
        limit,
        total,
        totalPages:
          Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error(
      "Vendor Refunds Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch refunds",
    });
  }
};

/* =========================
   RATINGS
========================= */

export const getVendorRatings = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const { page, limit, skip } =
      pageParams(req, 20, 100);

    const [ratings, total] =
      await Promise.all([
        prisma.restaurantRating.findMany({
          where: {
            restaurantId:
              access.restaurant.id,
            isActive: true,
          },
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                avatarUrl: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          skip,
          take: limit,
        }),

        prisma.restaurantRating.count({
          where: {
            restaurantId:
              access.restaurant.id,
            isActive: true,
          },
        }),
      ]);

    const aggregate =
      await prisma.restaurantRating.aggregate({
        where: {
          restaurantId:
            access.restaurant.id,
          isActive: true,
        },
        _avg: {
          rating: true,
        },
      });

    return res.json({
      success: true,
      summary: {
        rating: roundMoney(
          aggregate._avg.rating
        ),
        totalRatings: total,
      },
      ratings,
      pagination: {
        page,
        limit,
        total,
        totalPages:
          Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error(
      "Vendor Ratings Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch ratings",
    });
  }
};

/* =========================
   VENDOR NOTIFICATIONS
========================= */

export const markVendorNotificationRead = async (
  req,
  res
) => {
  try {
    const notification =
      await prisma.notification.findFirst({
        where: {
          id: req.params.id,
          OR: [
            {
              userId:
                req.user.id,
            },
            {
              userId: null,
            },
          ],
        },
      });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message:
          "Notification not found",
      });
    }

    const updated =
      notification.userId === null
        ? notification
        : await prisma.notification.update({
            where: {
              id: notification.id,
            },
            data: {
              isRead: true,
              readAt: new Date(),
            },
          });

    return res.json({
      success: true,
      notification: updated,
    });
  } catch (error) {
    console.error(
      "Vendor Notification Read Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update notification",
    });
  }
};

export const markAllVendorNotificationsRead = async (
  req,
  res
) => {
  try {
    const result =
      await prisma.notification.updateMany({
        where: {
          userId: req.user.id,
          isRead: false,
        },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });

    return res.json({
      success: true,
      updatedCount:
        result.count,
    });
  } catch (error) {
    console.error(
      "Vendor Notifications Read All Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update notifications",
    });
  }
};

/* =========================
   VENDOR SUPPORT
========================= */

export const createVendorSupportTicket = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const subject =
      cleanOptional(
        req.body?.subject
      );

    const message =
      cleanOptional(
        req.body?.message
      );

    const orderId =
      cleanOptional(
        req.body?.orderId
      );

    const priority = String(
      req.body?.priority || "MEDIUM"
    ).toUpperCase();

    if (!subject) {
      return res.status(400).json({
        success: false,
        message:
          "Subject is required",
      });
    }

    if (
      ![
        "LOW",
        "MEDIUM",
        "HIGH",
        "URGENT",
      ].includes(priority)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid support priority",
      });
    }

    if (orderId) {
      const order =
        await prisma.order.findFirst({
          where: {
            id: orderId,
            restaurantId:
              access.restaurant.id,
          },
          select: {
            id: true,
          },
        });

      if (!order) {
        return res.status(404).json({
          success: false,
          message:
            "Linked order not found",
        });
      }
    }

    const ticket =
      await prisma.supportTicket.create({
        data: {
          userId: req.user.id,
          subject,
          message:
            message || null,
          status: "OPEN",
          priority,
          orderId:
            orderId || null,
          tags: [
            "VENDOR",
            access.restaurant.id,
          ],
          lastReplyAt: message
            ? new Date()
            : null,
        },
      });

    return res.status(201).json({
      success: true,
      message:
        "Support ticket created",
      ticket,
    });
  } catch (error) {
    console.error(
      "Create Vendor Support Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to create support ticket",
    });
  }
};

export const getVendorSupportTickets = async (
  req,
  res
) => {
  try {
    const access = await requireVendorAccess(req, res);
    if (!access) return;

    const tickets =
      await prisma.supportTicket.findMany({
        where: {
          userId: req.user.id,
        },
        include: {
          messages: {
            orderBy: {
              createdAt: "asc",
            },
          },
          order: {
            select: {
              id: true,
              orderNumber: true,
              status: true,
            },
          },
        },
        orderBy: {
          updatedAt: "desc",
        },
      });

    return res.json({
      success: true,
      tickets,
    });
  } catch (error) {
    console.error(
      "Vendor Support Tickets Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch support tickets",
    });
  }
};

export const addVendorSupportMessage = async (
  req,
  res
) => {
  try {
    const ticket =
      await prisma.supportTicket.findFirst({
        where: {
          id: req.params.ticketId,
          userId: req.user.id,
        },
      });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message:
          "Support ticket not found",
      });
    }

    if (
      ticket.status === "CLOSED"
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Closed ticket cannot receive new messages",
      });
    }

    const uploadedImage =
      await uploadFile(
        req,
        "support/vendor"
      );

    const message =
      cleanOptional(
        req.body?.message
      );

    const imageUrl =
      uploadedImage ||
      req.body?.imageUrl ||
      null;

    if (!message && !imageUrl) {
      return res.status(400).json({
        success: false,
        message:
          "Message or image is required",
      });
    }

    const result =
      await prisma.$transaction(
        async (tx) => {
          const supportMessage =
            await tx.supportMessage.create({
              data: {
                ticketId:
                  ticket.id,
                senderId:
                  req.user.id,
                message:
                  message || "",
                imageUrl,
              },
            });

          const updatedTicket =
            await tx.supportTicket.update({
              where: {
                id: ticket.id,
              },
              data: {
                lastReplyAt:
                  new Date(),
                ...(ticket.status ===
                "RESOLVED"
                  ? {
                      status:
                        "OPEN",
                      resolvedAt:
                        null,
                    }
                  : {}),
              },
            });

          return {
            supportMessage,
            updatedTicket,
          };
        }
      );

    return res.json({
      success: true,
      message:
        "Support message sent",
      supportMessage:
        result.supportMessage,
      ticket:
        result.updatedTicket,
    });
  } catch (error) {
    console.error(
      "Vendor Support Message Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to send support message",
    });
  }
};

export default {
  getCategories,
  getVendors,
  getVendorById,
  getVendorDashboard,
  getVendorOrders,
  updateVendorOrderStatus,
  updatePreparationTime,
  getAvailableRidersForVendor,
  assignVendorOrderRider,
  getVendorMenu,
  createVendorMenuItem,
  updateVendorMenuItem,
  toggleVendorMenuItemAvailability,
  deleteVendorMenuItem,
  getVendorCategories,
  createVendorCategory,
  updateVendorCategory,
  deleteVendorCategory,
  getVendorProfile,
  updateVendorSettings,
  toggleVendorOpenClose,
  setVendorBusyMode,
  getVendorPayments,
  getVendorEarningsGraph,
  getVendorNotifications,
  updateVendorProfile,
  toggleVendorAcceptingOrders,
  setVendorBusyUntil,
  getVendorTimings,
  updateVendorTimings,
  upsertVendorOperatingException,
  deleteVendorOperatingException,
  getVendorDocuments,
  upsertVendorDocument,
  deletePendingVendorDocument,
  updateVendorPayoutDetails,
  getVendorStaff,
  addVendorStaff,
  updateVendorStaff,
  removeVendorStaff,
  getVendorOrderById,
  acceptOrderByVendor,
  rejectOrderByVendor,
  markOrderPreparingByVendor,
  markOrderReadyByVendor,
  getVendorFinancialSummary,
  getVendorSettlements,
  getVendorInvoices,
  getVendorInvoiceById,
  downloadVendorInvoicePdf,
  getVendorRefunds,
  getVendorRatings,
  markVendorNotificationRead,
  markAllVendorNotificationsRead,
  createVendorSupportTicket,
  getVendorSupportTickets,
  addVendorSupportMessage,
};
