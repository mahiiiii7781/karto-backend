// src/controllers/vendor.controllers.js

import prisma from "../prisma.js";
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

const FINAL_REVENUE_STATUSES = ["DELIVERED", "COMPLETED"];

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

const getVendorRestaurantIds = async (vendorId) => {
  const restaurants = await prisma.restaurant.findMany({
    where: { vendorId },
    select: { id: true },
  });

  return restaurants.map((r) => r.id);
};

const getPrimaryRestaurant = async (vendorId) => {
  return prisma.restaurant.findFirst({
    where: { vendorId },
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

    const restaurants = await prisma.restaurant.findMany({
      where: { vendorId },
      include: {
        orders: true,
        menuItems: true,
        timings: true,
      },
    });

    const restaurantIds = restaurants.map((r) => r.id);

    const todayOrders = await prisma.order.findMany({
      where: {
        restaurantId: { in: restaurantIds },
        createdAt: { gte: todayStart },
      },
    });

    const monthlyOrders = await prisma.order.findMany({
      where: {
        restaurantId: { in: restaurantIds },
        createdAt: { gte: monthStart },
      },
    });

    const activeOrders = await prisma.order.count({
      where: {
        restaurantId: { in: restaurantIds },
        status: { in: ACTIVE_STATUSES },
      },
    });

    const pendingOrders = await prisma.order.count({
      where: {
        restaurantId: { in: restaurantIds },
        status: "PLACED",
      },
    });

    const completedOrdersData = await prisma.order.findMany({
      where: {
        restaurantId: { in: restaurantIds },
        status: { in: FINAL_REVENUE_STATUSES },
      },
    });

    const cancelledOrders = await prisma.order.count({
      where: {
        restaurantId: { in: restaurantIds },
        status: "CANCELLED",
      },
    });

    const recentOrders = await prisma.order.findMany({
      where: {
        restaurantId: { in: restaurantIds },
      },
      include: orderInclude,
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    const totalOrders = restaurants.reduce(
      (sum, r) => sum + r.orders.length,
      0
    );

    const totalMenuItems = restaurants.reduce(
      (sum, r) => sum + r.menuItems.length,
      0
    );

    const todayRevenue = todayOrders
      .filter((o) => FINAL_REVENUE_STATUSES.includes(o.status))
      .reduce((sum, order) => sum + toNumber(order.totalAmount), 0);

    const monthlyRevenue = monthlyOrders
      .filter((o) => FINAL_REVENUE_STATUSES.includes(o.status))
      .reduce((sum, order) => sum + toNumber(order.totalAmount), 0);

    const lifetimeRevenue = completedOrdersData.reduce(
      (sum, order) => sum + toNumber(order.totalAmount),
      0
    );

    const averageOrderValue =
      monthlyOrders.length > 0 ? monthlyRevenue / monthlyOrders.length : 0;

    return res.json({
      success: true,
      data: {
        totalRestaurants: restaurants.length,
        totalOrders,
        totalMenuItems,
        todayOrders: todayOrders.length,
        todayRevenue,
        monthlyOrders: monthlyOrders.length,
        monthlyRevenue,
        lifetimeRevenue,
        revenue: lifetimeRevenue,
        activeOrders,
        pendingOrders,
        completedOrders: completedOrdersData.length,
        cancelledOrders,
        averageOrderValue,
        restaurants,
        restaurantIds,
        recentOrders,
      },
      dashboard: {
        totalRestaurants: restaurants.length,
        totalOrders,
        totalMenuItems,
        revenue: lifetimeRevenue,
        restaurants,
      },
    });
  } catch (error) {
    console.error("Vendor Dashboard Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

/* =========================
   ORDERS
========================= */

export const getVendorOrders = async (req, res) => {
  try {
    const { status, search } = req.query;

    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const where = {
      restaurantId: { in: restaurantIds },
      ...(status && status !== "ALL" && { status }),
    };

    let orders = await prisma.order.findMany({
      where,
      include: orderInclude,
      orderBy: { createdAt: "desc" },
    });

    if (search) {
      const q = String(search).toLowerCase();
      orders = orders.filter((order) => {
        return (
          order.id?.toLowerCase().includes(q) ||
          order.user?.fullName?.toLowerCase().includes(q) ||
          order.user?.phone?.toLowerCase().includes(q) ||
          order.restaurant?.name?.toLowerCase().includes(q)
        );
      });
    }

    return res.json({
      success: true,
      data: orders,
      orders,
    });
  } catch (error) {
    console.error("Vendor Orders Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
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
      include: { restaurant: true },
    });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found for this vendor",
      });
    }

    const updateData = { status };

    if (status === "ACCEPTED_BY_VENDOR") {
      updateData.acceptedAt = new Date();
      updateData.estimatedPreparationMinutes =
        Number(estimatedPreparationMinutes) ||
        existingOrder.estimatedPreparationMinutes ||
        existingOrder.restaurant?.defaultPrepTime ||
        30;
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

    const order = await prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id: finalOrderId },
        data: updateData,
        include: orderInclude,
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: finalOrderId,
          status,
          changedBy: req.user.id,
          note: note || `Vendor updated order to ${status}`,
        },
      });

      return updated;
    });

    emitOrderStatus(finalOrderId, status, { order });
    emitVendorRefreshSafe(req.user.id, { reason: "ORDER_STATUS_UPDATED", order });

    return res.json({
      success: true,
      message: "Order status updated",
      data: order,
      order,
    });
  } catch (error) {
    console.error("Vendor Update Order Status Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
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
    const riders = await prisma.user.findMany({
      where: { role: "RIDER" },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        avatarUrl: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const mappedRiders = riders.map((rider) => ({
      id: rider.id,
      fullName: rider.fullName,
      phone: rider.phone,
      email: rider.email,
      avatarUrl: rider.avatarUrl,
      isAvailable: true,
      currentStatus: "AVAILABLE",
      distanceKm: null,
      distanceText: "Distance unavailable",
    }));

    return res.json({
      success: true,
      data: mappedRiders,
      riders: mappedRiders,
    });
  } catch (error) {
    console.error("Get Available Riders Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
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
      return res.status(400).json({
        success: false,
        message: "Rider can be assigned only after order is ready",
      });
    }

    const rider = await prisma.user.findFirst({
      where: {
        id: riderId,
        role: "RIDER",
      },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        avatarUrl: true,
      },
    });

    if (!rider) {
      return res.status(404).json({
        success: false,
        message: "Rider not found",
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
      console.warn("Vendor rider assigned socket skipped:", error.message);
    }

    emitVendorRefreshSafe(req.user.id, {
      reason: existingOrder.riderId ? "RIDER_REASSIGNED" : "RIDER_ASSIGNED",
      order,
      rider,
    });

    return res.json({
      success: true,
      message: existingOrder.riderId
        ? "Rider reassigned successfully"
        : "Rider assigned successfully",
      data: order,
      order,
    });
  } catch (error) {
    console.error("Assign Vendor Order Rider Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

/* =========================
   MENU
========================= */

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

    await prisma.menuItem.delete({
      where: { id },
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
      message:
        "Unable to delete this item. It may already be linked with orders.",
      error: error.message,
    });
  }
};

/* =========================
   VENDOR CATEGORIES
========================= */

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
    const restaurant = await getPrimaryRestaurant(req.user.id);

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found for this vendor",
      });
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

    const restaurant = id && id !== "me"
      ? await prisma.restaurant.findFirst({
          where: { id, vendorId: req.user.id },
        })
      : await getPrimaryRestaurant(req.user.id);

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found for this vendor",
      });
    }

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
    const restaurant = await getPrimaryRestaurant(req.user.id);

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found for this vendor",
      });
    }

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
    const restaurant = await getPrimaryRestaurant(req.user.id);

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found for this vendor",
      });
    }

    const minutes = Number(req.body.minutes || 30);

    if (!minutes || minutes < 5 || minutes > 180) {
      return res.status(400).json({
        success: false,
        message: "Busy time must be between 5 and 180 minutes",
      });
    }

    const busyUntil = new Date(Date.now() + minutes * 60 * 1000);

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
    });
  } catch (error) {
    console.error("Vendor Busy Mode Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
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

    const settlements = await prisma.vendorSettlement.findMany({
      where: { vendorId },
      include: {
        restaurant: true,
        order: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const pendingAmount = settlements
      .filter((s) => s.status === "PENDING")
      .reduce((sum, s) => sum + toNumber(s.netAmount), 0);

    const paidAmount = settlements
      .filter((s) => s.status === "PAID")
      .reduce((sum, s) => sum + toNumber(s.netAmount), 0);

    const grossEarnings = settlements.reduce(
      (sum, s) => sum + toNumber(s.grossAmount),
      0
    );

    const platformFee = settlements.reduce(
      (sum, s) => sum + toNumber(s.commissionAmount),
      0
    );

    const netPayable = settlements.reduce(
      (sum, s) => sum + toNumber(s.netAmount),
      0
    );

    return res.json({
      success: true,
      data: {
        grossEarnings,
        platformFee,
        netPayable,
        pendingAmount,
        paidAmount,
        settlements,
      },
    });
  } catch (error) {
    console.error("Vendor Payments Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
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
        createdAt: { gte: last7Days },
        status: { in: FINAL_REVENUE_STATUSES },
      },
      select: {
        createdAt: true,
        totalAmount: true,
      },
    });

    const result = [];

    for (let i = 0; i < 7; i++) {
      const date = new Date(last7Days);
      date.setDate(last7Days.getDate() + i);

      const key = date.toISOString().slice(0, 10);

      const total = orders
        .filter((o) => o.createdAt.toISOString().slice(0, 10) === key)
        .reduce((sum, o) => sum + toNumber(o.totalAmount), 0);

      result.push({
        date: key,
        label: date.toLocaleDateString("en-IN", {
          weekday: "short",
        }),
        earnings: total,
        revenue: total,
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
      message: "Something went wrong",
      error: error.message,
    });
  }
};

/* =========================
   NOTIFICATIONS
========================= */

export const getVendorNotifications = async (req, res) => {
  try {
    const restaurantIds = await getVendorRestaurantIds(req.user.id);

    const recentOrders = await prisma.order.findMany({
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
      take: 30,
    });

    const notifications = recentOrders.map((order) => ({
      id: `order-${order.id}`,
      type: "ORDER",
      title:
        order.status === "PLACED"
          ? "New order received"
          : `Order ${order.status.replaceAll("_", " ").toLowerCase()}`,
      message: `Order from ${order.user?.fullName || "Customer"} • ₹${toNumber(
        order.totalAmount
      ).toFixed(2)}`,
      orderId: order.id,
      order,
      isRead: false,
      createdAt: order.createdAt,
    }));

    return res.json({
      success: true,
      data: notifications,
      notifications,
    });
  } catch (error) {
    console.error("Vendor Notifications Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
      error: error.message,
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
};